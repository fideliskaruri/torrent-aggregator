import { prisma } from "@/lib/prisma";
import { backfillCanonicalWorks } from "@/lib/work/backfill";

backfillCanonicalWorks()
  .then((result) => {
    console.log(
      `Canonical work backfill: ${result.works} works; `
        + `${result.catalogEntries} catalog, `
        + `${result.acquisitionTargets} targets, `
        + `${result.engineTorrents} torrents, `
        + `${result.playbackProgress} progress, `
        + `${result.downloadHistory} history, `
        + `${result.watchListItems} watchlist rows linked`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
