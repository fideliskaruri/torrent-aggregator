import {
  displayTitleFromWorkKey,
  workIdentityFor,
  workKeyFor,
} from "@/components/title/work-key";
import { prisma } from "@/lib/prisma";
import {
  canonicalProgressTitle,
  canonicalWorkForHash,
  ensureCanonicalWork,
  type CanonicalWorkInput,
} from "@/lib/work/store";

function mediaTypeFromCategory(category: string | null | undefined): string | null {
  const value = category?.trim().toLowerCase();
  if (value === "anime") return "anime";
  if (value === "tv" || value === "series") return "tv";
  if (value === "movie" || value === "movies") return "movie";
  return null;
}

function inferredWork(
  title: string,
  explicitMediaType?: string | null,
): CanonicalWorkInput | null {
  const identity = workIdentityFor(title);
  const workKey = workKeyFor(
    identity.name,
    identity.isSeries ? null : identity.year,
  );
  if (!workKey) return null;
  return {
    workKey,
    title: identity.name,
    year: identity.year,
    mediaType:
      explicitMediaType?.trim()
      || (identity.isSeries ? "tv" : "movie"),
  };
}

export interface CanonicalWorkBackfillResult {
  works: number;
  catalogEntries: number;
  acquisitionTargets: number;
  engineTorrents: number;
  playbackProgress: number;
  downloadHistory: number;
  watchListItems: number;
}

export async function backfillCanonicalWorks(): Promise<CanonicalWorkBackfillResult> {
  const touchedWorkIds = new Set<string>();
  const ensure = async (input: CanonicalWorkInput) => {
    const work = await ensureCanonicalWork(input);
    touchedWorkIds.add(work.id);
    return work;
  };

  const result: CanonicalWorkBackfillResult = {
    works: 0,
    catalogEntries: 0,
    acquisitionTargets: 0,
    engineTorrents: 0,
    playbackProgress: 0,
    downloadHistory: 0,
    watchListItems: 0,
  };

  const catalogEntries = await prisma.catalogEntry.findMany({
    orderBy: { refreshedAt: "desc" },
  });
  for (const entry of catalogEntries) {
    const work = await ensure({
      workKey: entry.workKey,
      title: entry.title,
      year: entry.year,
      mediaType: entry.mediaType,
      posterUrl: entry.posterUrl,
    });
    if (entry.workId !== work.id) {
      await prisma.catalogEntry.update({
        where: { id: entry.id },
        data: { workId: work.id },
      });
    }
    result.catalogEntries += 1;
  }

  const watchItems = await prisma.watchListItem.findMany();
  for (const item of watchItems) {
    const work = await ensure({
      workKey: workKeyFor(item.title),
      title: item.title,
      mediaType: item.mediaType,
      posterUrl: item.posterUrl,
    });
    if (item.workId !== work.id) {
      await prisma.watchListItem.update({
        where: { id: item.id },
        data: { workId: work.id },
      });
    }
    result.watchListItems += 1;
  }

  const targets = await prisma.acquisitionTarget.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      userId: true,
      workId: true,
      workKey: true,
      infoHash: true,
    },
  });
  for (const target of targets) {
    const [catalog, engineTorrent] = await Promise.all([
      prisma.catalogEntry.findFirst({
        where: { workKey: target.workKey },
        orderBy: { refreshedAt: "desc" },
      }),
      target.infoHash
        ? prisma.engineTorrent.findFirst({
            where: {
              userId: target.userId,
              hash: {
                in: [target.infoHash.toLowerCase(), target.infoHash.toUpperCase()],
              },
            },
            orderBy: { updatedAt: "desc" },
            select: { category: true },
          })
        : Promise.resolve(null),
    ]);
    const work = await ensure({
      workKey: target.workKey,
      title: catalog?.title ?? displayTitleFromWorkKey(target.workKey),
      year: catalog?.year ?? null,
      mediaType:
        catalog?.mediaType
        ?? mediaTypeFromCategory(engineTorrent?.category)
        ?? null,
      posterUrl: catalog?.posterUrl ?? null,
    });
    if (target.workId !== work.id) {
      await prisma.acquisitionTarget.update({
        where: { id: target.id },
        data: { workId: work.id },
      });
    }
    if (target.infoHash) {
      await prisma.engineTorrent.updateMany({
        where: {
          userId: target.userId,
          hash: {
            in: [target.infoHash.toLowerCase(), target.infoHash.toUpperCase()],
          },
        },
        data: { workId: work.id },
      });
    }
    result.acquisitionTargets += 1;
  }

  const engineTorrents = await prisma.engineTorrent.findMany();
  for (const torrent of engineTorrents) {
    let work = await canonicalWorkForHash(torrent.userId, torrent.hash);
    if (!work) {
      const input = inferredWork(
        torrent.name,
        mediaTypeFromCategory(torrent.category),
      );
      if (input) work = await ensure(input);
    }
    if (!work) continue;
    if (torrent.workId !== work.id) {
      await prisma.engineTorrent.update({
        where: { id: torrent.id },
        data: { workId: work.id },
      });
    }
    result.engineTorrents += 1;
  }

  const progressRows = await prisma.playbackProgress.findMany();
  for (const progress of progressRows) {
    let work = await canonicalWorkForHash(progress.userId, progress.infoHash);
    if (!work) {
      const input = inferredWork(progress.title);
      if (input) work = await ensure(input);
    }
    if (!work) continue;
    await prisma.playbackProgress.update({
      where: { id: progress.id },
      data: {
        workId: work.id,
        title: canonicalProgressTitle(work, progress.title),
      },
    });
    result.playbackProgress += 1;
  }

  const historyRows = await prisma.downloadHistory.findMany();
  for (const history of historyRows) {
    let work = history.infoHash
      ? await canonicalWorkForHash(history.userId, history.infoHash)
      : null;
    if (!work) {
      const input = inferredWork(
        history.title,
        mediaTypeFromCategory(history.category),
      );
      if (input) work = await ensure(input);
    }
    if (!work) continue;
    if (history.workId !== work.id) {
      await prisma.downloadHistory.update({
        where: { id: history.id },
        data: { workId: work.id },
      });
    }
    result.downloadHistory += 1;
  }

  result.works = touchedWorkIds.size;
  return result;
}
