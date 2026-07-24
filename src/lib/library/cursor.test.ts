/**
 * Run: npx tsx src/lib/library/cursor.test.ts
 */
import assert from "node:assert/strict";
import {
  afterSuccessfulGrab,
  cursorFromStart,
  episodeSearchQuery,
  resolveHuntCursor,
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

console.log("cursor.test.ts: all assertions passed");
