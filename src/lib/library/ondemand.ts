/**
 * On-demand single-episode grab.
 * - Rewatch / off-cursor episode: does NOT move the hunt cursor.
 * - Grab of the current hunt target (next SxxEyy): advances cursor like automation.
 */
import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import {
  afterSuccessfulGrab,
  episodeSearchQuery,
  formatEpisodeLabel,
  resolveHuntCursor,
} from "@/lib/library/cursor";
import { assertStorageBudget } from "@/lib/library/disk-space";
import {
  getUserClientConfig,
  sendToClient,
} from "@/lib/clients";
import { formatClientError } from "@/lib/clients/errors";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";

export type OnDemandResult = {
  ok: boolean;
  message: string;
  query: string;
  title?: string;
  savePath?: string | null;
  magnet?: string | null;
  /** True when grab matched hunt cursor and cursor was advanced */
  advanced?: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
};

/**
 * After a successful send: if the grabbed SxxEyy is the library item's hunt
 * cursor, advance last/next/cursor (same as automation). Off-cursor rewatch
 * leaves the cursor alone.
 */
export async function advanceLibraryItemIfHuntMatch(opts: {
  userId: string;
  watchListItemId: string;
  grabSeason: number;
  grabEpisode: number;
  grabbedTitle: string;
}): Promise<{
  advanced: boolean;
  lastEpisode?: string;
  cursorSeason?: number;
  cursorEpisode?: number;
  nextEpisodeHint?: string;
}> {
  const item = await prisma.watchListItem.findFirst({
    where: { id: opts.watchListItemId, userId: opts.userId },
  });
  if (!item) {
    return { advanced: false };
  }

  const hunt = resolveHuntCursor({
    title: item.title,
    mediaType: item.mediaType,
    cursorSeason: item.cursorSeason,
    cursorEpisode: item.cursorEpisode,
    fromSeason: item.fromSeason,
    fromEpisode: item.fromEpisode,
    lastEpisode: item.lastEpisode,
    nextEpisodeHint: item.nextEpisodeHint,
  });

  if (
    !hunt.cursor ||
    hunt.cursor.season !== opts.grabSeason ||
    hunt.cursor.episode !== opts.grabEpisode
  ) {
    return { advanced: false };
  }

  const advanced = afterSuccessfulGrab(
    item.title,
    hunt.cursor,
    opts.grabbedTitle,
  );

  await prisma.watchListItem.update({
    where: { id: item.id },
    data: {
      lastChecked: new Date(),
      latestReleaseTitle: opts.grabbedTitle,
      latestReleaseAt: new Date(),
      lastEpisode: advanced.lastEpisode,
      cursorSeason: advanced.cursorSeason,
      cursorEpisode: advanced.cursorEpisode,
      nextEpisodeHint: advanced.nextEpisodeHint,
      ...(item.fromSeason == null
        ? {
            fromSeason: hunt.cursor.season,
            fromEpisode: hunt.cursor.episode,
          }
        : {}),
    },
  });

  return {
    advanced: true,
    lastEpisode: advanced.lastEpisode,
    cursorSeason: advanced.cursorSeason,
    cursorEpisode: advanced.cursorEpisode,
    nextEpisodeHint: advanced.nextEpisodeHint,
  };
}

export async function grabSingleEpisode(opts: {
  userId: string;
  showTitle: string;
  mediaType: string;
  season: number;
  episode: number;
  /** Optional library item id for GrabJob externalId + hunt-cursor advance */
  watchListItemId?: string | null;
}): Promise<OnDemandResult> {
  const season = Math.max(1, Math.trunc(opts.season) || 1);
  const episode = Math.max(1, Math.trunc(opts.episode) || 1);
  const query = episodeSearchQuery(opts.showTitle, season, episode);
  const searchCategory =
    opts.mediaType === "anime"
      ? "anime"
      : opts.mediaType === "movie"
        ? "movies"
        : "tv";

  const config = await getUserClientConfig(opts.userId);
  if (!config) {
    return {
      ok: false,
      query,
      message: "No client configured",
    };
  }

  const result = await searchTorrents({
    query,
    category: searchCategory,
    limit: 15,
    enrich: false,
    skipCache: true,
    filters: {
      hasMagnet: true,
      minSeeders: 1,
      season,
      episode,
    },
  });

  const withMagnet = result.results.filter(
    (t) => t.magnet && (t.seeders ?? 0) > 0,
  );
  const best =
    withMagnet.find((t) => {
      const ep = parseEpisode(t.title);
      return ep.season === season && ep.episode === episode;
    }) ?? null;

  if (!best?.magnet) {
    await prisma.grabJob.create({
      data: {
        userId: opts.userId,
        title: opts.showTitle,
        query,
        status: "skipped",
        message: `On-demand: no matching ${formatEpisodeLabel(season, episode)} release`,
        kind: "ondemand",
        externalId: opts.watchListItemId ?? null,
      },
    });
    return {
      ok: false,
      query,
      message: `No seeded torrent for ${formatEpisodeLabel(season, episode)}`,
    };
  }

  const target = resolveSmartSendTarget(config, {
    name: best.title,
    source: best.source,
    searchCategory,
  });

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
          userId: opts.userId,
          title: best.title,
          query,
          status: "failed",
          message: space.message,
          magnet: best.magnet,
          kind: "ondemand",
          externalId: opts.watchListItemId ?? null,
          savePath: target.savePath,
        },
      });
      return { ok: false, query, message: space.message, title: best.title };
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
  }

  await prisma.grabJob.create({
    data: {
      userId: opts.userId,
      title: best.title,
      query,
      status: send.ok ? "sent" : "failed",
      message: `On-demand ${formatEpisodeLabel(season, episode)} · ${send.message}`,
      magnet: best.magnet,
      infoHash: best.infoHash ?? null,
      source: best.source,
      savePath: target.savePath,
      category: target.category,
      kind: "ondemand",
      externalId: opts.watchListItemId ?? null,
    },
  });

  if (!send.ok) {
    return {
      ok: false,
      message: send.message,
      query,
      title: best.title,
      savePath: target.savePath,
      magnet: best.magnet,
    };
  }

  // Hunt-cursor grab advances; off-cursor rewatch does not.
  let cursorAdvance: Awaited<
    ReturnType<typeof advanceLibraryItemIfHuntMatch>
  > = { advanced: false };
  if (opts.watchListItemId) {
    cursorAdvance = await advanceLibraryItemIfHuntMatch({
      userId: opts.userId,
      watchListItemId: opts.watchListItemId,
      grabSeason: season,
      grabEpisode: episode,
      grabbedTitle: best.title,
    });
  }

  const label = formatEpisodeLabel(season, episode);
  const message = cursorAdvance.advanced
    ? `${send.message} · advanced past ${label}`
    : send.message;

  return {
    ok: true,
    message,
    query,
    title: best.title,
    savePath: target.savePath,
    magnet: best.magnet,
    advanced: cursorAdvance.advanced,
    lastEpisode: cursorAdvance.lastEpisode,
    cursorSeason: cursorAdvance.cursorSeason,
    cursorEpisode: cursorAdvance.cursorEpisode,
    nextEpisodeHint: cursorAdvance.nextEpisodeHint,
  };
}
