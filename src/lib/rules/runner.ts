import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { getUserClientConfig, sendToClient } from "@/lib/clients";
import { formatClientError, isClientOfflineError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { acquireRunLock, releaseRunLock } from "@/lib/automation/run-lock";
import type { TorrentSourceId } from "@/lib/torrents/types";

export type RuleRunStatus = "sent" | "failed" | "skipped";

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

function looksOfflineMessage(message: string): boolean {
  return /unreachable|econnrefused|fetch failed|timeout|not listening|cannot reach/i.test(
    message || "",
  );
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

      const result = await searchTorrents({
        query: rule.query,
        category: rule.category as
          | "all"
          | "anime"
          | "movies"
          | "tv"
          | "music"
          | "apps"
          | "games",
        limit: 15,
        sources,
        enrich: false,
        skipCache: true,
        filters: {
          minSeeders: rule.minSeeders,
          maxSizeBytes: rule.maxSizeBytes
            ? Number(rule.maxSizeBytes)
            : undefined,
          resolution: rule.resolution ?? undefined,
          hasMagnet: true,
        },
      });

      const best = result.results[0];
      if (!best?.magnet) {
        await prisma.autoRule.update({
          where: { id: rule.id },
          data: { lastRunAt: new Date() },
        });
        const entry: RuleRunResult = {
          ruleId: rule.id,
          matched: false,
          message: "No matching torrents",
          status: "skipped",
        };
        summary.push(entry);
        await logRuleGrabJob(rule.userId, entry, rule.query);
        continue;
      }

      // Skip if same magnet as last *successful* match
      if (rule.lastMatchMagnet && rule.lastMatchMagnet === best.magnet) {
        await prisma.autoRule.update({
          where: { id: rule.id },
          data: { lastRunAt: new Date() },
        });
        const entry: RuleRunResult = {
          ruleId: rule.id,
          matched: false,
          title: best.title,
          message: "Already sent this release",
          status: "skipped",
          magnet: best.magnet,
          infoHash: best.infoHash ?? null,
          source: best.source,
        };
        summary.push(entry);
        await logRuleGrabJob(rule.userId, entry, rule.query);
        continue;
      }

      const config = await getUserClientConfig(rule.userId);
      if (!config) {
        const entry: RuleRunResult = {
          ruleId: rule.id,
          matched: true,
          title: best.title,
          message: "Match found but no torrent client configured",
          status: "failed",
          magnet: best.magnet,
          infoHash: best.infoHash ?? null,
          source: best.source,
        };
        summary.push(entry);
        await logRuleGrabJob(rule.userId, entry, rule.query);
        continue;
      }

      const target = resolveSmartSendTarget(config, {
        name: best.title,
        source: best.source,
        searchCategory: rule.category,
        metadata: best.metadata,
      });

      let send: { ok: boolean; message: string };
      let offline = false;
      try {
        send = await sendToClient(config, {
          magnet: best.magnet,
          torrentUrl: best.torrentUrl,
          name: best.title,
          category: target.category,
          savePath: target.savePath,
        });
      } catch (err) {
        const formatted = formatClientError(err, config.clientType);
        send = { ok: false, message: formatted.message };
        offline =
          config.clientType !== "builtin" &&
          (formatted.offline || isClientOfflineError(err));
      }

      if (
        config.clientType !== "builtin" &&
        !send.ok &&
        (offline || looksOfflineMessage(send.message))
      ) {
        offline = true;
        offlineUsers.add(rule.userId);
      }

      await prisma.downloadHistory.create({
        data: {
          userId: rule.userId,
          title: best.title,
          magnet: best.magnet,
          torrentUrl: best.torrentUrl,
          infoHash: best.infoHash,
          source: best.source,
          status: send.ok ? "sent" : "failed",
          message: [
            `Auto-rule: ${rule.name}`,
            send.message,
            target.category ? `cat=${target.category}` : null,
            target.savePath ? `path=${target.savePath}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
      });

      // Only lock lastMatchMagnet on successful send so failed grabs retry
      await prisma.autoRule.update({
        where: { id: rule.id },
        data: {
          lastRunAt: new Date(),
          ...(send.ok
            ? {
                lastMatchTitle: best.title,
                lastMatchMagnet: best.magnet,
                matchCount: { increment: 1 },
              }
            : {}),
        },
      });

      const entry: RuleRunResult = {
        ruleId: rule.id,
        matched: true,
        title: best.title,
        message: send.message,
        status: send.ok ? "sent" : "failed",
        offline: offline || undefined,
        magnet: best.magnet,
        infoHash: best.infoHash ?? null,
        source: best.source,
        savePath: target.savePath,
        category: target.category,
      };
      summary.push(entry);
      await logRuleGrabJob(rule.userId, entry, rule.query);
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
