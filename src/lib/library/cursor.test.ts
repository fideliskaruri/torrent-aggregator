/**
 * Run: npx tsx src/lib/library/cursor.test.ts
 */
import assert from "node:assert/strict";
import {
  advanceCursor,
  advanceCursorAfterMiss,
  afterSuccessfulGrab,
  cursorFromStart,
  episodeSearchQuery,
  resolveHuntCursor,
  SEASON_ROLLOVER_MISS_THRESHOLD,
  HUNT_BACKOFF_AFTER_MISSES,
  huntBackoffMs,
  isHuntDue,
} from "./cursor";

{
  const c = cursorFromStart(9, 1);
  assert.equal(c.season, 9);
  assert.equal(c.episode, 1);
  assert.equal(
    episodeSearchQuery("Family Guy", 9, 1),
    "Family Guy S09E01",
  );
}

{
  const { query, cursor } = resolveHuntCursor({
    title: "Family Guy",
    mediaType: "tv",
    fromSeason: 9,
    fromEpisode: 1,
    cursorSeason: 9,
    cursorEpisode: 1,
  });
  assert.equal(query, "Family Guy S09E01");
  assert.deepEqual(cursor, { season: 9, episode: 1 });
}

{
  const { query } = resolveHuntCursor({
    title: "Dune",
    mediaType: "movie",
  });
  assert.equal(query, "Dune");
}

{
  const next = afterSuccessfulGrab(
    "Family Guy",
    { season: 9, episode: 1 },
    "Family Guy - S09E01 - And Then There Were Fewer [1080p]",
  );
  assert.equal(next.lastEpisode, "S09E01");
  assert.equal(next.cursorSeason, 9);
  assert.equal(next.cursorEpisode, 2);
  assert.equal(next.nextEpisodeHint, "Family Guy S09E02");
}

{
  // lastEpisode means already have → hunt next
  const { query, cursor } = resolveHuntCursor({
    title: "Family Guy",
    mediaType: "tv",
    lastEpisode: "S09E05",
  });
  assert.equal(query, "Family Guy S09E06");
  assert.deepEqual(cursor, { season: 9, episode: 6 });
}

// ---------------------------------------------------------------------------
// Season rollover on repeated misses.
//
// Rule class, asserted across diverse shapes rather than one sample show:
//   * misses below the threshold never move the cursor
//   * the Nth consecutive miss rolls S{n}E{x} -> S{n+1}E01 and resets the count
//   * a cursor still sitting on E01 never rolls over (we have landed nothing
//     from this season, so an empty result means "unavailable", not "ended")
// ---------------------------------------------------------------------------
{
  const cases: {
    name: string;
    cursor: { season: number; episode: number };
    misses: number;
    expect: { season: number; episode: number; misses: number; rolled: boolean };
  }[] = [
    {
      name: "first miss mid-season just counts",
      cursor: { season: 9, episode: 14 },
      misses: 0,
      expect: { season: 9, episode: 14, misses: 1, rolled: false },
    },
    {
      name: "second miss still counts",
      cursor: { season: 3, episode: 22 },
      misses: 1,
      expect: { season: 3, episode: 22, misses: 2, rolled: false },
    },
    {
      name: "third miss rolls to next season E01",
      cursor: { season: 3, episode: 22 },
      misses: 2,
      expect: { season: 4, episode: 1, misses: 0, rolled: true },
    },
    {
      name: "long-running show rolls the same way",
      cursor: { season: 23, episode: 1088 },
      misses: 2,
      expect: { season: 24, episode: 1, misses: 0, rolled: true },
    },
    {
      name: "season 1 rolls to season 2",
      cursor: { season: 1, episode: 6 },
      misses: 2,
      expect: { season: 2, episode: 1, misses: 0, rolled: true },
    },
    {
      name: "never rolls off E01 — nothing landed this season yet",
      cursor: { season: 5, episode: 1 },
      misses: 2,
      expect: { season: 5, episode: 1, misses: 3, rolled: false },
    },
    {
      name: "E01 keeps counting without ever rolling",
      cursor: { season: 5, episode: 1 },
      misses: 99,
      expect: { season: 5, episode: 1, misses: 100, rolled: false },
    },
    {
      name: "negative/garbage miss count is treated as zero",
      cursor: { season: 2, episode: 4 },
      misses: -7,
      expect: { season: 2, episode: 4, misses: 1, rolled: false },
    },
  ];

  for (const c of cases) {
    const got = advanceCursorAfterMiss(c.cursor, c.misses);
    assert.equal(got.cursor.season, c.expect.season, `${c.name}: season`);
    assert.equal(got.cursor.episode, c.expect.episode, `${c.name}: episode`);
    assert.equal(got.misses, c.expect.misses, `${c.name}: misses`);
    assert.equal(got.rolledOver, c.expect.rolled, `${c.name}: rolledOver`);
  }
}

{
  // A show that dead-ends at the end of a season must reach the next season
  // by repeated misses alone — this is the bug the rollover exists to fix.
  let cursor = { season: 2, episode: 13 };
  let misses = 0;
  for (let i = 0; i < SEASON_ROLLOVER_MISS_THRESHOLD; i++) {
    const next = advanceCursorAfterMiss(cursor, misses);
    cursor = next.cursor;
    misses = next.misses;
  }
  assert.deepEqual(cursor, { season: 3, episode: 1 });
  assert.equal(misses, 0);
}

{
  // The threshold is configurable and honoured.
  const eager = advanceCursorAfterMiss({ season: 1, episode: 10 }, 0, 1);
  assert.equal(eager.rolledOver, true);
  assert.deepEqual(eager.cursor, { season: 2, episode: 1 });

  const patient = advanceCursorAfterMiss({ season: 1, episode: 10 }, 3, 10);
  assert.equal(patient.rolledOver, false);
  assert.equal(patient.misses, 4);
}

{
  // advanceCursor itself must stay a pure in-season step.
  assert.deepEqual(advanceCursor({ season: 4, episode: 9 }), {
    season: 4,
    episode: 10,
  });
}

// Hunt backoff: an item that can never succeed must not burn one indexer
// request per scheduler tick forever. A cursor parked at S04E01 of a
// three-season show cannot roll over (rollover needs episode > 1), so it is
// the case this exists for.
{
  assert.ok(
    HUNT_BACKOFF_AFTER_MISSES > SEASON_ROLLOVER_MISS_THRESHOLD,
    "backoff must not fire before a normal season rollover gets its chance",
  );

  // Below the threshold nothing is deferred — a new or recovering item is
  // hunted every pass.
  for (let m = 0; m < HUNT_BACKOFF_AFTER_MISSES; m += 1) {
    assert.equal(huntBackoffMs(m), 0, `misses=${m} must not back off`);
    assert.equal(isHuntDue(m, new Date()), true);
  }

  // Then it grows, and it is monotonic.
  const first = huntBackoffMs(HUNT_BACKOFF_AFTER_MISSES);
  const second = huntBackoffMs(HUNT_BACKOFF_AFTER_MISSES + 1);
  assert.ok(first > 0);
  assert.ok(second > first, "backoff must grow with consecutive misses");

  // And it is capped, so a long-abandoned item is still retried daily rather
  // than never — the show may simply not have aired yet.
  const huge = huntBackoffMs(500);
  assert.ok(Number.isFinite(huge), "2 ** misses must not overflow to Infinity");
  assert.equal(huge, huntBackoffMs(1000), "backoff must plateau at the cap");
  assert.ok(
    huge <= 6 * 60 * 60 * 1000,
    "a parked SxxE01 is usually an unaired premiere or an indexer outage; both" +
      " resolve on their own, so the ceiling stays short",
  );

  // Due once the wait has elapsed.
  const misses = HUNT_BACKOFF_AFTER_MISSES;
  const wait = huntBackoffMs(misses);
  const now = new Date("2025-01-01T12:00:00Z");
  assert.equal(
    isHuntDue(misses, new Date(now.getTime() - wait + 1000), now),
    false,
    "still inside the backoff window",
  );
  assert.equal(
    isHuntDue(misses, new Date(now.getTime() - wait), now),
    true,
    "exactly at the window edge counts as due",
  );

  // Never-checked items are due.
  assert.equal(isHuntDue(misses, null, now), true);

  // A clock change that puts lastChecked in the future must not park the item
  // until the clock catches up.
  assert.equal(
    isHuntDue(misses, new Date(now.getTime() + 86_400_000), now),
    true,
    "a future lastChecked must not strand the item",
  );

  // Garbage miss counts degrade to "hunt it".
  assert.equal(huntBackoffMs(NaN), 0);
  assert.equal(huntBackoffMs(-5), 0);
}

console.log("cursor.test.ts: all assertions passed");
