/**
 * Shipped path: grab of hunt-cursor episode advances library item;
 * off-cursor rewatch does not.
 * Run: npx tsx scripts/test-ondemand-advance.ts
 */
import assert from "node:assert/strict";
import prisma from "../src/lib/prisma";
import { advanceLibraryItemIfHuntMatch } from "../src/lib/library/ondemand";
import { resolveHuntCursor } from "../src/lib/library/cursor";

const EXT = "test-ondemand-advance-cursor";

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) throw new Error("no user in DB");

  // Clean prior fixture
  await prisma.watchListItem.deleteMany({
    where: { userId: user.id, externalId: EXT },
  });

  const item = await prisma.watchListItem.create({
    data: {
      userId: user.id,
      mediaType: "tv",
      externalId: EXT,
      title: "Family Guy",
      status: "watching",
      monitored: true,
      fromSeason: 9,
      fromEpisode: 1,
      cursorSeason: 9,
      cursorEpisode: 1,
      lastEpisode: null,
      nextEpisodeHint: "Family Guy S09E01",
    },
  });

  const hunt0 = resolveHuntCursor(item);
  assert.equal(hunt0.query, "Family Guy S09E01");
  assert.deepEqual(hunt0.cursor, { season: 9, episode: 1 });

  // Off-cursor rewatch (S09E05 while hunting S09E01) — no advance
  const rewatch = await advanceLibraryItemIfHuntMatch(prisma, {
    userId: user.id,
    watchListItemId: item.id,
    grabSeason: 9,
    grabEpisode: 5,
    grabbedTitle: "Family.Guy.S09E05.HDTV",
  });
  assert.equal(rewatch.advanced, false, "rewatch must not advance");

  const afterRewatch = await prisma.watchListItem.findUniqueOrThrow({
    where: { id: item.id },
  });
  assert.equal(afterRewatch.cursorSeason, 9);
  assert.equal(afterRewatch.cursorEpisode, 1);
  assert.equal(afterRewatch.lastEpisode, null);

  // Hunt-cursor match — advance like automation
  const matched = await advanceLibraryItemIfHuntMatch(prisma, {
    userId: user.id,
    watchListItemId: item.id,
    grabSeason: 9,
    grabEpisode: 1,
    grabbedTitle: "Family.Guy.S09E01.HDTV.XviD-LOL",
  });
  assert.equal(matched.advanced, true, "hunt match must advance");
  assert.equal(matched.lastEpisode, "S09E01");
  assert.equal(matched.cursorSeason, 9);
  assert.equal(matched.cursorEpisode, 2);
  assert.equal(matched.nextEpisodeHint, "Family Guy S09E02");

  const after = await prisma.watchListItem.findUniqueOrThrow({
    where: { id: item.id },
  });
  assert.equal(after.lastEpisode, "S09E01");
  assert.equal(after.cursorSeason, 9);
  assert.equal(after.cursorEpisode, 2);
  assert.equal(after.nextEpisodeHint, "Family Guy S09E02");

  const hunt1 = resolveHuntCursor(after);
  assert.equal(hunt1.query, "Family Guy S09E02");

  // Second hunt match advances again
  const next = await advanceLibraryItemIfHuntMatch(prisma, {
    userId: user.id,
    watchListItemId: item.id,
    grabSeason: 9,
    grabEpisode: 2,
    grabbedTitle: "Family.Guy.S09E02.720p",
  });
  assert.equal(next.advanced, true);
  assert.equal(next.cursorEpisode, 3);
  assert.equal(next.lastEpisode, "S09E02");

  // Cleanup fixture
  await prisma.watchListItem.delete({ where: { id: item.id } });

  console.log("PASS ondemand-advance: rewatch no-op, hunt advances S09E01→E02→E03");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
