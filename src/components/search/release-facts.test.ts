/**
 * Release-facts rule class: a release may narrate quality, and nothing else.
 *
 * The results surface forbids mechanism — seeders, sizes, Health %, indexer
 * names, SxxExx, raw scene names. What survives is the one thing a viewer
 * picks between: resolution and source tier. These assert that survives and
 * that the forbidden tokens never leak into a fact.
 */
import assert from "node:assert/strict";
import type { TorrentResult } from "@/lib/torrents/types";
import { releaseFacts, releaseQualityName } from "./release-facts";

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

const FORBIDDEN = [
  /\d+\s*seed/i,
  /\bhealth\b/i,
  /\bapibay\b/i,
  /\btorrentscsv\b/i,
  /\bGB\b/,
  /S\d{2}E\d{2}/i,
];

console.log("release-facts: quality only, no mechanism…");

const table: { title: string; facts: string[] }[] = [
  { title: "The.Boys.S05E03.2160p.WEB-DL.h265-ETHEL", facts: ["4K", "WEB-DL"] },
  { title: "Some.Movie.2024.1080p.BluRay.x264", facts: ["1080p", "Blu-ray"] },
  { title: "Old.Show.S01E01.720p.HDTV.x264", facts: ["720p", "HDTV"] },
];

for (const row of table) {
  check(`facts for ${row.title}`, () => {
    assert.deepEqual(releaseFacts(rel(row.title)), row.facts);
  });
}

check("facts never contain mechanism tokens", () => {
  for (const row of table) {
    const joined = releaseFacts(rel(row.title)).join(" ");
    for (const bad of FORBIDDEN) {
      assert.doesNotMatch(joined, bad, `${joined} leaked ${bad}`);
    }
  }
});

check("a quality-less release announces a stable name, not empty", () => {
  const name = releaseQualityName(rel("Just A Plain Name"));
  assert.equal(name, "Standard");
  assert.deepEqual(releaseFacts(rel("Just A Plain Name")), []);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll release-facts tests passed.");
