/**
 * work-match — "is this release actually the work I asked for?"
 *
 * Every fixture in the first block is a REAL row from the quality selector the
 * user screenshotted on the title page for the 2026 film *The Odyssey*. The app
 * offered all of them and played one. They are the regression bar: an audiobook
 * must never be a candidate for a film.
 *
 * Run: npx tsx src/lib/torrents/work-match.test.ts
 */
import assert from "node:assert/strict";
import { filterReleasesForWork, releaseMatchesWork } from "./work-match";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

console.log("torrents/work-match — release ↔ work identity");

const ODYSSEY = { title: "The Odyssey", year: 2026, isSeries: false };

// ── The reported defect, row by row ─────────────────────────────────────────

const REJECTED_FOR_ODYSSEY = [
  // A different film that merely shares the name.
  "The Odyssey (1997) [480p] [bluray] [YTS]",
  "The.Odyssey.1997.DVDRip.XviD-ETRG",
  "The Odyssey (1997) DVDRip Xvid LKRG",
  // A documentary whose name CONTAINS the target's — the case that makes
  // bidirectional containment unusable.
  "Maelstrom: The Odyssey of 'Waterworld' (2018) [1080p] [bluray] [YTS]",
  // An audiobook. Not a film at all.
  "Homer - The Odyssey [Fagles Trans] Read by Ian McKellen",
  "[ WebToolTip.com ] The Odyssey - An Illustrated Guide - A Character-by-C...",
  // A different year again.
  "The.Odyssey.2016.LIMITED.BDRip.x264-BiPOLAR[EtMovies]",
];

for (const title of REJECTED_FOR_ODYSSEY) {
  check(`rejects "${title.slice(0, 52)}"`, () => {
    assert.equal(
      releaseMatchesWork(title, ODYSSEY),
      false,
      "must not be offered as a release of the 2026 film",
    );
  });
}

check("accepts a genuine release of the target film", () => {
  for (const title of [
    "The.Odyssey.2026.1080p.WEB-DL.DDP5.1.H.264-NTb",
    "The Odyssey (2026) [1080p] [WEBRip] [YTS.MX]",
    // One year of slack: scene names sometimes carry a festival/production year.
    "The.Odyssey.2025.2160p.UHD.BluRay.x265-TERMiNAL",
  ]) {
    assert.equal(releaseMatchesWork(title, ODYSSEY), true, title);
  }
});

check("a release with no year is not disproven, so it passes", () => {
  // Absent evidence is not evidence. The name still has to agree.
  assert.equal(releaseMatchesWork("The Odyssey 1080p WEB-DL", ODYSSEY), true);
});

check("an unknown target year cannot reject on year alone", () => {
  const noYear = { title: "The Odyssey", year: null, isSeries: false };
  assert.equal(releaseMatchesWork("The Odyssey (1997) [bluray]", noYear), true);
});

// ── The rule must not break the rest of the catalogue ───────────────────────

check("films that share a name are kept apart by year", () => {
  const dune2021 = { title: "Dune", year: 2021, isSeries: false };
  assert.equal(releaseMatchesWork("Dune.2021.1080p.BluRay.x264", dune2021), true);
  assert.equal(releaseMatchesWork("Dune.1984.1080p.BluRay.x264", dune2021), false);
});

check("a sequel is not its original", () => {
  const dune2021 = { title: "Dune", year: 2021, isSeries: false };
  assert.equal(
    releaseMatchesWork("Dune.Part.Two.2024.1080p.WEB-DL", dune2021),
    false,
    "Part Two is a different work, not a print of Dune",
  );
});

check("a subtitled work accepts its own releases", () => {
  const partTwo = { title: "Dune: Part Two", year: 2024, isSeries: false };
  assert.equal(
    releaseMatchesWork("Dune.Part.Two.2024.2160p.WEB-DL.x265", partTwo),
    true,
  );
});

check("a series release is never a film candidate", () => {
  assert.equal(
    releaseMatchesWork("The Odyssey S01E01 1080p WEB-DL", ODYSSEY),
    false,
  );
});

check("series targets stand down — anime aliases must not be rejected", () => {
  // The grab ladder exists because catalogue names and indexer names disagree.
  // Applying the film test here would reject correct releases.
  const rezero = {
    title: "Re:ZERO -Starting Life in Another World-",
    year: 2016,
    isSeries: true,
  };
  assert.equal(releaseMatchesWork("[SubsPlease] Re Zero - 01 (1080p)", rezero), true);
  const bleach = { title: "BLEACH Sennen Kessen", year: null, isSeries: true };
  assert.equal(
    releaseMatchesWork("Bleach - Thousand-Year Blood War S01E01 1080p", bleach),
    true,
  );
});

// ── The filter ──────────────────────────────────────────────────────────────

check("filter keeps ranker order and drops only the impostors", () => {
  const pool = [
    { title: "Maelstrom: The Odyssey of 'Waterworld' (2018) [1080p]" },
    { title: "The.Odyssey.2026.1080p.WEB-DL" },
    { title: "Homer - The Odyssey [Fagles Trans] Read by Ian McKellen" },
    { title: "The Odyssey (2026) [2160p] [WEBRip]" },
  ];
  const kept = filterReleasesForWork(pool, ODYSSEY);
  assert.deepEqual(
    kept.map((r) => r.title),
    ["The.Odyssey.2026.1080p.WEB-DL", "The Odyssey (2026) [2160p] [WEBRip]"],
  );
});

check("nothing matching returns NOTHING — never the whole pool", () => {
  // The tempting "if empty, fall back to everything" is the bug itself: for a
  // film with no real release that hands the audiobook straight to the player.
  const pool = [
    { title: "The Odyssey (1997) [480p] [bluray] [YTS]" },
    { title: "Homer - The Odyssey [Fagles Trans] Read by Ian McKellen" },
  ];
  assert.deepEqual(filterReleasesForWork(pool, ODYSSEY), []);
});

check("an empty pool stays empty", () => {
  assert.deepEqual(filterReleasesForWork([], ODYSSEY), []);
});

check("a target with no title cannot reject anything", () => {
  assert.equal(releaseMatchesWork("Anything At All", { title: "  " }), true);
});

// ── Trailing junk vs a subtitle: the line the guard must not cross ──────────

check("unrecognised trailing junk does not cost a valid release", () => {
  // The name cleaner strips the tokens it knows. An unknown trailing token
  // must not turn a good release into a "different work" and take playback
  // away — a false reject is an unplayable title.
  for (const title of [
    "The Odyssey 2026 REMUX proper",
    "The Odyssey (2026) FanEdit v2",
    "The.Odyssey.2026.OurGroupTag",
  ]) {
    assert.equal(releaseMatchesWork(title, ODYSSEY), true, title);
  }
});

check("a subtitle continuation is still a different work", () => {
  for (const title of [
    "The Odyssey - An Illustrated Guide",
    "The Odyssey: A Companion Reader",
    "The Odyssey — Behind The Scenes",
  ]) {
    assert.equal(releaseMatchesWork(title, ODYSSEY), false, title);
  }
});

check("a longer word is not the target word", () => {
  assert.equal(
    releaseMatchesWork("The Odysseyssey 2026 1080p", ODYSSEY),
    false,
    "the match must fall on a word boundary",
  );
});

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("  all passed");
