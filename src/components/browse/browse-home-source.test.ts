/**
 * Home/Browse page must not re-grow three removed surfaces:
 *
 *   1. The "Active downloads" strip (header with a count + "Open client"
 *      link, plus up to three compact download rows) that used to render
 *      below the hero via `ActiveDownloadsTeaser`, in both the populated
 *      board and the nothing-could-load empty state.
 *   2. The "Recently Added · Movies" rail.
 *   3. The "Recently Added · Series" rail.
 *
 * Both rails came from one source: `buildRecentlyAdded` assembled a
 * "Recently Added" rail from `DownloadHistory`, and `buildBrowsePayload` fed
 * it through `splitRailByMediaType` (via `SPLITTABLE_RAIL_IDS`) whenever it
 * held both movies and series, producing the two titled card grids. The
 * owner asked for all three surfaces gone from the rendered home page, and
 * the dead code — the teaser component, the wording helpers only it used,
 * `buildRecentlyAdded` itself, and its entries in the dedupe/split plumbing —
 * was deleted rather than merely unmounted or unreferenced. This is a
 * source-shape guard against any of it quietly coming back.
 *
 * Run: npx tsx src/components/browse/browse-home-source.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { RAIL_PREVIEWS } from "./first-run";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\nhome page: no Active downloads strip, no Recently Added rails");

// ---------------------------------------------------------------------------
// 1. Active downloads teaser
// ---------------------------------------------------------------------------

check("the teaser component file is gone, not just unmounted", () => {
  assert.equal(
    fs.existsSync("src/components/tf/active-downloads-teaser.tsx"),
    false,
  );
});

check("the populated board does not import or render the teaser", () => {
  const source = fs.readFileSync("src/components/browse/browse-board.tsx", "utf8");
  assert.doesNotMatch(source, /ActiveDownloadsTeaser/);
  assert.doesNotMatch(source, /active-downloads-teaser/);
});

check("the empty/error state does not import or render the teaser", () => {
  const source = fs.readFileSync(
    "src/components/browse/browse-empty-state.tsx",
    "utf8",
  );
  assert.doesNotMatch(source, /ActiveDownloadsTeaser/);
  assert.doesNotMatch(source, /active-downloads-teaser/);
});

check("no other rendered home-page path re-imports the deleted teaser", () => {
  for (const file of [
    "src/app/page.tsx",
    "src/components/browse/browse-first-run.tsx",
    "src/components/browse/browse-skeleton.tsx",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /ActiveDownloadsTeaser|active-downloads-teaser/, file);
  }
});

// ---------------------------------------------------------------------------
// 2 & 3. "Recently Added · Movies" / "Recently Added · Series"
// ---------------------------------------------------------------------------

const RAILS_SOURCE = fs.readFileSync("src/lib/browse/rails.ts", "utf8");

check("the data layer no longer builds a Recently Added rail at all", () => {
  // Deleted outright: the DownloadHistory-backed builder that produced the
  // "recently-added" rail id and "Recently Added" title `splitRailByMediaType`
  // then expanded into the two card grids shown in the screenshot.
  assert.doesNotMatch(RAILS_SOURCE, /buildRecentlyAdded/);
  assert.doesNotMatch(RAILS_SOURCE, /["']recently-added["']/);
  assert.doesNotMatch(RAILS_SOURCE, /Recently Added/);
});

check("recently-added cannot re-enter the movie/series split", () => {
  // The split only ever fires for ids named in SPLITTABLE_RAIL_IDS, so this
  // is the one line that could quietly resurrect both "· Movies" and
  // "· Series" rails without the builder itself coming back.
  const match = RAILS_SOURCE.match(
    /const SPLITTABLE_RAIL_IDS = new Set\(([^)]*)\)/,
  );
  assert.ok(match, "SPLITTABLE_RAIL_IDS not found in rails.ts");
  assert.doesNotMatch(match![1], /recently-added/);
});

check("buildBrowsePayload no longer fetches or dedupes a recently-added rail", () => {
  const payloadFn = RAILS_SOURCE.slice(
    RAILS_SOURCE.indexOf("export async function buildBrowsePayload"),
  );
  assert.doesNotMatch(payloadFn, /buildRecentlyAdded\(/);
  assert.doesNotMatch(payloadFn, /recently-added/);
});

check("the first-run preview and missing-rails note no longer promise it", () => {
  assert.equal(
    RAIL_PREVIEWS.some((p) => p.id === "recently-added"),
    false,
    "a first-run/missing-rails preview still names a rail that no longer exists",
  );
  assert.equal(
    RAIL_PREVIEWS.some((p) => p.title === "Recently Added"),
    false,
  );
});

if (failures) {
  console.error(`\n${failures} browse-home-source test(s) failed.`);
  process.exit(1);
}
console.log("\nPASS — home page has neither the Active downloads strip nor the Recently Added rails");
