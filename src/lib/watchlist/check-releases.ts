import prisma from "@/lib/prisma";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { searchCategoryForMediaType } from "@/lib/metadata/media-type";
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
      // Unknown media types fall back to a TV hunt: this pass only ever runs
      // for monitored watchlist rows, which are overwhelmingly series, and a
      // wrong-but-broad category still returns results. The fallback is
      // stated here rather than hidden in the shared helper because the
      // browse rails are right to make the opposite choice.
      const category = searchCategoryForMediaType(item.mediaType) ?? "tv";

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
