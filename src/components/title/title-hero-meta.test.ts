/**
 * The hero metadata helpers must never fabricate.
 *
 * Every one of these returns `null`/drops a piece for absent input, because the
 * SILO-style hero omits a line rather than printing "0.0", "()", "NaN" or a
 * placeholder date. The release-date formatter is deliberately locale-free so a
 * server render and a browser hydration cannot disagree.
 */
import assert from "node:assert/strict";
import {
  formatReleaseDate,
  metaLine,
  releaseYear,
  seasonRuntimeLabel,
  tmdbScore,
} from "./title-hero-meta";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

console.log("formatReleaseDate…");

check('a bare YYYY-MM-DD becomes "Month D, YYYY"', () => {
  assert.equal(formatReleaseDate("2023-05-04"), "May 4, 2023");
});
check("a full ISO string reads only the leading date", () => {
  assert.equal(formatReleaseDate("2021-12-25T00:00:00.000Z"), "December 25, 2021");
});
check("a single-digit day is not zero-padded", () => {
  assert.equal(formatReleaseDate("2020-01-09"), "January 9, 2020");
});
check("null / empty / garbage yield null, never a placeholder", () => {
  for (const bad of [null, undefined, "", "not-a-date", "2020/01/01"]) {
    assert.equal(formatReleaseDate(bad as string), null, `input ${JSON.stringify(bad)}`);
  }
});
check("an impossible month or day is rejected", () => {
  assert.equal(formatReleaseDate("2020-13-01"), null);
  assert.equal(formatReleaseDate("2020-00-01"), null);
  assert.equal(formatReleaseDate("2020-05-00"), null);
});

console.log("tmdbScore…");

check("a rating with votes prints the count in parentheses", () => {
  assert.equal(tmdbScore(8.34, 1234), "8.3 (1234)");
});
check("a rating with no votes drops the (votes) entirely", () => {
  assert.equal(tmdbScore(7.5, null), "7.5");
  assert.equal(tmdbScore(7.5, 0), "7.5");
});
check("a zero / null rating is treated as unrated (null)", () => {
  assert.equal(tmdbScore(0, 500), null);
  assert.equal(tmdbScore(null, 500), null);
});

console.log("seasonRuntimeLabel…");

check("a series pluralises seasons and singularises one season", () => {
  assert.equal(seasonRuntimeLabel({ isSeries: true, seasonCount: 3 }), "3 Seasons");
  assert.equal(seasonRuntimeLabel({ isSeries: true, seasonCount: 1 }), "1 Season");
});
check("a series with no/zero season count yields null", () => {
  assert.equal(seasonRuntimeLabel({ isSeries: true, seasonCount: null }), null);
  assert.equal(seasonRuntimeLabel({ isSeries: true, seasonCount: 0 }), null);
});
check("a film uses its runtime label, or null when absent", () => {
  assert.equal(
    seasonRuntimeLabel({ isSeries: false, seasonCount: null, runtimeLabel: "2h 46m" }),
    "2h 46m",
  );
  assert.equal(seasonRuntimeLabel({ isSeries: false, seasonCount: null }), null);
});

console.log("releaseYear…");

check("the four-digit year is read from a real date", () => {
  assert.equal(releaseYear("2024-02-27"), 2024);
  assert.equal(releaseYear("2023-05-04T00:00:00Z"), 2023);
});
check("a missing or malformed date yields null", () => {
  for (const bad of [null, undefined, "", "nope", "24-02-27"]) {
    assert.equal(releaseYear(bad as string), null, `input ${JSON.stringify(bad)}`);
  }
});

console.log("metaLine…");

check("a full series line joins score, year and seasons with · ", () => {
  assert.equal(
    metaLine({ rating: 8.3, voteCount: 1234, year: 2023, isSeries: true, seasonCount: 3 }),
    "8.3 (1234) · 2023 · 3 Seasons",
  );
});
check("an absent score drops the leading piece, no dangling separator", () => {
  assert.equal(
    metaLine({ rating: 0, voteCount: null, year: 2023, isSeries: true, seasonCount: 2 }),
    "2023 · 2 Seasons",
  );
});
check("a film line uses the runtime tail", () => {
  assert.equal(
    metaLine({
      rating: 7.9,
      voteCount: 900,
      year: 2024,
      isSeries: false,
      seasonCount: null,
      runtimeLabel: "2h 46m",
    }),
    "7.9 (900) · 2024 · 2h 46m",
  );
});
check("a bare year with nothing else is still a valid single-piece line", () => {
  assert.equal(
    metaLine({ rating: null, voteCount: null, year: 2019, isSeries: false, seasonCount: null }),
    "2019",
  );
});

if (failures > 0) {
  console.error(`\n${failures} FAIL`);
  process.exit(1);
}
console.log("\nAll title-hero-meta tests passed.");
