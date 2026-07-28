/**
 * I17 — media type is authoritative, so a downstream rail can split movie from
 * series without guessing.
 *
 * Three functions cooperate:
 *   - `normalizeMediaType` maps every spelling seen in stored rows and URLs
 *     ("movies", "series", "show", "film") to one of three canonical types, and
 *     an unrecognised value to `null` rather than a silent default.
 *   - `isSeriesMediaType` answers the one question a rail split actually asks:
 *     is this episodic (tv/anime) or not (movie)?
 *   - `resolveWorkMediaType` reconciles a *declared* type with what the release
 *     name reveals: a release that is plainly episodic (S01E05) is a series even
 *     if the feed mislabelled it, and it is never left untyped when we can tell.
 *
 * The table mixes canonical, aliased, mislabelled and junk inputs so a
 * regression that reintroduces a default, or that lets a movie fall on the
 * series side of the split, fails here.
 */
import assert from "node:assert/strict";
import {
  normalizeMediaType,
  isSeriesMediaType,
  type MediaType,
} from "@/lib/metadata/media-type";
import { resolveWorkMediaType } from "@/lib/catalog/works";

// ---------------------------------------------------------------------------
// normalizeMediaType — canonical, aliases, and the unknown → null contract
// ---------------------------------------------------------------------------

const NORMALIZE_CASES: Array<{ input: string | null | undefined; expect: MediaType | null }> = [
  { input: "movie", expect: "movie" },
  { input: "movies", expect: "movie" },
  { input: "film", expect: "movie" },
  { input: "MOVIE", expect: "movie" },
  { input: "  Movies  ", expect: "movie" },
  { input: "tv", expect: "tv" },
  { input: "series", expect: "tv" },
  { input: "show", expect: "tv" },
  { input: "tvshow", expect: "tv" },
  { input: "anime", expect: "anime" },
  { input: "", expect: null },
  { input: null, expect: null },
  { input: undefined, expect: null },
  { input: "person", expect: null },
  { input: "documentary", expect: null },
];

for (const { input, expect } of NORMALIZE_CASES) {
  assert.equal(
    normalizeMediaType(input),
    expect,
    `normalizeMediaType(${JSON.stringify(input)}) → ${expect}`,
  );
}

// ---------------------------------------------------------------------------
// isSeriesMediaType — the movie/series boundary the rail split relies on
// ---------------------------------------------------------------------------

const SERIES_CASES: Array<{ input: string | null | undefined; series: boolean }> = [
  { input: "movie", series: false },
  { input: "movies", series: false },
  { input: "film", series: false },
  { input: "tv", series: true },
  { input: "series", series: true },
  { input: "anime", series: true },
  { input: null, series: false },
  { input: "person", series: false },
];

for (const { input, series } of SERIES_CASES) {
  assert.equal(
    isSeriesMediaType(input),
    series,
    `isSeriesMediaType(${JSON.stringify(input)}) → ${series}`,
  );
}

// ---------------------------------------------------------------------------
// resolveWorkMediaType — declared type reconciled with episodic evidence
// ---------------------------------------------------------------------------

const RESOLVE_CASES: Array<{
  declared: string | null | undefined;
  isSeries: boolean;
  expect: MediaType | null;
  why: string;
}> = [
  { declared: "movie", isSeries: false, expect: "movie", why: "a film stays a film" },
  { declared: "tv", isSeries: true, expect: "tv", why: "a series stays a series" },
  { declared: "anime", isSeries: true, expect: "anime", why: "anime is already episodic — kept" },
  // The release name overrides a wrong or missing label when it is plainly episodic.
  { declared: "movie", isSeries: true, expect: "tv", why: "S01E05 evidence beats a 'movie' label" },
  { declared: null, isSeries: true, expect: "tv", why: "episodic with no label → tv, not null" },
  { declared: "", isSeries: true, expect: "tv", why: "episodic with blank label → tv" },
  { declared: "person", isSeries: true, expect: "tv", why: "unusable label + episodic → tv" },
  // Not episodic and no usable label: we do not guess. Null is dropped upstream.
  { declared: null, isSeries: false, expect: null, why: "no label, not episodic → null (dropped, not defaulted)" },
  { declared: "person", isSeries: false, expect: null, why: "junk label, not episodic → null" },
  { declared: "movies", isSeries: false, expect: "movie", why: "aliased label normalises" },
];

for (const { declared, isSeries, expect, why } of RESOLVE_CASES) {
  assert.equal(
    resolveWorkMediaType(declared, isSeries),
    expect,
    `resolveWorkMediaType(${JSON.stringify(declared)}, ${isSeries}) → ${expect} — ${why}`,
  );
}

console.log("media-type: ok");
