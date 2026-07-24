import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { parseEpisode, compareEpisodes, nextEpisodeQuery } from "@/lib/torrents/episodes";

/**
 * Check watchlist items for newer releases and update latestRelease* fields.
 */
export async function checkWatchlistReleases(userId: string) {
  const items = await prisma.watchListItem.findMany({
    where: {
      userId,
      status: { in: ["watching", "planned"] },
    },
  });

  const updates: {
    id: string;
    title: string;
    latestReleaseTitle: string | null;
    nextEpisodeHint: string | null;
  }[] = [];

  for (const item of items) {
    try {
      const category =
        item.mediaType === "anime"
          ? "anime"
          : item.mediaType === "movie"
            ? "movies"
            : "tv";

      const searchQ = nextEpisodeQuery(item.title, item.lastEpisode);
      const result = await searchTorrents({
        query: searchQ,
        category,
        limit: 12,
        enrich: false,
        filters: { minSeeders: 1 },
      });

      const best = result.results[0];
      if (!best) {
        updates.push({
          id: item.id,
          title: item.title,
          latestReleaseTitle: null,
          nextEpisodeHint: nextEpisodeQuery(item.title, item.lastEpisode),
        });
        continue;
      }

      const ep = parseEpisode(best.title);
      const last = item.lastEpisode
        ? parseEpisode(item.lastEpisode)
        : null;

      let isNew = true;
      if (last && ep.label) {
        isNew = compareEpisodes(ep, last) > 0 || ep.isSeasonPack;
      }

      await prisma.watchListItem.update({
        where: { id: item.id },
        data: {
          lastChecked: new Date(),
          latestReleaseTitle: best.title,
          latestReleaseAt: best.publishedAt
            ? new Date(best.publishedAt)
            : new Date(),
          latestReleaseMagnet: best.magnet ?? null,
          nextEpisodeHint: nextEpisodeQuery(
            item.title,
            ep.label || item.lastEpisode,
          ),
        },
      });

      updates.push({
        id: item.id,
        title: item.title,
        latestReleaseTitle: isNew ? best.title : null,
        nextEpisodeHint: nextEpisodeQuery(
          item.title,
          ep.label || item.lastEpisode,
        ),
      });
    } catch {
      updates.push({
        id: item.id,
        title: item.title,
        latestReleaseTitle: null,
        nextEpisodeHint: nextEpisodeQuery(item.title, item.lastEpisode),
      });
    }
  }

  return updates;
}
