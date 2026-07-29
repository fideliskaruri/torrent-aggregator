import prisma from "@/lib/prisma";
import { SearchThrottledError } from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import { isViable, MIN_VIABLE_SEEDERS } from "@/lib/torrents/quality";
import { runGrabPipeline } from "@/lib/grab/pipeline";
import type { ViabilityDecision, TxClient } from "@/lib/grab/types";

/**
 * How long automation defers a thin-but-present release before grabbing it
 * anyway. Long enough that a genuinely fresh release has found peers, short
 * enough that a niche title is not undownloadable overnight.
 */
const SEEDER_WAIT_GRACE_MS = 6 * 60 * 60 * 1000;
import {
  advanceCursorAfterMiss,
  afterSuccessfulGrab,
  formatEpisodeLabel,
  isHuntDue,
  resolveHuntCursor,
  type ShowCursor,
} from "@/lib/library/cursor";
import { assertStorageBudget } from "@/lib/library/disk-space";
import {
  getUserClientConfig,
  type ClientConnectionConfig,
} from "@/lib/clients";
import { isClientOfflineError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
import { acquireRunLock, releaseRunLock } from "@/lib/automation/run-lock";
import { runAutoRules } from "@/lib/rules/runner";

export type AutomationSummary = {
  rules: {
    ran: number;
    matched: number;
    messages: {
      ruleId: string;
      matched: boolean;
      title?: string;
      message: string;
      status?: string;
    }[];
  };
  library: {
    checked: number;
    sent: number;
    skipped: number;
    failed: number;
    /** Monitored items not hunted this pass because they are in miss backoff. */
    deferred: number;
  };
  offline: boolean;
  message: string;
};

function looksOfflineMessage(message: string): boolean {
  return /unreachable|econnrefused|fetch failed|timeout|not listening|cannot reach/i.test(
    message || "",
  );
}

/**
 * A hunt for the cursor episode found nothing.
 *
 * Counts the miss and, once the season looks finished, rolls the cursor to the
 * next season so a monitored show cannot dead-end forever at the last episode
 * of a season.
 *
 * Non-series items have no cursor and nothing to roll, but they still count
 * misses: an unreleased movie is otherwise hunted on every single pass for the
 * life of the install. The count is what drives hunt backoff, and a successful
 * grab resets it to 0.
 */
async function recordHuntMiss(
  itemId: string,
  cursor: ShowCursor | null,
  misses: number,
): Promise<void> {
  if (!cursor) {
    await prisma.watchListItem.update({
      where: { id: itemId },
      data: {
        lastChecked: new Date(),
        cursorMisses: Math.max(0, Math.trunc(misses) || 0) + 1,
      },
    });
    return;
  }
  const next = advanceCursorAfterMiss(cursor, misses);
  await prisma.watchListItem.update({
    where: { id: itemId },
    data: {
      lastChecked: new Date(),
      cursorMisses: next.misses,
      ...(next.rolledOver
        ? {
            // Cursor moved to a new season — a wait recorded against the old
            // episode must not carry over and instantly expire on the new one.
            seederWaitSince: null,
            cursorSeason: next.cursor.season,
            cursorEpisode: next.cursor.episode,
            nextEpisodeHint: formatEpisodeLabel(
              next.cursor.season,
              next.cursor.episode,
            ),
          }
        : {}),
    },
  });
}

/**
 * Run automation for one user: auto-rules first, then monitored library items.
 * Rule GrabJobs are written inside runAutoRules; library GrabJobs here.
 *
 * Serialized per user by RunLock: two concurrent runs would both read the same
 * stale latestReleaseMagnet and grab the same release twice.
 */
export async function runUserAutomation(userId: string): Promise<AutomationSummary> {
  const lockId = await acquireRunLock(userId, "automation");
  if (!lockId) {
    return {
      rules: { ran: 0, matched: 0, messages: [] },
      library: { checked: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 },
      offline: false,
      message: "Automation is already running — ignored this request",
    };
  }
  try {
    return await runUserAutomationUnlocked(userId);
  } finally {
    await releaseRunLock(lockId);
  }
}

async function runUserAutomationUnlocked(
  userId: string,
): Promise<AutomationSummary> {
  const ruleResults = await runAutoRules(userId);
  const rulesMatched = ruleResults.filter((r) => r.matched).length;
  const rulesOffline = ruleResults.some((r) => r.offline);

  const summary: AutomationSummary = {
    rules: {
      ran: ruleResults.length,
      matched: rulesMatched,
      messages: ruleResults.map((r) => ({
        ruleId: r.ruleId,
        matched: r.matched,
        title: r.title,
        message: r.message,
        status: r.status,
      })),
    },
    library: {
      checked: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
    },
    offline: rulesOffline,
    message: "",
  };

  // If rules already hit a dead client, still scan library for skips/no-match
  // but skip send attempts when offline.
  const items = await prisma.watchListItem.findMany({
    where: {
      userId,
      monitored: true,
      status: { in: ["watching", "planned"] },
    },
    // Least-recently-checked first. The background indexer budget can run out
    // mid-pass, and in a fixed order the same tail items would be starved every
    // single pass; this way the queue rotates on its own.
    orderBy: { lastChecked: "asc" },
  });

  let config: ClientConnectionConfig | null = null;
  try {
    config = await getUserClientConfig(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.offline = true;
    summary.message = `Could not load client settings: ${message}`;
    // Still record failed grabs for visibility
    for (const item of items) {
      summary.library.checked += 1;
      summary.library.failed += 1;
      await prisma.grabJob.create({
        data: {
          userId,
          title: item.title,
          query: resolveHuntCursor(item).query,
          status: "failed",
          message: summary.message,
          kind: "library",
          externalId: item.id,
        },
      });
    }
    const parts = [
      `Rules: ${summary.rules.ran} ran, ${summary.rules.matched} matched`,
      `Library: ${summary.library.checked} checked, 0 sent, 0 skipped, ${summary.library.failed} failed`,
      "Client settings unavailable",
    ];
    summary.message = parts.join(". ");
    return summary;
  }

  for (const item of items) {
    // An item that has missed repeatedly is not re-hunted every pass. Without
    // this, a cursor that can never advance (see huntBackoffMs) burns one
    // indexer request per item per scheduler tick, forever.
    if (!isHuntDue(item.cursorMisses, item.lastChecked)) {
      summary.library.deferred += 1;
      continue;
    }
    summary.library.checked += 1;
    // Library aggregator: hunt Title SxxEyy from cursor, not bare show name
    const hunt = resolveHuntCursor(item);
    const query = hunt.query;
    const huntCursor = hunt.cursor;
    // Unknown media type falls back to "all": a library row can be a film as
    // well as a series, so narrowing to one category would hide the other.
    const searchCategory = searchCategoryForMediaType(item.mediaType) ?? "all";

    // Client already known offline from rules — fail fast without hammering
    if (summary.offline) {
      await prisma.grabJob.create({
        data: {
          userId,
          title: item.title,
          query,
          status: "failed",
          message:
            "Torrent client offline — skipped send (detected earlier in this run)",
          kind: "library",
          externalId: item.id,
        },
      });
      summary.library.failed += 1;
      await prisma.watchListItem.update({
        where: { id: item.id },
        data: { lastChecked: new Date() },
      });
      continue;
    }

    if (!config) {
      await prisma.grabJob.create({
        data: {
          userId,
          title: item.title,
          query,
          status: "failed",
          message: "No torrent client configured",
          kind: "library",
          externalId: item.id,
        },
      });
      summary.library.failed += 1;
      continue;
    }

    try {
      const pipelineResult = await runGrabPipeline({
        userId,
        // Automation auto-acquires watchlisted content the user asked to keep.
        purpose: "keep",
        search: {
          query,
          category: searchCategory,
          limit: 15,
          enrich: false,
          background: true,
          skipCache: true,
          filters: {
            hasMagnet: true,
            // Deliberately NO minSeeders. A brand-new episode routinely sits
            // at 0 seeders for its first minutes — dropping it here records a
            // hunt miss, and three of those roll the cursor to the next season
            // and skip episodes forever. The viability gate below owns the
            // whole thin/dead decision.
            ...(huntCursor
              ? { season: huntCursor.season, episode: huntCursor.episode }
              : {}),
          },
        },
        config,
        fallbackTitle: item.title,
        grabJobKind: "library",
        externalId: item.id,
        noMatchMessage: huntCursor
          ? (count) =>
              count
                ? `No matching ${formatEpisodeLabel(huntCursor.season, huntCursor.episode)} release (won't grab a different episode)`
                : `No matching ${formatEpisodeLabel(huntCursor.season, huntCursor.episode)} release`
          : (count) =>
              count
                ? `No matching release in ${count} results`
                : "No matching torrents",

        // ── Candidate selection ──────────────────────────────────────────
        // With a cursor, only the exact episode matches. Without, first is fine.
        selectCandidate(results) {
          const withMagnet = results.filter((t) => t.magnet);
          if (!huntCursor) return withMagnet[0] ?? null;
          return (
            withMagnet.find((t) => {
              const ep = parseEpisode(t.title);
              return (
                ep.season === huntCursor.season &&
                ep.episode === huntCursor.episode
              );
            }) ?? null
          );
        },

        // ── Duplicate detection ──────────────────────────────────────────
        // Dedupe BEFORE the viability gate — a release already sent that has
        // since lost peers is "grabbed, downloading", not "waiting for seeders".
        async checkDuplicate(candidate) {
          if (
            item.latestReleaseMagnet &&
            item.latestReleaseMagnet === candidate.magnet
          ) {
            await prisma.watchListItem.update({
              where: { id: item.id },
              data: { lastChecked: new Date() },
            });
            return "Already sent this release";
          }
          // Second dedupe: keyed on what the client still holds, not history.
          // A release the user deleted *should* be grabbable again.
          if (candidate.infoHash) {
            const held = await prisma.engineTorrent.findFirst({
              where: {
                userId,
                hash: candidate.infoHash.toLowerCase(),
                status: { not: "removed" },
              },
              select: { id: true },
            });
            if (held) {
              await prisma.watchListItem.update({
                where: { id: item.id },
                data: { lastChecked: new Date() },
              });
              return "Already in the client";
            }
          }
          return null;
        },

        // ── Viability gate with 6h escape hatch ─────────────────────────
        async checkViability(candidate): Promise<ViabilityDecision> {
          if (isViable(candidate)) return { proceed: true };
          const waitingSince = item.seederWaitSince ?? new Date();
          const waitedMs = Date.now() - waitingSince.getTime();
          if (waitedMs >= SEEDER_WAIT_GRACE_MS) {
            // Grace window elapsed — grab the thin release.
            return { proceed: true };
          }
          const hoursLeft = Math.max(
            1,
            Math.round((SEEDER_WAIT_GRACE_MS - waitedMs) / 3_600_000),
          );
          await prisma.watchListItem.update({
            where: { id: item.id },
            data: { lastChecked: new Date(), seederWaitSince: waitingSince },
          });
          return {
            proceed: false,
            deferred: true,
            message: `Waiting for seeders (${candidate.seeders ?? 0} of ${MIN_VIABLE_SEEDERS}) — grabbing anyway in ~${hoursLeft}h if no peers arrive`,
          };
        },

        // ── Storage budget ───────────────────────────────────────────────
        async checkStorageBudget(candidate, target) {
          const root =
            config.baseDownloadPath?.trim() ||
            target.savePath ||
            config.savePath?.trim() ||
            process.cwd();
          const space = await assertStorageBudget({
            root,
            maxStorageBytes: config.maxStorageBytes,
            incomingBytes: candidate.sizeBytes ?? null,
          });
          if (!space.ok) {
            await prisma.watchListItem.update({
              where: { id: item.id },
              data: { lastChecked: new Date() },
            });
            return { ok: false as const, message: space.message };
          }
          return { ok: true as const };
        },

        // ── Path resolution ──────────────────────────────────────────────
        resolveTarget(cfg, candidate) {
          const t = resolveSmartSendTarget(cfg, {
            name: candidate.title,
            source: candidate.source,
            searchCategory,
            // The watchlist row is a catalog record — passing it stops
            // S02E05 numbering from demoting a monitored anime to TV.
            metadata: catalogMetadata(item),
          });
          return { category: t.category, savePath: t.savePath };
        },

        // ── Post-send: advance cursor on success ─────────────────────────
        async onSuccess(tx, candidate, _target, _sendMessage) {
          const advanced = afterSuccessfulGrab(
            item.title,
            huntCursor,
            candidate.title,
          );
          await tx.watchListItem.update({
            where: { id: item.id },
            data: {
              lastChecked: new Date(),
              latestReleaseTitle: candidate.title,
              latestReleaseAt: candidate.publishedAt
                ? new Date(candidate.publishedAt)
                : new Date(),
              latestReleaseMagnet: candidate.magnet,
              lastEpisode: advanced.lastEpisode,
              cursorSeason: advanced.cursorSeason,
              cursorEpisode: advanced.cursorEpisode,
              cursorMisses: 0,
              // Cursor moved on — thin-swarm wait must not leak to the next ep.
              seederWaitSince: null,
              nextEpisodeHint: advanced.nextEpisodeHint,
              ...(item.fromSeason == null && huntCursor
                ? {
                    fromSeason: huntCursor.season,
                    fromEpisode: huntCursor.episode,
                  }
                : {}),
            },
          });
        },

        // ── Post-send: record failure, detect offline ────────────────────
        async onFailure(tx, _candidate, _target, _sendMessage, offline) {
          if (offline) summary.offline = true;
          await tx.watchListItem.update({
            where: { id: item.id },
            data: { lastChecked: new Date() },
          });
        },

        // ── No candidate: record miss / deferred / duplicate ────────────
        async onNoCandidate(reason, _message, candidate) {
          if (reason === "no_results" || reason === "no_match") {
            await recordHuntMiss(item.id, huntCursor, item.cursorMisses);
            return;
          }

          // A duplicate at the cursor episode is success-by-other-means: the
          // episode is already held (manual grab, auto-rule, prior crash retry,
          // etc.). Leaving the cursor pinned here would freeze the show
          // permanently — every subsequent run re-detects the same duplicate,
          // the cursor never advances, and no error surfaces.
          if (reason === "duplicate" && candidate && huntCursor) {
            const ep = parseEpisode(candidate.title);
            if (
              ep.season === huntCursor.season &&
              ep.episode === huntCursor.episode
            ) {
              const advanced = afterSuccessfulGrab(
                item.title,
                huntCursor,
                candidate.title,
              );
              await prisma.watchListItem.update({
                where: { id: item.id },
                data: {
                  lastChecked: new Date(),
                  latestReleaseTitle: candidate.title,
                  latestReleaseAt: new Date(),
                  // Deliberately NOT setting latestReleaseMagnet: we didn't
                  // send this — it arrived by another route. The field means
                  // "last magnet automation sent" and feeds the first dedupe
                  // branch; claiming we sent something we didn't is
                  // semantically wrong, and the EngineTorrent branch already
                  // covers re-detection of held torrents.
                  lastEpisode: advanced.lastEpisode,
                  cursorSeason: advanced.cursorSeason,
                  cursorEpisode: advanced.cursorEpisode,
                  cursorMisses: 0,
                  seederWaitSince: null,
                  nextEpisodeHint: advanced.nextEpisodeHint,
                  ...(item.fromSeason == null
                    ? {
                        fromSeason: huntCursor.season,
                        fromEpisode: huntCursor.episode,
                      }
                    : {}),
                },
              });
            }
          }
          // "deferred" → episode exists but thin swarm, wait for seeders.
          // "duplicate" off-cursor → held episode is not the one we're hunting.
        },
      });

      if (pipelineResult.status === "sent") {
        summary.library.sent += 1;
      } else if (pipelineResult.status === "already_active") {
        // Already grabbed moments ago (double run, manual grab racing
        // automation). Not a send, not a failure — a no-op we already have.
        summary.library.skipped += 1;
      } else if (pipelineResult.status === "failed") {
        summary.library.failed += 1;
        if (pipelineResult.offline) summary.offline = true;
      } else {
        summary.library.skipped += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Running out of indexer budget is not a failure — it is this pass
      // deciding to wait.
      if (err instanceof SearchThrottledError) {
        summary.library.checked -= 1;
        summary.library.deferred += 1;
        continue;
      }

      if (isClientOfflineError(err) || looksOfflineMessage(message)) {
        summary.offline = true;
      }

      await prisma.grabJob.create({
        data: {
          userId,
          title: item.title,
          query,
          status: "failed",
          message,
          kind: "library",
          externalId: item.id,
        },
      });
      summary.library.failed += 1;
    }
  }

  const parts: string[] = [];
  parts.push(
    `Rules: ${summary.rules.ran} ran, ${summary.rules.matched} matched`,
  );
  parts.push(
    `Library: ${summary.library.checked} checked, ${summary.library.sent} sent, ${summary.library.skipped} skipped, ${summary.library.failed} failed` +
      (summary.library.deferred > 0
        ? `, ${summary.library.deferred} waiting (repeated misses)`
        : ""),
  );
  if (summary.offline) {
    parts.push(
      "Client appears offline — further send attempts were skipped with clear failures",
    );
  }
  summary.message = parts.join(". ");

  return summary;
}
