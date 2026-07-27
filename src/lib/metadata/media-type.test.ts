import assert from "node:assert/strict";

import {
  isSeriesMediaType,
  normalizeMediaType,
  searchCategoryForMediaType,
} from "./media-type";

// --- Normalisation: the whole reason this module exists ---
// Six call sites compared media types with `===` against lowercase literals.
// A row stored as "Movie" matched none of them and fell through to a "tv"
// fallback, so the hunt searched the TV category for a film and counted a
// silent miss. Casing and surrounding whitespace must not change the verdict.
const NORMALIZE_CASES: [string | null | undefined, ReturnType<typeof normalizeMediaType>][] = [
  ["anime", "anime"],
  ["movie", "movie"],
  ["tv", "tv"],

  // Casing and whitespace are formatting, not meaning.
  ["Movie", "movie"],
  ["MOVIE", "movie"],
  ["  tv  ", "tv"],
  ["Anime", "anime"],
  ["\tTV\n", "tv"],

  // The category slug and the media type look alike and get crossed over.
  ["movies", "movie"],
  ["film", "movie"],
  ["series", "tv"],
  ["show", "tv"],
  ["tvshow", "tv"],

  // Anything we cannot vouch for stays unknown rather than becoming a default.
  [null, null],
  [undefined, null],
  ["", null],
  ["   ", null],
  ["music", null],
  ["games", null],
  ["all", null],
  ["documentary", null],
];

for (const [input, expected] of NORMALIZE_CASES) {
  assert.equal(
    normalizeMediaType(input),
    expected,
    `normalizeMediaType(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
  );
}

// --- Media type to search category ---
// "movie" becomes "movies" because the catalog is singular and the category
// slug is plural. That one-character mismatch is exactly what each call site
// was reimplementing.
const CATEGORY_CASES: [string | null | undefined, ReturnType<typeof searchCategoryForMediaType>][] =
  [
    ["anime", "anime"],
    ["movie", "movies"],
    ["tv", "tv"],

    ["Movie", "movies"],
    ["  Anime ", "anime"],
    ["movies", "movies"],
    ["series", "tv"],

    // Null, not a fallback: callers state their own default in the open,
    // because a hunt is right to assume "tv" and a browse rail is right to
    // render no category at all. A shared default would hide that.
    [null, null],
    [undefined, null],
    ["", null],
    ["music", null],
    ["nonsense", null],
  ];

for (const [input, expected] of CATEGORY_CASES) {
  assert.equal(
    searchCategoryForMediaType(input),
    expected,
    `searchCategoryForMediaType(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`,
  );
}

// --- Does it have episodes? ---
// Anime is a series. It is catalogued apart from TV because AniList is the
// better source for it, not because it is shaped differently: it still has
// S02E05, still needs a hunt cursor, still needs an episode picker.
const SERIES_CASES: [string | null | undefined, boolean][] = [
  ["tv", true],
  ["anime", true],
  ["TV", true],
  ["  Anime  ", true],
  ["series", true],
  ["show", true],

  ["movie", false],
  ["Movie", false],
  ["movies", false],
  ["film", false],

  // Unknown answers false: offering an episode picker for something we cannot
  // confirm is a series is the worse of the two mistakes.
  [null, false],
  [undefined, false],
  ["", false],
  ["music", false],
  ["games", false],
];

for (const [input, expected] of SERIES_CASES) {
  assert.equal(
    isSeriesMediaType(input),
    expected,
    `isSeriesMediaType(${JSON.stringify(input)}) should be ${expected}`,
  );
}

// --- The two derivations agree with each other ---
// A series must never map to the movies category, and a movie must never map
// to a series category. These were independent copies before; drift between
// them is the failure mode this asserts against.
for (const raw of ["anime", "movie", "tv", "Movie", "series", "movies"]) {
  const category = searchCategoryForMediaType(raw);
  assert.notEqual(category, null, `${raw} should resolve to a category`);
  if (isSeriesMediaType(raw)) {
    assert.notEqual(category, "movies", `${raw} is a series but mapped to movies`);
  } else {
    assert.equal(category, "movies", `${raw} is not a series so it must map to movies`);
  }
}

console.log("media-type: ok");
