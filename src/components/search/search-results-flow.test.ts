/**
 * The product shape of the search results surface, pinned against the files.
 *
 * Search is TMDB title discovery only: clickable title cards, no torrent
 * actions on the search surface. Play/Download live on the title page.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rankTitleHitsByRelevance } from "./title-search";

const root = process.cwd();
const readRaw = (p: string) =>
  fs.readFileSync(path.join(root, "src", ...p.split("/")), "utf8");

/**
 * These rules are about what the *rendered* surface says, not what the source
 * prose documents. A comment may legitimately name a banished token, so strip
 * comments before scanning for mechanism leaks.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const read = (p: string) => stripComments(readRaw(p));

const searchResults = read("components/search/search-results.tsx");
const titleCard = read("components/search/title-result-card.tsx");
const releaseRow = read("components/search/torrent-card.tsx");
const overlay = read("components/search/search-overlay.tsx");
const overlayState = read("components/search/search-overlay-state.ts");
const header = read("components/layout/header.tsx");
const shortcuts = read("hooks/use-keyboard-shortcuts.ts");
const titlesApi = read("app/api/search/titles/route.ts");

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

console.log("search-results-flow: TMDB title discovery, click-only cards…");

// ---------------------------------------------------------------------------
// Title discovery API — not torrent grouping
// ---------------------------------------------------------------------------
check("the Films & TV scope still searches TMDB, never the indexers", () => {
  // The rule this has always protected: typing a film name must not fire a
  // torrent search on every keystroke. That rule is unchanged and still
  // load-bearing — it is why the film flow is fast and why the shared indexer
  // budget is not spent on discovery.
  //
  // What HAS changed is its scope. Music, games, software and books have no
  // metadata provider behind them, so for those the indexers are the only
  // source and searching them is correct.
  //
  // The URL choice now lives in `search-overlay-state.ts`, and the *behaviour*
  // — that a films search carries no category and a music search does — is
  // asserted directly in `search-overlay-state.test.ts`, which can call the
  // function instead of reading around it. What source inspection is still good
  // for is the structural half: the overlay must delegate rather than grow a
  // second copy of either URL, because a hand-built fetch is exactly how the
  // film path would quietly regain an indexer call.
  assert.match(overlayState, /\/api\/search\/titles/);
  assert.doesNotMatch(overlay, /fetch\(`\/api\/search/);
  assert.doesNotMatch(overlay, /fetch\("\/api\/search/);
  assert.match(overlay, /searchRequestFor/);
  assert.doesNotMatch(overlay, /groupTitles/);
});

check("non-film scopes reach the aggregator with their own category", () => {
  // The other half of the same rule: a scope that has no TMDB record must not
  // silently fall back to a film search, which would return films for "daft
  // punk" and look like the feature simply does not work.
  assert.match(overlayState, /category: scope\.category/);
});

check("search-results fetches /api/search/titles", () => {
  assert.match(searchResults, /\/api\/search\/titles/);
  assert.doesNotMatch(searchResults, /groupTitles/);
  assert.match(searchResults, /TitleResultsList/);
});

check("titles API calls searchTmdb only", () => {
  assert.match(titlesApi, /searchTmdb/);
  assert.doesNotMatch(titlesApi, /searchTorrents/);
});

// The live defect: TMDB returns by popularity, so searching "atlantis" put
// Stargate Atlantis (2004) above the exact-title Atlantis (2013). Ranking
// existed in the grouping path but the titles API never applied it, so the
// bug survived a "fix". Assert the API actually ranks, and assert the rule
// behaviourally below — a source grep alone would not have caught this.
check("titles API ranks results by relevance", () => {
  assert.match(titlesApi, /rankTitleHitsByRelevance/);
});

check("exact title beats a longer substring match", () => {
  const hits = [
    { title: "Stargate Atlantis" },
    { title: "Atlantis" },
    { title: "Man from Atlantis" },
    { title: "Atlantis Rising" },
  ];
  const ranked = rankTitleHitsByRelevance(hits, "atlantis");
  assert.equal(ranked[0].title, "Atlantis", "the exact title must win");
});

check("leading articles do not break an exact match", () => {
  const ranked = rankTitleHitsByRelevance(
    [{ title: "Maelstrom: The Odyssey of Waterworld" }, { title: "The Odyssey" }],
    "odyssey",
  );
  assert.equal(ranked[0].title, "The Odyssey");
});

check("within one relevance tier the source order is preserved", () => {
  const hits = [{ title: "Atlantis" }, { title: "Atlantis" }];
  const ranked = rankTitleHitsByRelevance(
    hits.map((h, i) => ({ ...h, id: i })),
    "atlantis",
  );
  assert.deepEqual(
    ranked.map((r) => r.id),
    [0, 1],
    "equal relevance keeps TMDB's popularity order",
  );
});

check("an empty query never reorders", () => {
  const hits = [{ title: "B" }, { title: "A" }];
  assert.deepEqual(
    rankTitleHitsByRelevance(hits, "  ").map((h) => h.title),
    ["B", "A"],
  );
});

check("a best-match card is marked featured", () => {
  assert.match(titleCard, /Best match/);
  assert.match(titleCard, /featured/);
});

// ---------------------------------------------------------------------------
// The whole card opens the title page
// ---------------------------------------------------------------------------
check("the card body is a link to the title page", () => {
  assert.match(titleCard, /data-card-target="title"/);
  assert.match(titleCard, /href=\{title\.href\}/);
});

check("search cards have no Play / Download / Releases", () => {
  assert.doesNotMatch(titleCard, /data-action="play"/);
  assert.doesNotMatch(titleCard, /data-action="download"/);
  assert.doesNotMatch(titleCard, /data-action="expand-releases"/);
  assert.doesNotMatch(titleCard, /useReleaseActions/);
  assert.doesNotMatch(titleCard, /ReleaseRow/);
  assert.doesNotMatch(titleCard, /PlayOverlay/);
});

// ---------------------------------------------------------------------------
// Mechanism + chrome stripped
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

check("the work card narrates no mechanism", () => {
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
  }
});

// Release row still exists for title-page chooser surfaces — keep mechanism rules.
check("the release row surfaces distinguishing facts for a chooser", () => {
  assert.match(releaseRow, /releaseFacts/);
  assert.match(releaseRow, /episodeLabel/);
  assert.match(releaseRow, /seedStrength/);
  for (const raw of [
    /torrent\.seeders/,
    /torrent\.leechers/,
    /formatBytes/,
    /sizeLabel/,
  ]) {
    assert.doesNotMatch(releaseRow, raw, `row should get ${raw} from release-facts, not inline`);
  }
  assert.doesNotMatch(releaseRow, /Health/, "no Health % on the row");
  assert.doesNotMatch(releaseRow, /torrent\.source/, "no indexer name on the row");
});

check("the retention helper sentence is gone", () => {
  assert.doesNotMatch(searchResults, /Stream plays now and can be reclaimed later/);
  assert.doesNotMatch(titleCard, /reclaimed later/);
});

check("no user-facing Stream on search surfaces", () => {
  assert.doesNotMatch(titleCard, /\bStream\b/);
  assert.doesNotMatch(searchResults, /\bStream\b/);
  assert.doesNotMatch(overlay, /\bStream\b/);
});

// ---------------------------------------------------------------------------
// Visual future-gating still available when status is unreleased
// ---------------------------------------------------------------------------
check("future-dated works can be visually gated", () => {
  assert.match(titleCard, /unreleased/);
  assert.match(titleCard, /comingLabel/);
  assert.match(titleCard, /data-unreleased/);
});

// ---------------------------------------------------------------------------
// Search is an overlay opened by "/" or the header
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
