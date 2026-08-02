import assert from "node:assert/strict";
import {
  parseSeasonEpisodes,
  parseShowShape,
  parseTitleDetailFacts,
  pickMovieCertification,
  pickTvCertification,
} from "./tmdb-extras";

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

// --- Hero facts: genres, vote count, original language --------------------
const facts = parseTitleDetailFacts({
  genres: [
    { name: "Sci-Fi & Fantasy" },
    { name: " Drama " },
    { name: "Drama" }, // duplicate after trim — dropped
    { name: "  " }, // blank — dropped
  ],
  vote_count: 4213,
  original_language: "en",
});
assert.deepEqual(
  facts.genres,
  ["Sci-Fi & Fantasy", "Drama"],
  "genre names are trimmed, de-duped, and kept in provider order",
);
assert.equal(facts.voteCount, 4213);
assert.equal(
  facts.originalLanguage,
  "EN",
  "original language is uppercased for display",
);

// A zero vote count is not a count worth printing.
assert.equal(parseTitleDetailFacts({ vote_count: 0 }).voteCount, null);
// Absent detail body → fully empty facts, never a throw.
assert.deepEqual(parseTitleDetailFacts(null), {
  genres: [],
  voteCount: null,
  originalLanguage: null,
});

// --- TV certification: US preferred, first-region fallback ----------------
assert.equal(
  pickTvCertification([
    { iso_3166_1: "GB", rating: "15" },
    { iso_3166_1: "US", rating: "TV-MA" },
  ]),
  "TV-MA",
  "the US rating wins even when it is not listed first",
);
assert.equal(
  pickTvCertification([
    { iso_3166_1: "DE", rating: "16" },
    { iso_3166_1: "FR", rating: "" },
  ]),
  "16",
  "with no US entry, fall back to the first non-empty region",
);
assert.equal(pickTvCertification([]), null);

// --- Movie certification: US preferred, dug out of release entries --------
assert.equal(
  pickMovieCertification([
    { iso_3166_1: "GB", release_dates: [{ certification: "12A" }] },
    {
      iso_3166_1: "US",
      release_dates: [{ certification: "" }, { certification: "PG-13" }],
    },
  ]),
  "PG-13",
  "the US certification wins, skipping empty release entries",
);
assert.equal(
  pickMovieCertification([
    { iso_3166_1: "FR", release_dates: [{ certification: "" }] },
    { iso_3166_1: "JP", release_dates: [{ certification: "G" }] },
  ]),
  "G",
  "with no US certification, fall back to the first non-empty region",
);
assert.equal(pickMovieCertification([]), null);

console.log("PASS TMDB extras preserves provider-evidenced show shape");
