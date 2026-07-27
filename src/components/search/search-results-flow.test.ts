import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const searchResults = fs.readFileSync(
  path.join(root, "src", "components", "search", "search-results.tsx"),
  "utf8",
);
const torrentCard = fs.readFileSync(
  path.join(root, "src", "components", "search", "torrent-card.tsx"),
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

console.log("search-results-flow: rank-ordered cards…");

check("results render the API-ranked torrent list directly", () => {
  assert.match(searchResults, /data\.results\.map|resultFlow\.map/);
  assert.doesNotMatch(searchResults, /works\.map\(/);
});

check("results do not re-bucket rank into seasons or quality ladders", () => {
  assert.doesNotMatch(searchResults, /work-sections/);
  assert.doesNotMatch(searchResults, /buildSections|defaultSectionKey|qualityLadder/);
  assert.doesNotMatch(searchResults, /data-season-tab|data-quality-group/);
});

check("results do not hide ranked releases behind disclosure buttons", () => {
  assert.doesNotMatch(searchResults, /more \$\{group\.label\}/);
  assert.doesNotMatch(searchResults, /Show only the best \$\{group\.label\}/);
});

check("the primary search result action is streaming, not Send", () => {
  assert.match(torrentCard, /data-action="stream"/);
  assert.match(torrentCard, /\bStream\b/);
  assert.doesNotMatch(torrentCard, /data-action="send"/);
});

check("search results expose explicit stream and download retention choices", () => {
  assert.match(torrentCard, /data-action="stream"/);
  assert.match(torrentCard, /data-action="download"/);
  assert.match(torrentCard, /retention:\s*opts\.retention/);
  assert.match(torrentCard, /retention:\s*"stream"/);
  assert.match(torrentCard, /retention:\s*"keep"/);
  assert.match(torrentCard, /Stream plays now and can be reclaimed later/);
});

check("every search send path carries an explicit retention choice", () => {
  assert.doesNotMatch(torrentCard, /sendToClient\("external"\)/);
  assert.doesNotMatch(torrentCard, /sendToClient\("primary"\)/);
});

check("search cards do not narrate timing, raw releases, or unlabeled health", () => {
  assert.doesNotMatch(searchResults, /tookMs/);
  assert.doesNotMatch(torrentCard, /<h3[\s\S]*\{torrent\.title\}[\s\S]*<\/h3>/);
  assert.doesNotMatch(torrentCard, /\{health\}%/);
  assert.match(torrentCard, /title=\{display\.rawTitle\}/);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}

console.log("\nAll search-results-flow tests passed.");
