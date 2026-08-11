/**
 * Work-collapsing tests for the browse rails.
 *
 * The rule under test: **a rail shows works, not releases.** Two releases of
 * one film are one card; two films that merely share a title are two, and the
 * title printed on the card comes from the same work derivation that did the
 * collapse.
 *
 * Table-driven over diverse inputs per AGENTS.md — different films, different
 * series, different sources of duplication (resolution, encode, release group,
 * episode number) — because the rule is about release-vs-work identity in
 * general, not about any one title that once appeared twice.
 *
 * This file imports `./collapse` only, which has no Prisma dependency, so it
 * runs without a database or a dev server.
 *
 * Run: npx tsx src/lib/browse/collapse.test.ts
 */
import assert from "node:assert/strict";
import { collapseReleasesByWork, type CollapsibleRelease } from "./collapse";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

/** Minute `n` after an arbitrary epoch, so "newer" is unambiguous. */
function at(minute: number): Date {
  return new Date(Date.UTC(2024, 0, 1, 0, minute, 0));
}

function release(
  name: string,
  minute: number,
  hasArtwork = false,
): CollapsibleRelease<string> {
  return { name, sortAt: at(minute), hasArtwork, value: name };
}

// ---------------------------------------------------------------------------
// One work, many releases → one card
// ---------------------------------------------------------------------------

const ONE_CARD_CASES: Array<{ name: string; releases: string[] }> = [
  {
    name: "two resolutions of one film",
    releases: [
      "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX",
      "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP",
    ],
  },
  {
    name: "two encodes of one film",
    releases: [
      "Oppenheimer.2023.1080p.WEBRip.x265-RARBG",
      "Oppenheimer.2023.1080p.BluRay.x264.AAC-YTS",
    ],
  },
  {
    name: "same release grabbed twice from different groups",
    releases: [
      "The.Batman.2022.2160p.UHD.BluRay.x265-TERMINAL",
      "The.Batman.2022.2160p.UHD.BluRay.x265-SURCODE",
    ],
  },
  {
    name: "two episodes of one series",
    releases: [
      "Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND",
      "Breaking.Bad.S05E15.1080p.BluRay.x264-DEMAND",
    ],
  },
  {
    name: "episode and season pack of one series",
    releases: [
      "Family.Guy.S21E01.720p.WEB.h264-KOGi",
      "Family.Guy.S21.COMPLETE.1080p.WEB.h264-GROUP",
    ],
  },
  {
    name: "anime with absolute and seasonal numbering",
    releases: [
      "[SubsPlease] One Piece - 1233 (1080p) [ABCD1234].mkv",
      "[Erai-raws] One Piece - 1234 [1080p][Multiple Subtitle]",
    ],
  },
  {
    name: "site-prefixed and clean copies of one film",
    releases: [
      "www.SomeTracker.to - Inside.Out.2.2024.1080p.WEB-DL.x264",
      "Inside.Out.2.2024.2160p.WEB-DL.HDR.x265",
    ],
  },
  {
    name: "punctuated and site-prefixed episodes of one show",
    releases: [
      "Rick.and.Morty.S01E01.1080p.WEB-DL.x264-GROUP",
      "www.UIndex.org - Rick and Morty S01E02 1080p WEB-DL x264",
    ],
  },
  {
    name: "two qualities of one numbered show",
    releases: [
      "Instant Harness 4242.S01E02.1080p.WEB-DL-GROUPA.mp4",
      "Instant Harness 4242.S01E02.2160p.WEB-DL-GROUPB.mp4",
    ],
  },
];

for (const tc of ONE_CARD_CASES) {
  check(`one card: ${tc.name}`, () => {
    const collapsed = collapseReleasesByWork(
      tc.releases.map((n, i) => release(n, i)),
    );
    assert.equal(
      collapsed.length,
      1,
      `expected 1 card, got ${collapsed.length}: ${collapsed
        .map((c) => c.name)
        .join(" | ")}`,
    );
    assert.equal(
      collapsed[0].releaseCount,
      tc.releases.length,
      "releaseCount must count every member of the group",
    );
    assert.equal(
      typeof collapsed[0].title,
      "string",
      "the collapser must return the visible card title with the grouping key",
    );
    assert.ok(
      !/^s\d{1,3}e\d{1,4}$/i.test(collapsed[0].title),
      "the visible card title must be a work name, not an episode code",
    );
  });
}

// ---------------------------------------------------------------------------
// Distinct works stay distinct
// ---------------------------------------------------------------------------

const DISTINCT_CASES: Array<{ name: string; releases: string[]; cards: number }> = [
  {
    name: "same film title, different years",
    releases: [
      "Dune.1984.1080p.BluRay.x264-AMIABLE",
      "Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX",
    ],
    cards: 2,
  },
  {
    name: "remake and original",
    releases: [
      "Total.Recall.1990.1080p.BluRay.x264-GROUP",
      "Total.Recall.2012.1080p.BluRay.x264-GROUP",
    ],
    cards: 2,
  },
  {
    name: "sequel is not its predecessor",
    releases: [
      "Dune.Part.Two.2024.1080p.WEB-DL.x264",
      "Dune.2021.1080p.WEB-DL.x264",
    ],
    cards: 2,
  },
  {
    name: "different series",
    releases: [
      "The.Simpsons.S34E01.1080p.WEB.h264-CAKES",
      "Family.Guy.S21E01.1080p.WEB.h264-CAKES",
    ],
    cards: 2,
  },
  {
    name: "series and a film that shares its name",
    releases: [
      "Fargo.S05E01.1080p.WEB.h264-GROUP",
      "Fargo.1996.1080p.BluRay.x264-GROUP",
    ],
    cards: 2,
  },
];

for (const tc of DISTINCT_CASES) {
  check(`distinct: ${tc.name}`, () => {
    const collapsed = collapseReleasesByWork(
      tc.releases.map((n, i) => release(n, i)),
    );
    assert.equal(
      collapsed.length,
      tc.cards,
      `expected ${tc.cards} cards, got ${collapsed.length}: ${collapsed
        .map((c) => c.name)
        .join(" | ")}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Which member survives
// ---------------------------------------------------------------------------

check("collapsing keeps the newest member when none has artwork", () => {
  const collapsed = collapseReleasesByWork([
    release("Sicario.2015.720p.BluRay.x264-GROUP", 1),
    release("Sicario.2015.2160p.WEB-DL.x265-GROUP", 9),
    release("Sicario.2015.1080p.BluRay.x264-GROUP", 5),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(
    collapsed[0].value,
    "Sicario.2015.2160p.WEB-DL.x265-GROUP",
    "the newest release must survive so the rail keeps its recency ordering",
  );
});

check("collapsing keeps the member with artwork over a newer one without", () => {
  const collapsed = collapseReleasesByWork([
    release("Arrival.2016.1080p.BluRay.x264-GROUP", 1, true),
    release("Arrival.2016.2160p.WEB-DL.x265-GROUP", 9, false),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(
    collapsed[0].value,
    "Arrival.2016.1080p.BluRay.x264-GROUP",
    "a collapse must never drop the only member that has a poster",
  );
});

check("a preferred representative wins despite being older", () => {
  const collapsed = collapseReleasesByWork([
    {
      name: "The.Bear.S01E04.1080p.WEB.h264-GROUP",
      sortAt: at(9),
      value: "single",
    },
    {
      name: "The.Bear.S01.COMPLETE.1080p.WEB.h264-GROUP",
      sortAt: at(1),
      prefer: true,
      value: "pack",
    },
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(
    collapsed[0].value,
    "pack",
    "an explicit representative preference must not be smuggled through a fake timestamp",
  );
});

check("a bridge release preserves the best absorbed representative", () => {
  const collapsed = collapseReleasesByWork([
    {
      name: "Bridge.Show.S01E01.1080p.WEB.h264-GROUP",
      workKey: "legacy-bridge-show",
      sortAt: at(9),
      value: "plain",
    },
    {
      name: "Canonical Bridge",
      identityKey: "provider:bridge-show",
      workKey: "canonical-bridge",
      sortAt: at(1),
      hasArtwork: true,
      value: "artwork",
    },
    {
      name: "Bridge.Show.S01.COMPLETE.1080p.WEB.h264-GROUP",
      identityKey: "provider:bridge-show",
      workKey: "legacy-bridge-show",
      workTitle: "Canonical Bridge",
      sortAt: at(5),
      value: "bridge",
    },
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(
    collapsed[0].value,
    "artwork",
    "merging two existing buckets must retain the only representative with artwork",
  );
});

check("among members with artwork, the newest still wins", () => {
  const collapsed = collapseReleasesByWork([
    release("Heat.1995.1080p.BluRay.x264-GROUP", 2, true),
    release("Heat.1995.2160p.UHD.BluRay.x265-GROUP", 8, true),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].value, "Heat.1995.2160p.UHD.BluRay.x265-GROUP");
});

// ---------------------------------------------------------------------------
// Ordering and edge cases
// ---------------------------------------------------------------------------

check("first-seen order is preserved, so a newest-first query stays sorted", () => {
  const collapsed = collapseReleasesByWork([
    release("Nosferatu.2024.2160p.WEB-DL.x265", 30),
    release("The.Bear.S03E01.1080p.WEB.h264", 20),
    release("Nosferatu.2024.1080p.WEB-DL.x264", 25),
    release("Shogun.S01E01.1080p.WEB.h264", 10),
  ]);
  assert.deepEqual(
    collapsed.map((c) => c.value.split(".")[0]),
    ["Nosferatu", "The", "Shogun"],
    "groups must appear in the order they were first seen",
  );
});

check("blank and whitespace-only names are dropped, not carded", () => {
  const collapsed = collapseReleasesByWork([
    release("", 1),
    release("   ", 2),
    release("Alien.1979.1080p.BluRay.x264-GROUP", 3),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].value, "Alien.1979.1080p.BluRay.x264-GROUP");
});

check("an empty input collapses to an empty rail, not a crash", () => {
  assert.deepEqual(collapseReleasesByWork([]), []);
});

check("a single release yields one card with releaseCount 1", () => {
  const collapsed = collapseReleasesByWork([
    release("Poor.Things.2023.1080p.WEB-DL.x264-GROUP", 1),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].releaseCount, 1);
});

check("episode-only release names do not become visible card titles", () => {
  const collapsed = collapseReleasesByWork([release("S01E02", 1)]);
  assert.equal(collapsed.length, 1);
  assert.equal(
    collapsed[0].title,
    "Unknown title",
    "an episode code is not a work name; falling back to it recreates the Continue Watching bug",
  );
});

check("numbered series names keep their number in the work key and title", () => {
  const collapsed = collapseReleasesByWork([
    release("Instant Harness 4242.S01E02.1080p.WEB-DL-GROUPA.mp4", 1),
    release("Instant Harness 4343.S01E02.1080p.WEB-DL-GROUPA.mp4", 2),
  ]);
  assert.deepEqual(
    collapsed.map((work) => work.title),
    ["Instant Harness 4242", "Instant Harness 4343"],
    "a numeric token before an explicit season/episode marker is part of the show, not an absolute episode residue",
  );
});

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall collapse tests passed");
