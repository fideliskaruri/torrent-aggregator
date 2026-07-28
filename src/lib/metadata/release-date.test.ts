/**
 * I10 — release-date extraction, across the three provider shapes.
 *
 * The render layer future-gates a card by calling `releaseStatus()` on a
 * `releaseDate` string. This asserts the three functions that *produce* that
 * string agree on one canonical form (`YYYY-MM-DD`, year-only → `YYYY-01-01`)
 * and — critically — never invent a date: a missing or implausible value is
 * `null`, and `null` is never gated.
 *
 *   - `parseReleaseDate`  (catalog/tmdb): the tolerant catalog parser.
 *   - `normalizeTmdbDate` (metadata/tmdb): the search-enrichment parser.
 *   - `anilistStartDate`  (metadata/anilist): AniList's `{year,month,day}`.
 *
 * And `parseTmdbList` is exercised end-to-end so a movie's `release_date` and a
 * series' `first_air_date` both land on the row as a real date.
 */
import assert from "node:assert/strict";
import { parseReleaseDate, releaseDateToDate, parseTmdbList } from "@/lib/catalog/tmdb";
import { normalizeTmdbDate } from "@/lib/metadata/tmdb";
import { anilistStartDate } from "@/lib/metadata/anilist";

// ---------------------------------------------------------------------------
// parseReleaseDate — full ISO, year-only, and every way of being nothing
// ---------------------------------------------------------------------------

const PARSE_CASES: Array<{ input: unknown; expect: string | null; why: string }> = [
  { input: "2026-05-01", expect: "2026-05-01", why: "full ISO passes through" },
  { input: "2026-05-01 (limited)", expect: "2026-05-01", why: "trailing text after the day is tolerated" },
  { input: "2026", expect: "2026-01-01", why: "year-only → Jan 1 placeholder" },
  { input: "1999", expect: "1999-01-01", why: "past year-only still parses" },
  { input: "", expect: null, why: "empty is unknown, not a date" },
  { input: "   ", expect: null, why: "whitespace is unknown" },
  { input: null, expect: null, why: "null stays null (never gated)" },
  { input: undefined, expect: null, why: "undefined stays null" },
  { input: 2026, expect: null, why: "a number is not a provider date string" },
  { input: "TBA", expect: null, why: "junk is not a fabricated date" },
  { input: "3500", expect: null, why: "implausible future year is rejected — no invented year" },
  { input: "1500", expect: null, why: "implausible past year is rejected" },
  { input: "2026-13-40", expect: null, why: "impossible month/day is rejected" },
  { input: "2026-00-00", expect: null, why: "zero month/day is rejected" },
];

for (const { input, expect, why } of PARSE_CASES) {
  assert.equal(
    parseReleaseDate(input),
    expect,
    `parseReleaseDate(${JSON.stringify(input)}) → ${expect} — ${why}`,
  );
}

// releaseDateToDate anchors at UTC midnight and round-trips the same calendar day.
assert.equal(releaseDateToDate("2026-01-01")?.toISOString(), "2026-01-01T00:00:00.000Z");
assert.equal(releaseDateToDate("2026-05-01")?.toISOString(), "2026-05-01T00:00:00.000Z");
assert.equal(releaseDateToDate(null), null, "null in → null out");
assert.equal(releaseDateToDate("nonsense"), null, "unparseable → null, never throws");

// ---------------------------------------------------------------------------
// parseTmdbList — a movie release_date and a series first_air_date both land
// ---------------------------------------------------------------------------

const movieList = parseTmdbList(
  { results: [{ id: 1, title: "Toy Story 5", release_date: "2026-06-19", media_type: "movie" }] },
  "movie",
);
assert.equal(movieList.length, 1, "one movie row");
assert.equal(movieList[0].releaseDate, "2026-06-19", "movie takes release_date");
assert.equal(movieList[0].year, 2026, "and the year is derived from it");

const seriesList = parseTmdbList(
  { results: [{ id: 2, name: "Lanterns", first_air_date: "2026-04-01", media_type: "tv" }] },
  "tv",
);
assert.equal(seriesList.length, 1, "one series row");
assert.equal(seriesList[0].releaseDate, "2026-04-01", "series takes first_air_date");
assert.equal(seriesList[0].mediaType, "tv", "and is typed as a series");

const undated = parseTmdbList(
  { results: [{ id: 3, title: "Some Movie", media_type: "movie" }] },
  "movie",
);
assert.equal(undated[0].releaseDate, null, "a row with no date stays null (ungated)");

// ---------------------------------------------------------------------------
// normalizeTmdbDate — detail-shape movie/series, missing → null
// ---------------------------------------------------------------------------

const NORMALIZE_CASES: Array<{
  release: string | undefined;
  air: string | undefined;
  expect: string | null;
  why: string;
}> = [
  { release: "2026-05-01", air: undefined, expect: "2026-05-01", why: "movie release_date" },
  { release: undefined, air: "2024-09-01", expect: "2024-09-01", why: "series first_air_date" },
  { release: "2026-05-01", air: "2024-09-01", expect: "2026-05-01", why: "release_date wins when both present" },
  { release: undefined, air: undefined, expect: null, why: "neither → null" },
  { release: "", air: "", expect: null, why: "empty → null" },
  { release: "2026", air: undefined, expect: null, why: "detail dates are full ISO; a bare year is not accepted here" },
  { release: "3500-01-01", air: undefined, expect: null, why: "implausible year rejected — no invented year" },
];

for (const { release, air, expect, why } of NORMALIZE_CASES) {
  assert.equal(
    normalizeTmdbDate(release, air),
    expect,
    `normalizeTmdbDate(${JSON.stringify(release)}, ${JSON.stringify(air)}) → ${expect} — ${why}`,
  );
}

// ---------------------------------------------------------------------------
// anilistStartDate — full date, partial (day unknown), year-only, missing
// ---------------------------------------------------------------------------

const ANILIST_CASES: Array<{
  start: { year?: number | null; month?: number | null; day?: number | null } | null | undefined;
  expect: string | null;
  why: string;
}> = [
  { start: { year: 2025, month: 4, day: 6 }, expect: "2025-04-06", why: "full date composes" },
  { start: { year: 2025, month: 4, day: null }, expect: "2025-01-01", why: "no day → year placeholder" },
  { start: { year: 2025, month: null, day: null }, expect: "2025-01-01", why: "year only → Jan 1" },
  { start: { year: 2025 }, expect: "2025-01-01", why: "year only (fields absent)" },
  { start: { year: null }, expect: null, why: "no year → null" },
  { start: null, expect: null, why: "no startDate → null" },
  { start: undefined, expect: null, why: "undefined → null" },
  { start: { year: 3500, month: 1, day: 1 }, expect: null, why: "implausible year rejected" },
  { start: { year: 2025, month: 13, day: 40 }, expect: "2025-01-01", why: "impossible month/day falls back to year placeholder" },
];

for (const { start, expect, why } of ANILIST_CASES) {
  assert.equal(
    anilistStartDate(start),
    expect,
    `anilistStartDate(${JSON.stringify(start)}) → ${expect} — ${why}`,
  );
}

console.log("release-date: ok");
