import assert from "node:assert/strict";
import { parseSeasonEpisodes, parseShowShape } from "./tmdb-extras";

const shape = parseShowShape({
  number_of_seasons: 22,
  seasons: [
    { season_number: 0, episode_count: 12 },
    { season_number: 3, episode_count: 19 },
    { season_number: 1, episode_count: 7 },
    { season_number: 2, episode_count: 16 },
  ],
});
assert.equal(shape.seasonCount, 22);
assert.deepEqual(shape.seasons, [1, 2, 3]);
assert.deepEqual(shape.episodesBySeason, { 1: 7, 2: 16, 3: 19 });
assert.ok(!shape.seasons.includes(4), "a declared count is not evidence for season 4");

const episodes = parseSeasonEpisodes({
  episodes: [
    { episode_number: 2, name: "Two" },
    { episode_number: 1, name: "One" },
    { episode_number: 7, name: "Seven" },
    { episode_number: 0, name: "Special" },
  ],
});
assert.deepEqual(episodes.map((episode) => episode.episode), [1, 2, 7]);
assert.equal(episodes[2].name, "Seven");

console.log("PASS TMDB extras preserves provider-evidenced show shape");
