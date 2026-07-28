/**
 * The product shape of the search results surface, pinned against the files.
 *
 * The results rework has one thesis: title-centric cards with two actions
 * (Play, Download), no mechanism, no chrome. These assertions fail if any of
 * the stripped tokens crawl back — seed counts, sizes, Health %, indexer
 * names, SxxExx, the All/Packs/Episodes tabs, the density/filters/refresh
 * toolbar, the range count, "cached", the retention helper sentence, or the
 * word "Stream".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readRaw = (p: string) =>
  fs.readFileSync(path.join(root, "src", ...p.split("/")), "utf8");

/**
 * These rules are about what the *rendered* surface says, not what the source
 * prose documents. A comment may legitimately name a banished token ("no
 * seeders, sizes, Health %") while explaining the subtraction, so strip
 * comments before scanning for mechanism leaks.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const read = (p: string) => stripComments(readRaw(p));

const searchResults = read("components/search/search-results.tsx");
const titleCard = read("components/search/title-result-card.tsx");
const releaseRow = read("components/search/torrent-card.tsx");
const overlay = read("components/search/search-overlay.tsx");
const header = read("components/layout/header.tsx");
const shortcuts = read("hooks/use-keyboard-shortcuts.ts");

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

console.log("search-results-flow: title-centric, two actions, no mechanism…");

// ---------------------------------------------------------------------------
// I23 — one card per work, best match first
// ---------------------------------------------------------------------------
check("results render grouped title cards, not raw torrent rows", () => {
  assert.match(searchResults, /groupTitles/);
  assert.match(searchResults, /TitleResultsList/);
  assert.doesNotMatch(searchResults, /data\.results\.map/);
});

check("a best-match card is marked featured", () => {
  assert.match(titleCard, /Best match/);
  assert.match(titleCard, /featured/);
});

// ---------------------------------------------------------------------------
// I24 — the whole card opens the title page
// ---------------------------------------------------------------------------
check("the card body is a link to the title page", () => {
  assert.match(titleCard, /data-card-target="title"/);
  assert.match(titleCard, /href=\{title\.href\}/);
});

// ---------------------------------------------------------------------------
// I25 / I26 — mechanism + chrome stripped
// ---------------------------------------------------------------------------
check("no result count, timing, or 'cached' on the results surface", () => {
  assert.doesNotMatch(searchResults, /tookMs/);
  assert.doesNotMatch(searchResults, /\bcached\b/);
  assert.doesNotMatch(searchResults, /of\s*\{?\s*totalCount/);
});

check("no filters / refresh / density / All-Packs-Episodes toolbar", () => {
  for (const chrome of [
    /Filters/,
    /Refresh/,
    /Density/,
    /Compact/,
    /Packs/,
    /Episodes/,
    /minSeeders/,
    /releaseKind/,
    /SlidersHorizontal/,
  ]) {
    assert.doesNotMatch(searchResults, chrome, `chrome leaked: ${chrome}`);
  }
});

check("no seed/size/health/indexer/SxxExx narration on cards", () => {
  for (const mech of [
    /torrent\.seeders/,
    /torrent\.leechers/,
    /formatBytes/,
    /sizeLabel/,
    /Health/,
    /\{health\}/,
    /torrent\.source/,
    /S\d{2}E\d{2}/,
  ]) {
    assert.doesNotMatch(titleCard, mech, `mechanism leaked in card: ${mech}`);
    assert.doesNotMatch(releaseRow, mech, `mechanism leaked in row: ${mech}`);
  }
});

check("the retention helper sentence is gone", () => {
  assert.doesNotMatch(searchResults, /Stream plays now and can be reclaimed later/);
  assert.doesNotMatch(titleCard, /reclaimed later/);
});

// ---------------------------------------------------------------------------
// I32 — two actions: Play + Download; the word "Stream" is gone
// ---------------------------------------------------------------------------
check("cards offer Play and Download, never Stream", () => {
  assert.match(titleCard, /data-action="play"/);
  assert.match(titleCard, /data-action="download"/);
  assert.match(releaseRow, /data-action="play"/);
  assert.match(releaseRow, /data-action="download"/);
  assert.match(titleCard, /\bPlay\b/);
  assert.match(releaseRow, /\bPlay\b/);
  // No user-facing "Stream" anywhere in these surfaces.
  assert.doesNotMatch(titleCard, /\bStream\b/);
  assert.doesNotMatch(releaseRow, /\bStream\b/);
  assert.doesNotMatch(searchResults, /\bStream\b/);
  assert.doesNotMatch(overlay, /\bStream\b/);
});

check("releases hide behind an expander, collapsed by default", () => {
  assert.match(titleCard, /data-action="expand-releases"/);
  assert.match(titleCard, /useState\(false\)/);
  assert.match(titleCard, /ReleaseRow/);
});

// ---------------------------------------------------------------------------
// I10-SEARCH — visual future-gating
// ---------------------------------------------------------------------------
check("future-dated works are visually gated with actions disabled", () => {
  assert.match(titleCard, /unreleased/);
  assert.match(titleCard, /comingLabel/);
  assert.match(titleCard, /data-unreleased/);
  // Play/Download are disabled when blocked (unreleased folds into blocked).
  assert.match(titleCard, /disabled=\{sending \|\| blocked/);
});

// ---------------------------------------------------------------------------
// I22 — search is an overlay opened by "/" or the header, no route change
// ---------------------------------------------------------------------------
check("the '/' shortcut opens the overlay, not a route", () => {
  assert.match(shortcuts, /openSearchOverlay/);
  assert.doesNotMatch(shortcuts, /router\.push\(SEARCH_HREF\)[\s\S]*?el\.focus/);
});

check("the overlay is a single focused input that closes on Esc", () => {
  assert.match(overlay, /data-search-overlay/);
  assert.match(overlay, /data-search-input="true"/);
  assert.match(overlay, /Escape/);
  assert.match(overlay, /aria-modal="true"/);
  // Exactly one text/search input in the overlay.
  const inputs = overlay.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 1, "overlay must have a single input");
});

check("the header Search affordance opens the overlay, keeps a deep-link", () => {
  assert.match(header, /openSearchOverlay/);
  assert.match(header, /data-search-trigger/);
  assert.match(header, /href=\{HEADER_SEARCH_HREF\}/);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll search-results-flow tests passed.");
