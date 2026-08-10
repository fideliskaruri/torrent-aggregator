/**
 * Search UI product-shape tests.
 *
 * These deliberately pin two seams that have regressed:
 *  1. the empty search experience must never resurrect frozen marketing copy or
 *     fake starter queries (the sin cleaned up in Z4); and
 *  2. `/search` must NOT render a second, standalone search UI with its own
 *     input — search is one overlay, opened from anywhere. The route is the
 *     durable deep-link that opens that shared overlay without erasing `q`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const searchPage = fs.readFileSync(
  path.join(root, "src", "app", "search", "page.tsx"),
  "utf8",
);
const searchBar = fs.readFileSync(
  path.join(root, "src", "components", "search", "search-bar.tsx"),
  "utf8",
);

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

console.log("search-ui: empty state…");

check("empty search page has no marketing hero or algorithm explainer", () => {
  assert.doesNotMatch(searchPage, /Every indexer, one query/i);
  assert.doesNotMatch(searchPage, /Search\.\s*[\s\S]*Monitor\.\s*Grab\.\s*Download\./i);
  assert.doesNotMatch(searchPage, /ranked by how close each release/i);
});

check("empty search page has no fake starter queries", () => {
  assert.doesNotMatch(searchPage, /\bSTARTERS\b/);
  for (const junk of ["q=anime", "q=2024", "q=flac", "q=pc"]) {
    assert.doesNotMatch(searchPage, new RegExp(junk, "i"));
  }
});

check("/search hosts the single overlay without erasing the durable URL", () => {
  // It opens the one shared search overlay…
  assert.match(searchPage, /openSearchOverlay/);
  // …while preserving the shareable /search?q=… URL…
  assert.match(searchPage, /preserveUrl:\s*true/);
  assert.doesNotMatch(searchPage, /router\.replace|redirect\(/);
  // …so it must not mount its own search input, visible launcher copy, or the
  // old results firehose.
  assert.doesNotMatch(searchPage, /<SearchBar\b/);
  assert.doesNotMatch(searchPage, /<SearchResults\b/);
  assert.doesNotMatch(searchPage, /Search is open|Start typing to find anything|Reopen search/);
  assert.match(searchPage, /return null;/);
});

check("search category picker exposes exactly title-first product categories", () => {
  assert.match(searchBar, /Anime/);
  assert.match(searchBar, /Movies/);
  assert.match(searchBar, /Series/);
  for (const nonVideo of ["All", "TV", "Music", "Games", "Apps", "Books"]) {
    assert.doesNotMatch(searchBar, new RegExp(`label:\\s*"${nonVideo}"`));
  }
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}

console.log("\nAll search-ui tests passed.");
