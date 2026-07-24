/**
 * Backend: on-demand single ep + backfill estimate (no HTTP session).
 * Run: npx tsx scripts/test-ondemand-and-estimate.ts
 */
import assert from "node:assert/strict";
import prisma from "../src/lib/prisma";
import { grabSingleEpisode } from "../src/lib/library/ondemand";
import {
  canFitEstimate,
  estimateBackfillBytes,
  formatBytesShort,
  getFreeSpace,
} from "../src/lib/library/disk-space";

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) throw new Error("no user");

  // Estimate only
  const est = estimateBackfillBytes({ fromSeason: 9, toSeason: 12 });
  console.log("estimate S09-S12:", est.episodes, "eps", formatBytesShort(est.estimatedBytes));
  const space = await getFreeSpace("D:\\Torrents");
  console.log("free:", space.freeBytes != null ? formatBytesShort(space.freeBytes) : "unknown");
  const fit = canFitEstimate(space.freeBytes, est.estimatedBytes);
  console.log("canFit:", fit.canFit, fit.message);
  assert.ok(est.seasons === 4);

  // On-demand: grab one episode (may skip if no seeds / already present)
  console.log("ondemand Family Guy S09E02…");
  const r = await grabSingleEpisode({
    userId: user.id,
    showTitle: "Family Guy",
    mediaType: "tv",
    season: 9,
    episode: 2,
  });
  console.log("ondemand:", r.ok, r.message.slice(0, 120), "query=", r.query);
  assert.equal(r.query, "Family Guy S09E02");
  // Cursor on library test item must not be required; check GrabJob kind
  const job = await prisma.grabJob.findFirst({
    where: { userId: user.id, kind: "ondemand", query: "Family Guy S09E02" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(job, "GrabJob ondemand row created");
  console.log("grabJob status:", job.status);

  // Bare ondemand (no watchListItemId) must not require a library item.
  // Hunt-cursor advance is covered by test-ondemand-advance.ts.
  const wl = await prisma.watchListItem.findFirst({
    where: { userId: user.id, externalId: "test-family-guy-s09" },
  });
  if (wl) {
    console.log(
      "library item present; bare ondemand left cursor:",
      wl.cursorSeason,
      wl.cursorEpisode,
    );
  }

  console.log("PASS ondemand + estimate");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
