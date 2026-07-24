import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import {
  afterSuccessfulGrab,
  formatEpisodeLabel,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { assertStorageBudget } from "@/lib/library/disk-space";
import {
  getUserClientConfig,
  sendToClient,
  type ClientConnectionConfig,
} from "@/lib/clients";
import { formatClientError, isClientOfflineError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
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
 * Run automation for one user: auto-rules first, then monitored library items.
 * Rule GrabJobs are written inside runAutoRules; library GrabJobs here.
 */
export async function runUserAutomation(userId: string): Promise<AutomationSummary> {
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
    orderBy: { updatedAt: "desc" },
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
        filters: {
          hasMagnet: true,
          minSeeders: 1,
          ...(huntCursor
            ? { season: huntCursor.season, episode: huntCursor.episode }
            : {}),
        },
      });

      // Prefer exact SxxEyy match. When hunting a cursor, never grab a random ep.
      const withMagnet = result.results.filter(
        (t) => t.magnet && (t.seeders ?? 0) > 0,
      );
      let best =
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
        await prisma.watchListItem.update({
          where: { id: item.id },
          data: { lastChecked: new Date() },
        });
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
        await prisma.watchListItem.update({
          where: { id: item.id },
          data: { lastChecked: new Date() },
        });
        continue;
      }

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
    `Library: ${summary.library.checked} checked, ${summary.library.sent} sent, ${summary.library.skipped} skipped, ${summary.library.failed} failed`,
  );
  if (summary.offline) {
    parts.push(
      "Client appears offline — further send attempts were skipped with clear failures",
    );
  }
  summary.message = parts.join(". ");

  return summary;
}
