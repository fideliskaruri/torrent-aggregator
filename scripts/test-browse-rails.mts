/**
 * Browse rail correctness against seeded data.
 *
 * Run: npx tsx scripts/test-browse-rails.mts   (or `npm run test:rails`)
 *
 * WHY THIS EXISTS
 * ---------------
 * Two rail defects shipped that no unit test could see, because both only
 * appear once there is *real data with a specific shape* in the database:
 *
 *   1. **Borrowed posters.** Release-backed rail poster lookup matched a torrent
 *      against `CachedMetadata` with bidirectional containment, on the *raw
 *      torrent name*. A single catalog row titled "Dune" therefore lent its
 *      poster to "Children.of.Dune.S01.COMPLETE.720p...", because that name
 *      contains "dune". Rows are scanned `updatedAt desc` with a `break` on
 *      first match, so which wrong poster you got depended on your recent
 *      search history.
 *
 *   2. **Unearned availability.** Continue Watching hardcoded
 *      `availability: "warm"` for every `PlaybackProgress` row. There is no FK
 *      from progress to `EngineTorrent` and nothing deletes progress when a
 *      torrent is removed, so a deleted download still rendered as
 *      partially-downloaded with a Play button that could not play.
 *
 * Both render as a completely normal-looking page, which is exactly why they
 * need a test that inspects the payload rather than a screenshot.
 *
 * Everything is created under a throwaway user and deleted afterwards.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { buildBrowsePayload } from "../src/lib/browse/rails";
import { shutdownBuiltinEngine } from "../src/lib/clients/builtin-engine";
import type { Rail, RailItem } from "../src/lib/browse/types";

const userId = `rails-test-${randomUUID()}`;
const DUNE_POSTER = "https://example.invalid/poster-dune.jpg";
const metadataKeys: string[] = [];

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

function rail(rails: Rail[], id: string): Rail | undefined {
  return rails.find((r) => r.id === id);
}

function item(r: Rail | undefined, match: string): RailItem | undefined {
  // Card titles are raw torrent names ("Children.of.Dune.S01.COMPLETE..."), so
  // separators must be flattened before matching. Getting this wrong makes the
  // poster assertion below pass *vacuously* on `undefined`, which is worse than
  // no test at all.
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return r?.items.find((i) => flat(i.title).includes(flat(match)));
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: userId, name: "rails test", email: `${userId}@test.invalid` },
  });

  // A catalog row for the *film* Dune, with artwork. This is the vaguer title
  // that used to be lent out to every work whose name contains "dune".
  const key = `rails-test-${randomUUID()}`;
  metadataKeys.push(key);
  await prisma.cachedMetadata.create({
    data: {
      cacheKey: key,
      source: "tmdb",
      mediaType: "movie",
      externalId: "438631",
      title: "Dune",
      posterUrl: DUNE_POSTER,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  await prisma.engineTorrent.createMany({
    data: [
      // Completed DB row: a *different* work whose name contains "dune".
      {
        userId,
        hash: "a".repeat(40),
        name: "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
        status: "seeding",
        progress: 1,
      },
      // Continue Watching: genuinely half-downloaded.
      {
        userId,
        hash: "b".repeat(40),
        name: "Some.Show.S01E02.1080p.WEB-DL",
        status: "downloading",
        progress: 0.4,
      },
      // Continue Watching: the user deleted this one.
      {
        userId,
        hash: "c".repeat(40),
        name: "Deleted.Show.S01E03.1080p.WEB-DL",
        status: "removed",
        progress: 1,
      },
    ],
  });

  await prisma.downloadHistory.create({
    data: {
      userId,
      title: "Children.of.Dune.S01.COMPLETE.720p.BluRay.x264-GalaxyTV",
      infoHash: "a".repeat(40),
      status: "sent",
      // Explicitly "keep" so the `retention: { not: "stream" }` filter in
      // buildRecentlyAdded includes this row even when the DB adapter treats
      // NULL as excluded by != comparisons.
      retention: "keep",
    },
  });

  await prisma.playbackProgress.createMany({
    data: [
      {
        userId,
        infoHash: "b".repeat(40),
        filePath: "some.show.s01e02.mkv",
        positionSec: 600,
        durationSec: 2400,
        title: "Some Show",
        season: 1,
        episode: 2,
      },
      {
        userId,
        infoHash: "c".repeat(40),
        filePath: "deleted.show.s01e03.mkv",
        positionSec: 300,
        durationSec: 2400,
        title: "Deleted Show",
        season: 1,
        episode: 3,
      },
      // Progress for a torrent that no longer exists at all.
      {
        userId,
        infoHash: "d".repeat(40),
        filePath: "ghost.mkv",
        positionSec: 120,
        durationSec: 2400,
        title: "Ghost Episode",
        season: 1,
        episode: 1,
      },
    ],
  });
}

async function cleanup(): Promise<void> {
  await shutdownBuiltinEngine().catch(() => undefined);
  await prisma.cachedMetadata
    .deleteMany({ where: { cacheKey: { in: metadataKeys } } })
    .catch(() => undefined);
  // PlaybackProgress and EngineTorrent cascade from the user.
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}

async function main(): Promise<void> {
  console.log("browse rails against seeded data\n");
  await seed();

  const payload = await buildBrowsePayload(userId);
  const rails = payload.rails;

  // --- Poster borrowing ---------------------------------------------------
  const ready = rail(rails, "ready-to-play");
  const recent = rail(rails, "recently-added");
  const children = item(recent, "children of dune");

  check("Recently Added contains the completed release", () => {
    assert.ok(
      children,
      `expected a Children of Dune card; got ${JSON.stringify(
        recent?.items.map((i) => i.title) ?? null,
      )}`,
    );
  });

  check("a rail card shows the work, not the raw release filename", () => {
    assert.equal(
      children?.title,
      "Children of Dune",
      `a browse card must read like something you can decide to watch, not ` +
        `like a filename; got ${JSON.stringify(children?.title)}`,
    );
  });

  check("a vaguer catalog title does not lend its poster to another work", () => {
    assert.ok(children, "precondition: the card must exist for this to mean anything");
    assert.notEqual(
      children?.posterUrl,
      DUNE_POSTER,
      `Children of Dune is wearing the film Dune's artwork. A catalog title may ` +
        `refine a name, never blur one — and matching must run on the derived ` +
        `work name, not the raw torrent name`,
    );
  });

  check("a completed DB row absent from the live engine is not called ready", () => {
    const unbackedReady = item(ready, "children of dune");
    assert.equal(
      unbackedReady,
      undefined,
      "Ready to Play may only contain torrents the live engine can actually serve",
    );
  });

  // --- Unearned availability ----------------------------------------------
  const cw = rail(rails, "continue-watching");

  check("Continue Watching lists the in-progress episodes", () => {
    assert.ok(cw, "expected a continue-watching rail");
    assert.equal(cw!.items.length, 3, "expected all three progress rows");
  });

  check("a half-downloaded torrent with no live engine is not claimed warm", () => {
    assert.equal(
      item(cw, "some show")?.availability,
      null,
      "without a live engine to confirm the torrent is present, the honest " +
        "answer is null (uncertain) — not warm. Claiming warm without engine " +
        "confirmation was the original bug that introduced phantom Play buttons " +
        "for deleted downloads.",
    );
  });

  check("a removed torrent is not claimed to be warm", () => {
    const a = item(cw, "deleted show")?.availability;
    assert.notEqual(
      a,
      "warm",
      "the torrent was removed; offering Play here is the one thing the " +
        "availability contract forbids",
    );
    assert.equal(a, null, `expected null ("we cannot say"), got ${a}`);
  });

  check("progress for a torrent that no longer exists is not claimed", () => {
    const a = item(cw, "ghost")?.availability;
    assert.equal(
      a,
      null,
      `there is no EngineTorrent row at all for this hash, so any state other ` +
        `than null is invented; got ${a}`,
    );
  });

  // --- The honest-null contract still reaches the payload ------------------
  check("resume positions survive the availability change", () => {
    assert.equal(item(cw, "some show")?.resumePositionSec, 600);
    assert.equal(
      Math.round((item(cw, "some show")?.progressFraction ?? 0) * 100),
      25,
    );
  });
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    if (failures) {
      console.error(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("\nALL GREEN — browse rails tell the truth");
  });
