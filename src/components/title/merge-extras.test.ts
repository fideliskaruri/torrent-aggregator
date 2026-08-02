import assert from "node:assert/strict";
import type { TitleEpisode, TitleEpisodeMeta } from "./types";
import { mergeEpisodes } from "./merge-extras";

function local(episode: number): TitleEpisode {
  return {
    season: 1,
    episode,
    label: `S01E${String(episode).padStart(2, "0")}`,
    availability: "ready",
    infoHash: `local-${episode}`,
    filePath: null,
    downloadFraction: 1,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    transfer: null,
  };
}

function provider(episode: number): TitleEpisodeMeta {
  return {
    episode,
    name: `Provider ${episode}`,
    overview: null,
    airDate: null,
    runtimeMin: 22,
    stillUrl: null,
  };
}

const merged = mergeEpisodes({
  season: 1,
  episodes: [local(1), local(2)],
  meta: Array.from({ length: 7 }, (_, index) => provider(index + 1)),
  metaSeason: 1,
});
assert.deepEqual(merged.rows.map((row) => row.episode), [1, 2, 3, 4, 5, 6, 7]);
assert.equal(merged.rows[0].infoHash, "local-1");
assert.equal(merged.rows[2].availability, null);

const stale = mergeEpisodes({
  season: 2,
  episodes: [],
  meta: [provider(1), provider(2)],
  metaSeason: 1,
});
assert.deepEqual(stale.rows, []);

console.log("PASS provider rows extend local holdings without stale-season metadata");
