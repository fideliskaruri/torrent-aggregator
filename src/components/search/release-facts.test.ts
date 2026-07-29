/**
 * Release-facts rule class: a release row narrates what a viewer *chooses*
 * between — which episode, resolution, source, size — plus a swarm-strength
 * reading, and nothing else.
 *
 * A picker is not the watch surface: the facts that were stripped there are the
 * whole point here, because a series otherwise renders a dozen identical rows.
 * These assert the distinguishing facts survive, that the middle facts stay
 * curated (no indexer names, Health %, codec/group scene noise, and — because
 * they render as their own elements — no seed text or episode codes leaking
 * into the middle group), and that a row is never announced empty.
 */
import assert from "node:assert/strict";
import type { TorrentResult } from "@/lib/torrents/types";
import {
  episodeLabel,
  releaseFacts,
  releaseQualityName,
  seedStrength,
  sizeFact,
} from "./release-facts";

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

function rel(title: string, overrides: Partial<TorrentResult> = {}): TorrentResult {
  return {
    id: "r1",
    title,
    magnet: "magnet:?xt=urn:btih:abc",
    sizeBytes: 4_400_000_000,
    seeders: 1099,
    leechers: 12,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
    health: 88,
    ...overrides,
  };
}

console.log("release-facts: the facts a chooser needs, curated…");

// ---------------------------------------------------------------------------
// The middle facts a row shows: resolution · source · size (episode + seeders
// render as their own, more prominent elements and are asserted separately).
// ---------------------------------------------------------------------------
const table: {
  title: string;
  overrides?: Partial<TorrentResult>;
  episode: string | null;
  facts: string[];
}[] = [
  {
    title: "The.Boys.S05E03.2160p.WEB-DL.h265-ETHEL",
    episode: "S05E03",
    facts: ["4K", "WEB-DL", "4.1 GB"],
  },
  {
    title: "Some.Movie.2024.1080p.BluRay.x264",
    overrides: { sizeBytes: 8_000_000_000 },
    episode: null,
    facts: ["1080p", "Blu-ray", "7.5 GB"],
  },
  {
    title: "Old.Show.S01E01.720p.HDTV.x264",
    overrides: { sizeBytes: 350_000_000 },
    episode: "S01E01",
    facts: ["720p", "HDTV", "334 MB"],
  },
  {
    title: "Family.Guy.S01.COMPLETE.1080p.WEB-DL",
    overrides: { sizeBytes: 12_000_000_000 },
    episode: "S01 pack",
    facts: ["1080p", "WEB-DL", "11 GB"],
  },
];

for (const row of table) {
  check(`episode label for ${row.title}`, () => {
    assert.equal(episodeLabel(rel(row.title, row.overrides)), row.episode);
  });
  check(`middle facts for ${row.title}`, () => {
    assert.deepEqual(releaseFacts(rel(row.title, row.overrides)), row.facts);
  });
}

// A series returning a row per episode must produce DISTINCT rows — the exact
// "twelve identical 1080p · WEB-DL" defect this rework closes.
check("per-episode releases are distinguishable", () => {
  const names = [
    "Family.Guy.S01E01.1080p.WEB-DL",
    "Family.Guy.S01E02.1080p.WEB-DL",
    "Family.Guy.S01E03.1080p.WEB-DL",
  ];
  const rendered = names.map((n) => {
    const t = rel(n);
    return [episodeLabel(t), ...releaseFacts(t)].join(" · ");
  });
  assert.equal(new Set(rendered).size, names.length, `not distinct: ${rendered}`);
});

// ---------------------------------------------------------------------------
// The middle facts stay curated — mechanism that belongs to its own element
// (seeders, episode codes) or nowhere (indexer, Health, codec, group) must not
// leak into the resolution·source·size group.
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  /\d+\s*seed/i,
  /\bhealth\b/i,
  /\bapibay\b/i,
  /\btorrentscsv\b/i,
  /\b(?:x264|x265|h\.?265|hevc)\b/i,
  /\b(?:ETHEL|RARBG|YTS|YIFY)\b/,
  /S\d{2}E\d{2}/i,
];

check("middle facts never contain seeders, episode codes, or scene noise", () => {
  for (const row of table) {
    const joined = releaseFacts(rel(row.title, row.overrides)).join(" ");
    for (const bad of FORBIDDEN) {
      assert.doesNotMatch(joined, bad, `${joined} leaked ${bad}`);
    }
  }
});

check("facts are a list, not a joined blob (no adjacent-text nodes)", () => {
  const facts = releaseFacts(rel("The.Boys.S05E03.2160p.WEB-DL-ETHEL"));
  assert.ok(Array.isArray(facts));
  for (const f of facts) assert.doesNotMatch(f, /·/, "a fact must not embed a separator");
});

// ---------------------------------------------------------------------------
// Size: exact bytes preferred, source label as fallback, omitted when unknown.
// ---------------------------------------------------------------------------
check("size prefers exact bytes and falls back to a label", () => {
  assert.equal(sizeFact(rel("x", { sizeBytes: 2_100_000_000 })), "2.0 GB");
  assert.equal(
    sizeFact(rel("x", { sizeBytes: null, sizeLabel: "1.4 GiB" })),
    "1.4 GiB",
  );
  assert.equal(sizeFact(rel("x", { sizeBytes: null, sizeLabel: undefined })), null);
  assert.equal(sizeFact(rel("x", { sizeBytes: 0 })), null);
});

// ---------------------------------------------------------------------------
// Swarm strength: the reading that says whether Play will actually start.
// ---------------------------------------------------------------------------
check("seed strength tiers a swarm and spells its count", () => {
  const strong = seedStrength(rel("x", { seeders: 1099 }));
  assert.deepEqual(strong, { count: 1099, level: "strong", label: "1099 seeders" });

  assert.equal(seedStrength(rel("x", { seeders: 12 })).level, "fair");
  assert.equal(seedStrength(rel("x", { seeders: 4 })).level, "weak");

  const one = seedStrength(rel("x", { seeders: 1 }));
  assert.deepEqual(one, { count: 1, level: "weak", label: "1 seeder" });

  // A negative or NaN swarm is clamped, never announced as a broken count.
  assert.deepEqual(seedStrength(rel("x", { seeders: -3 })), {
    count: 0,
    level: "weak",
    label: "0 seeders",
  });
});

// ---------------------------------------------------------------------------
// The accessible name a row's actions announce.
// ---------------------------------------------------------------------------
check("quality name leads with the episode a viewer is about to play", () => {
  assert.equal(
    releaseQualityName(rel("The.Boys.S05E03.2160p.WEB-DL.h265-ETHEL")),
    "S05E03 · 4K · WEB-DL · 4.1 GB",
  );
});

check("a bare, size-less release announces a stable name, not empty", () => {
  const bare = rel("Just A Plain Name", { sizeBytes: null, sizeLabel: undefined });
  assert.equal(releaseQualityName(bare), "Standard");
  assert.deepEqual(releaseFacts(bare), []);
  assert.equal(episodeLabel(bare), null);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll release-facts tests passed.");
