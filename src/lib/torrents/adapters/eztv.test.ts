/**
 * EZTV ignores a free-text `q` parameter — passing `q=family guy` returns the
 * site's latest uploads, boxing included — so the show title must be resolved
 * to an IMDb id, and the episode filtered locally. These helpers are where that
 * goes wrong quietly, so they are pinned.
 */
import assert from "node:assert/strict";
import {
  episodeFromQuery,
  showTitleFromQuery,
} from "@/lib/torrents/adapters/eztv";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log("showTitleFromQuery: strip episode/quality noise…");

for (const [input, expected] of [
  ["Family Guy S03E03", "Family Guy"],
  ["Family Guy s03e03", "Family Guy"],
  ["Family Guy S03", "Family Guy"],
  ["Family Guy Season 3 complete", "Family Guy"],
  ["The.Bear.S03E01.1080p", "The Bear"],
  ["Severance 1080p WEB", "Severance"],
  ["Breaking Bad", "Breaking Bad"],
] as const) {
  check(`"${input}" → "${expected}"`, () => {
    assert.equal(showTitleFromQuery(input), expected);
  });
}

check("a title containing a digit-run is not truncated mid-word", () => {
  // "S" followed by digits only counts as a season marker on a word boundary.
  assert.equal(showTitleFromQuery("Stranger Things"), "Stranger Things");
});

check("dot-separated scene markers are stripped, not leaked into TMDB", () => {
  // Separators must be normalised before the SxxEyy strip, or "S.05.E.10"
  // survives and TMDB is asked about a title that does not exist.
  assert.equal(showTitleFromQuery("S.W.A.T.S.05.E.10"), "S W A T");
  assert.equal(showTitleFromQuery("The.Bear.S.03.E.01"), "The Bear");
});

check("a numeric show title survives", () => {
  assert.equal(showTitleFromQuery("1883"), "1883");
  assert.equal(showTitleFromQuery("86 S01E01"), "86");
});

check("an empty query stays empty rather than becoming a wildcard", () => {
  assert.equal(showTitleFromQuery("   "), "");
});

console.log("\nepisodeFromQuery: what the hunt actually wants…");

check("SxxEyy yields both season and episode", () => {
  assert.deepEqual(episodeFromQuery("Family Guy S03E03"), {
    season: 3,
    episode: 3,
  });
});

check("a season-only query yields no episode, so packs are not filtered out", () => {
  assert.deepEqual(episodeFromQuery("Family Guy S03"), { season: 3 });
  assert.deepEqual(episodeFromQuery("Family Guy Season 3"), { season: 3 });
});

check("a bare show name asks for nothing in particular", () => {
  assert.equal(episodeFromQuery("Family Guy"), null);
});

check("three-digit episodes survive (long-running shows)", () => {
  assert.deepEqual(episodeFromQuery("One Piece S01E1089"), {
    season: 1,
    episode: 1089,
  });
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll EZTV query-parsing tests passed.");
