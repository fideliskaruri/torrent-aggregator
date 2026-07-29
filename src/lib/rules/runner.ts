import prisma from "@/lib/prisma";
import { getUserClientConfig } from "@/lib/clients";
import { isClientOfflineError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { detectContentKind } from "@/lib/download/smart-category";
import { acquireRunLock, releaseRunLock } from "@/lib/automation/run-lock";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import type { TorrentSourceId, TorrentResult } from "@/lib/torrents/types";

export type RuleRunStatus = "sent" | "failed" | "skipped" | "already_active";

export type RuleRunResult = {
  ruleId: string;
  matched: boolean;
  title?: string;
  message: string;
  status: RuleRunStatus;
  offline?: boolean;
  magnet?: string | null;
  infoHash?: string | null;
  source?: string | null;
  savePath?: string | null;
  category?: string | null;
};

/**
 * Content kinds a rule of a given category may legitimately grab.
 *
 * An indexer's own category filter is a request, not a guarantee: a rule named
 * "Weekly anime, 1080p" grabbed *Silo* (live-action drama) and a "4K movies"
 * rule grabbed a TV episode, because the runner took `results[0]` on trust.
 * A rule is unattended and writes to disk, so it has to check.
 *
 * `tv` accepts anime because an anime episode arriving through a TV rule is a
 * reasonable reading of the request. `anime` and `movies` are strict: those are
 * the two the user pins down deliberately, and the two that went wrong.
 */
const RULE_KINDS: Record<string, string[]> = {
  anime: ["anime"],
  movies: ["movies"],
  tv: ["tv", "anime"],
  music: ["music"],
  games: ["games"],
  apps: ["software"],
};

export function matchesRuleCategory(
  result: Pick<TorrentResult, "title" | "source"> & {
    tags?: string[] | null;
    metadata?: TorrentResult["metadata"];
  },
  ruleCategory: string | null | undefined,
): boolean {
  const allowed = RULE_KINDS[(ruleCategory ?? "").toLowerCase()];
  if (!allowed) return true; // "all", or a category with no meaningful kind
  const kind = detectContentKind({
    title: result.title,
    tags: result.tags ?? undefined,
    metadata: result.metadata,
    // Deliberately withheld: passing the rule's own category as a hint would
    // make this check answer with the question.
    searchCategory: null,
    source: result.source,
  });
  return allowed.includes(kind);
}

/**
 * Persist a GrabJob so Activity always reflects rule hunts
 * (whether run from Library automation or Rules "Run now").
 */
async function logRuleGrabJob(
  userId: string,
  result: RuleRunResult,
  query: string,
): Promise<void> {
  try {
    await prisma.grabJob.create({
      data: {
        userId,
        title: result.title || "Auto-rule",
        query,
        status: result.status,
        message: result.message,
        magnet: result.magnet ?? null,
        infoHash: result.infoHash ?? null,
        source: result.source ?? null,
        savePath: result.savePath ?? null,
        category: result.category ?? null,
        kind: "rule",
        externalId: result.ruleId,
      },
    });
  } catch (err) {
    console.warn("[rules] GrabJob create failed", err);
  }
}

/**
 * Run all enabled auto-download rules for a user (or all users if omitted).
 * Writes GrabJobs, uses smart category/path, and does not mark a release
 * as matched when the client send fails (so the next run can retry).
 */
export async function runAutoRules(userId?: string): Promise<RuleRunResult[]> {
  // Serialize per user so overlapping runs cannot both grab the same release.
  const lockId = userId ? await acquireRunLock(userId, "rules") : null;
  if (userId && !lockId) return [];
  try {
    return await runAutoRulesUnlocked(userId);
  } finally {
    await releaseRunLock(lockId);
  }
}

async function runAutoRulesUnlocked(userId?: string): Promise<RuleRunResult[]> {
  const rules = await prisma.autoRule.findMany({
    where: {
      enabled: true,
      ...(userId ? { userId } : {}),
    },
  });

  const summary: RuleRunResult[] = [];
  /** Per-user offline flag so we stop hammering a dead external client. */
  const offlineUsers = new Set<string>();

  for (const rule of rules) {
    if (offlineUsers.has(rule.userId)) {
      const skipped: RuleRunResult = {
        ruleId: rule.id,
        matched: false,
        message: "Skipped — torrent client offline from earlier rule",
        status: "skipped",
        offline: true,
      };
      summary.push(skipped);
      await logRuleGrabJob(rule.userId, skipped, rule.query);
      continue;
    }

    try {
      const sources = rule.sources
        ? (rule.sources
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as TorrentSourceId[])
        : undefined;

      const config = await getUserClientConfig(rule.userId);
      if (!config) {
        const entry: RuleRunResult = {
          ruleId: rule.id,
          matched: false,
          message: "Match found but no torrent client configured",
          status: "failed",
        };
        summary.push(entry);
        await logRuleGrabJob(rule.userId, entry, rule.query);
        continue;
      }

      const ruleCategory = rule.category as
        | "all"
        | "anime"
        | "movies"
        | "tv"
        | "music"
        | "apps"
        | "games";

      const pipelineResult = await runGrabPipeline({
        userId: rule.userId,
        // A matched download rule is an explicit standing instruction to keep.
        purpose: "keep",
        search: {
          query: rule.query,
          category: ruleCategory,
          limit: 15,
          sources,
          // Metadata is what separates an anime episode from a live-action one
          // when both are SxxEyy on the same indexer, and matchesRuleCategory
          // depends on it. A scheduled run can afford the lookup.
          enrich: true,
          skipCache: true,
          background: true,
          filters: {
            minSeeders: rule.minSeeders,
            maxSizeBytes: rule.maxSizeBytes
              ? Number(rule.maxSizeBytes)
              : undefined,
            resolution: rule.resolution ?? undefined,
            hasMagnet: true,
          },
        },
        config,
        fallbackTitle: rule.query,
        grabJobKind: "rule",
        externalId: rule.id,
        downloadHistoryPrefix: `Auto-rule: ${rule.name}`,
        noMatchMessage: (count) =>
          count
            ? `No ${rule.category ?? "matching"} releases in ${count} results`
            : "No matching torrents",

        // ── Candidate selection with category guard ──────────────────────
        selectCandidate(results) {
          return (
            results.find(
              (r) => r.magnet && matchesRuleCategory(r, rule.category),
            ) ?? null
          );
        },

        // ── Dedupe on last successful match magnet ───────────────────────
        async checkDuplicate(candidate) {
          if (rule.lastMatchMagnet && rule.lastMatchMagnet === candidate.magnet) {
            return "Already sent this release";
          }
          return null;
        },

        // ── Path resolution ──────────────────────────────────────────────
        resolveTarget(cfg, candidate) {
          const t = resolveSmartSendTarget(cfg, {
            name: candidate.title,
            source: candidate.source,
            searchCategory: rule.category,
            metadata: candidate.metadata,
          });
          return { category: t.category, savePath: t.savePath };
        },

        // ── Post-send: lock lastMatchMagnet on success ───────────────────
        async onSuccess(tx, candidate, target, sendMessage) {
          await tx.autoRule.update({
            where: { id: rule.id },
            data: {
              lastRunAt: new Date(),
              lastMatchTitle: candidate.title,
              lastMatchMagnet: candidate.magnet,
              matchCount: { increment: 1 },
            },
          });
        },

        // ── Post-send failure: update lastRunAt but NOT lastMatchMagnet ──
        async onFailure(tx, candidate, target, sendMessage, offline) {
          await tx.autoRule.update({
            where: { id: rule.id },
            data: { lastRunAt: new Date() },
          });
          if (offline) offlineUsers.add(rule.userId);
        },

        // ── No candidate: update lastRunAt ───────────────────────────────
        async onNoCandidate(reason, message, candidate) {
          await prisma.autoRule.update({
            where: { id: rule.id },
            data: { lastRunAt: new Date() },
          });
        },
      });

      const entry: RuleRunResult = {
        ruleId: rule.id,
        // "already_active" counts as matched: the rule DID find its release,
        // it is simply already downloading from a grab moments earlier.
        matched:
          pipelineResult.status === "sent" ||
          pipelineResult.status === "failed" ||
          pipelineResult.status === "already_active",
        title: pipelineResult.candidate?.title,
        message: pipelineResult.message,
        status: pipelineResult.status,
        offline: pipelineResult.offline || undefined,
        magnet: pipelineResult.candidate?.magnet ?? null,
        infoHash: pipelineResult.candidate?.infoHash ?? null,
        source: pipelineResult.candidate?.source ?? null,
        savePath: pipelineResult.target?.savePath,
        category: pipelineResult.target?.category,
      };
      summary.push(entry);
      // GrabJob already written by pipeline; logRuleGrabJob is not needed here.
    } catch (err) {
      const offline = isClientOfflineError(err);
      if (offline) offlineUsers.add(rule.userId);
      const entry: RuleRunResult = {
        ruleId: rule.id,
        matched: false,
        message: err instanceof Error ? err.message : String(err),
        status: "failed",
        offline: offline || undefined,
      };
      summary.push(entry);
      await logRuleGrabJob(rule.userId, entry, rule.query);
    }
  }

  return summary;
}
