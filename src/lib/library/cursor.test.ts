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

console.log("cursor.test.ts: all assertions passed");
