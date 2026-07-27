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

check("the primary search result action is playback, not Send", () => {
  assert.match(torrentCard, /data-action="play"/);
  assert.match(torrentCard, /\bPlay\b/);
  assert.doesNotMatch(torrentCard, /data-action="send"/);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}

console.log("\nAll search-results-flow tests passed.");
