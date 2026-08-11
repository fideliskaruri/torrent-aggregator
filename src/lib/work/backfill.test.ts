import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workKeyFor } from "@/components/title/work-key";
import { prisma } from "@/lib/prisma";
import { backfillCanonicalWorks } from "./backfill";
import { ensureCanonicalWork } from "./store";

async function main() {
  const suffix = randomUUID();
  const userId = `backfill-${suffix}`;
  const hash = suffix.replaceAll("-", "").slice(0, 40);
  const progressHash = `a${hash.slice(1)}`;
  const historyHash = `b${hash.slice(1)}`;
  const sharedTitle = `Watch Only ${suffix}`;
  const sharedWorkKey = workKeyFor(sharedTitle);

  await prisma.user.create({
    data: { id: userId, name: "Backfill Test" },
  });
  const providerOwner = await ensureCanonicalWork({
    workKey: sharedWorkKey,
    title: sharedTitle,
    mediaType: "tv",
    provider: "tmdb",
    providerId: `tv-${suffix}`,
  });
  const catalog = await prisma.catalogEntry.create({
    data: {
      workKey: `catalog-only-${suffix}`,
      title: `Catalog Only ${suffix}`,
      mediaType: "movie",
      source: `test-${suffix}`,
    },
  });
  const sharedCatalog = await prisma.catalogEntry.create({
    data: {
      workKey: sharedWorkKey,
      title: sharedTitle,
      mediaType: "tv",
      source: `shared-${suffix}`,
    },
  });
  const watch = await prisma.watchListItem.create({
    data: {
      userId,
      mediaType: "tv",
      externalId: `tv-${suffix}`,
      title: sharedTitle,
    },
  });
  const torrent = await prisma.engineTorrent.create({
    data: {
      userId,
      hash,
      name: `Engine Only ${suffix} S01E01 1080p WEB-DL`,
      category: "TV",
    },
  });
  const progress = await prisma.playbackProgress.create({
    data: {
      userId,
      infoHash: progressHash,
      filePath: `Progress Only ${suffix}.mkv`,
      title: `Progress Only ${suffix}`,
    },
  });
  const history = await prisma.downloadHistory.create({
    data: {
      userId,
      infoHash: historyHash,
      title: `History Only ${suffix}`,
      category: "Movies",
      status: "sent",
    },
  });

  try {
    await backfillCanonicalWorks();
    const [
      catalogAfter,
      sharedCatalogAfter,
      watchAfter,
      torrentAfter,
      progressAfter,
      historyAfter,
    ] =
      await Promise.all([
        prisma.catalogEntry.findUniqueOrThrow({ where: { id: catalog.id } }),
        prisma.catalogEntry.findUniqueOrThrow({ where: { id: sharedCatalog.id } }),
        prisma.watchListItem.findUniqueOrThrow({ where: { id: watch.id } }),
        prisma.engineTorrent.findUniqueOrThrow({ where: { id: torrent.id } }),
        prisma.playbackProgress.findUniqueOrThrow({ where: { id: progress.id } }),
        prisma.downloadHistory.findUniqueOrThrow({ where: { id: history.id } }),
      ]);

    assert.ok(catalogAfter.workId, "catalog-only rows must receive a Work");
    assert.equal(
      sharedCatalogAfter.workId,
      watchAfter.workId,
      "catalog and watchlist rows with the same key must share one Work",
    );
    assert.notEqual(
      watchAfter.workId,
      providerOwner.id,
      "an unverified watchlist externalId must not claim provider ownership",
    );
    const watchWork = await prisma.work.findUniqueOrThrow({
      where: { id: watchAfter.workId! },
    });
    assert.equal(watchWork.provider, null);
    assert.equal(watchWork.providerId, null);
    assert.ok(torrentAfter.workId, "engine-only rows must receive a Work");
    assert.ok(progressAfter.workId, "progress-only rows must receive a Work");
    assert.ok(historyAfter.workId, "history-only rows must receive a Work");
  } finally {
    const linkedRows = await Promise.all([
      prisma.catalogEntry.findUnique({ where: { id: catalog.id } }),
      prisma.catalogEntry.findUnique({ where: { id: sharedCatalog.id } }),
      prisma.watchListItem.findUnique({ where: { id: watch.id } }),
      prisma.engineTorrent.findUnique({ where: { id: torrent.id } }),
      prisma.playbackProgress.findUnique({ where: { id: progress.id } }),
      prisma.downloadHistory.findUnique({ where: { id: history.id } }),
    ]);
    const workIds = new Set([
      providerOwner.id,
      ...linkedRows
        .map((row) => row?.workId)
        .filter((id): id is string => Boolean(id)),
    ]);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.catalogEntry.deleteMany({
      where: { id: { in: [catalog.id, sharedCatalog.id] } },
    });
    await prisma.work.deleteMany({ where: { id: { in: [...workIds] } } });
  }

  await prisma.$disconnect();
  console.log("PASS canonical Work backfill covers records without targets");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
