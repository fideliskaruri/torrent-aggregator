import prisma from "@/lib/prisma";
import {
  searchTorrents,
  SearchThrottledError,
} from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import { isViable, MIN_VIABLE_SEEDERS } from "@/lib/torrents/quality";

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
  sendToClient,
  type ClientConnectionConfig,
} from "@/lib/clients";
import { formatClientError, isClientOfflineError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { catalogMetadata } from "@/lib/metadata/catalog-identity";
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

function categoryForMediaType(mediaType: string): "anime" | "movies" | "tv" | "all" {
  if (mediaType === "anime") return "anime";
  if (mediaType === "movie") return "movies";
  if (mediaType === "tv") return "tv";
  return "all";
}

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
    const searchCategory = categoryForMediaType(item.mediaType);

    try {
      const result = await searchTorrents({
        query,
        category: searchCategory,
        limit: 15,
        enrich: false,
        skipCache: true,
        // Scheduled work, not a person waiting: use the background indexer budget.
        background: true,
        filters: {
          hasMagnet: true,
          // Deliberately NOT `minSeeders: 1`. A brand-new episode routinely
          // sits at 0 seeders for its first minutes, and dropping it here made
          // `best` undefined, which recorded a *hunt miss* — three of which
          // roll the cursor to the next season and skip episodes forever. The
          // single viability gate below owns the whole thin/dead decision so
          // "not seeded yet" can never be mistaken for "does not exist".
          ...(huntCursor
            ? { season: huntCursor.season, episode: huntCursor.episode }
            : {}),
        },
      });

      // Prefer exact SxxEyy match. When hunting a cursor, never grab a random ep.
      const withMagnet = result.results.filter((t) => t.magnet);
      const best =
        huntCursor
          ? withMagnet.find((t) => {
              const ep = parseEpisode(t.title);
              return (
                ep.season === huntCursor.season &&
                ep.episode === huntCursor.episode
              );
            })
          : withMagnet[0];

      if (!best?.magnet && huntCursor) {
        await prisma.grabJob.create({
          data: {
            userId,
            title: item.title,
            query,
            status: "skipped",
            message: `No matching ${formatEpisodeLabel(huntCursor.season, huntCursor.episode)} release (won't grab a different episode)`,
            kind: "library",
            externalId: item.id,
          },
        });
        summary.library.skipped += 1;
        await recordHuntMiss(item.id, huntCursor, item.cursorMisses);
        continue;
      }

      if (!best?.magnet) {
        await prisma.grabJob.create({
          data: {
            userId,
            title: item.title,
            query,
            status: "skipped",
            message: "No torrents with seeders found",
            kind: "library",
            externalId: item.id,
          },
        });
        summary.library.skipped += 1;
        await recordHuntMiss(item.id, huntCursor, item.cursorMisses);
        continue;
      }

      // Dedupe BEFORE the viability gate. A release that was already sent and
      // has since lost peers is "grabbed, downloading" — not "waiting for
      // seeders". Gating first would log a misleading skip row every single
      // run for a torrent the client is already working on.
      if (
        item.latestReleaseMagnet &&
        item.latestReleaseMagnet === best.magnet
      ) {
        await prisma.grabJob.create({
          data: {
            userId,
            title: best.title,
            query,
            status: "skipped",
            message: "Already sent this release",
            magnet: best.magnet,
            infoHash: best.infoHash ?? null,
            source: best.source,
            kind: "library",
            externalId: item.id,
          },
        });
        summary.library.skipped += 1;
        await prisma.watchListItem.update({
          where: { id: item.id },
          data: { lastChecked: new Date() },
        });
        continue;
      }

      // Second dedupe, on content identity rather than on this item's last
      // send. `latestReleaseMagnet` only remembers the most recent grab, so a
      // release picked up again later — after a cursor rewind, or the same
      // episode reappearing on another indexer under a different magnet
      // string — was re-sent and downloaded a second time. That is where the
      // duplicate release folders in the library came from: the second copy
      // collides with the first, so it has to keep its release folder.
      //
      // Keyed on what the client still holds, not on history: a release the
      // user has since deleted *should* be grabbable again.
      if (best.infoHash) {
        const held = await prisma.engineTorrent.findFirst({
          where: {
            userId,
            hash: best.infoHash.toLowerCase(),
            status: { not: "removed" },
          },
          select: { id: true },
        });
        if (held) {
          await prisma.grabJob.create({
            data: {
              userId,
              title: best.title,
              query,
              status: "skipped",
              message: "Already in the client",
              magnet: best.magnet,
              infoHash: best.infoHash,
              source: best.source,
              kind: "library",
              externalId: item.id,
            },
          });
          summary.library.skipped += 1;
          await prisma.watchListItem.update({
            where: { id: item.id },
            data: { lastChecked: new Date() },
          });
          continue;
        }
      }

      if (!isViable(best)) {
        // A swarm this thin will sit at 0% indefinitely. There is no stall
        // detector or blocklist in this app, so a dead grab is never retried —
        // it just occupies the slot while `latestReleaseMagnet` reports
        // "Already sent this release" forever.
        //
        // Crucially this is NOT recorded as a hunt miss. A miss means "this
        // episode does not exist", and three of them roll the cursor to the
        // next season, permanently skipping episodes. Here the episode plainly
        // does exist — it is just not seeded yet, which is the normal state of
        // a release in its first minutes. Holding the cursor means the next run
        // picks it up once peers arrive.
        //
        // But waiting must not be forever: "thin ⇒ dead" is a heuristic, and a
        // stable 2-seeder swarm does complete. After the grace window we take
        // what we can get, so a niche title is never permanently undownloadable.
        const waitingSince = item.seederWaitSince ?? new Date();
        const waitedMs = Date.now() - waitingSince.getTime();

        if (waitedMs < SEEDER_WAIT_GRACE_MS) {
          const hoursLeft = Math.max(
            1,
            Math.round((SEEDER_WAIT_GRACE_MS - waitedMs) / 3_600_000),
          );
          await prisma.grabJob.create({
            data: {
              userId,
              title: best.title,
              query,
              status: "skipped",
              message: `Waiting for seeders (${best.seeders ?? 0} of ${MIN_VIABLE_SEEDERS}) — grabbing anyway in ~${hoursLeft}h if no peers arrive`,
              magnet: best.magnet,
              infoHash: best.infoHash ?? null,
              source: best.source,
              kind: "library",
              externalId: item.id,
            },
          });
          summary.library.skipped += 1;
          await prisma.watchListItem.update({
            where: { id: item.id },
            data: {
              lastChecked: new Date(),
              seederWaitSince: waitingSince,
            },
          });
          continue;
        }
        // Grace window elapsed — fall through and grab the thin release.
      }

      if (!config) {
        await prisma.grabJob.create({
          data: {
            userId,
            title: best.title,
            query,
            status: "failed",
            message: "No torrent client configured",
            magnet: best.magnet,
            infoHash: best.infoHash ?? null,
            source: best.source,
            kind: "library",
            externalId: item.id,
          },
        });
        summary.library.failed += 1;
        continue;
      }

      // Client already known offline from rules — fail fast without hammering
      if (summary.offline) {
        await prisma.grabJob.create({
          data: {
            userId,
            title: best.title,
            query,
            status: "failed",
            message:
              "Torrent client offline — skipped send (detected earlier in this run)",
            magnet: best.magnet,
            infoHash: best.infoHash ?? null,
            source: best.source,
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

      const target = resolveSmartSendTarget(config, {
        name: best.title,
        source: best.source,
        searchCategory,
        // The watchlist row is a catalog record, not a parse of a release
        // name — passing it stops `S02E05` numbering from demoting a
        // monitored anime to TV, and names the show folder canonically.
        metadata: catalogMetadata(item),
      });

      // Automatic storage cap + free-space floor (no manual check)
      {
        const root =
          config.baseDownloadPath?.trim() ||
          target.savePath ||
          config.savePath?.trim() ||
          process.cwd();
        const space = await assertStorageBudget({
          root,
          maxStorageBytes: config.maxStorageBytes,
          incomingBytes: best.sizeBytes ?? null,
        });
        if (!space.ok) {
          await prisma.grabJob.create({
            data: {
              userId,
              title: best.title,
              query,
              status: "failed",
              message: space.message,
              magnet: best.magnet,
              infoHash: best.infoHash ?? null,
              source: best.source,
              savePath: target.savePath,
              category: target.category,
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
      }

      let send: { ok: boolean; message: string };
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
        // Built-in never goes "offline" via host:port
        if (
          config.clientType !== "builtin" &&
          (formatted.offline || isClientOfflineError(err))
        ) {
          summary.offline = true;
        }
      }

      if (
        config.clientType !== "builtin" &&
        !send.ok &&
        looksOfflineMessage(send.message)
      ) {
        summary.offline = true;
      }

      await prisma.grabJob.create({
        data: {
          userId,
          title: best.title,
          query,
          status: send.ok ? "sent" : "failed",
          message: send.message,
          magnet: best.magnet,
          infoHash: best.infoHash ?? null,
          source: best.source,
          savePath: target.savePath,
          category: target.category,
          kind: "library",
          externalId: item.id,
        },
      });

      await prisma.downloadHistory.create({
        data: {
          userId,
          title: best.title,
          magnet: best.magnet,
          torrentUrl: best.torrentUrl,
          infoHash: best.infoHash,
          source: best.source,
          status: send.ok ? "sent" : "failed",
          message: [
            `Library automation`,
            send.message,
            target.category ? `cat=${target.category}` : null,
            target.savePath ? `path=${target.savePath}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
      });

      if (send.ok) {
        summary.library.sent += 1;
        const advanced = afterSuccessfulGrab(
          item.title,
          huntCursor,
          best.title,
        );
        await prisma.watchListItem.update({
          where: { id: item.id },
          data: {
            lastChecked: new Date(),
            latestReleaseTitle: best.title,
            latestReleaseAt: best.publishedAt
              ? new Date(best.publishedAt)
              : new Date(),
            latestReleaseMagnet: best.magnet,
            lastEpisode: advanced.lastEpisode,
            cursorSeason: advanced.cursorSeason,
            cursorEpisode: advanced.cursorEpisode,
            cursorMisses: 0,
            // The cursor moved on, so any thin-swarm wait belonged to the
            // episode we just grabbed and must not leak into the next one.
            seederWaitSince: null,
            nextEpisodeHint: advanced.nextEpisodeHint,
            // Seed fromSeason if user never set it (legacy items)
            ...(item.fromSeason == null && huntCursor
              ? {
                  fromSeason: huntCursor.season,
                  fromEpisode: huntCursor.episode,
                }
              : {}),
          },
        });
      } else {
        summary.library.failed += 1;
        await prisma.watchListItem.update({
          where: { id: item.id },
          data: { lastChecked: new Date() },
        });
        // Stop hammering a dead client for remaining send attempts
        if (summary.offline) {
          // Mark remaining items as failed-offline without search/send
          // (handled via summary.offline branch above on next iterations)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Running out of indexer budget is not a failure — it is this pass
      // deciding to wait. Recording it as one would write a "failed" grab row
      // per over-budget item per tick forever, and make a healthy 3am run read
      // as a broken client.
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
