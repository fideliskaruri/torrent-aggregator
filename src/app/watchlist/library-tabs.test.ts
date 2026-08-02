/**
 * Library tab rules.
 *
 * Run: npx tsx src/app/watchlist/library-tabs.test.ts
 *
 * Table-driven over the media-type spellings that actually reach this code,
 * because the interesting cases are all about what happens to a row the app
 * cannot classify - and "it gets quietly filed under Movies" is the failure
 * mode worth guarding.
 */
import assert from "node:assert/strict";
import {
  DEFAULT_LIBRARY_TAB,
  LIBRARY_TABS,
  filterByTab,
  parseLibraryTab,
  rowInTab,
  tabCounts,
  tabForRow,
  visibleTabs,
  type LibraryTab,
} from "./library-tabs";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

const row = (mediaType: string | null | undefined) => ({ mediaType });

check("every media type the app produces lands in exactly one tab", () => {
  const cases: { input: string | null | undefined; tab: LibraryTab | null }[] = [
    { input: "movie", tab: "movies" },
    { input: "Movie", tab: "movies" },
    { input: "tv", tab: "series" },
    { input: "TV", tab: "series" },
    { input: "anime", tab: "anime" },
    // Anime is not folded into Series: it has its own catalogue, its own
    // naming, and its own subbed/dubbed decision.
    { input: "Anime", tab: "anime" },
  ];
  for (const c of cases) {
    assert.equal(tabForRow(row(c.input)), c.tab, `${c.input}`);
  }
});

check("an unclassifiable row is never guessed into a tab", () => {
  for (const input of [null, undefined, "", "   ", "documentary", "book", "???"]) {
    assert.equal(
      tabForRow(row(input)),
      null,
      `${JSON.stringify(input)} must claim no narrower tab`,
    );
    // But it has not vanished. It is still the user's, so All still holds it.
    assert.equal(rowInTab(row(input), "all"), true, `${JSON.stringify(input)} under All`);
    for (const tab of ["movies", "series", "anime"] as const) {
      assert.equal(rowInTab(row(input), tab), false);
    }
  }
});

check("All holds everything, and the narrow tabs partition the rest", () => {
  const rows = [row("movie"), row("tv"), row("anime"), row("movie"), row(null)];
  assert.equal(filterByTab(rows, "all").length, 5);
  assert.equal(filterByTab(rows, "movies").length, 2);
  assert.equal(filterByTab(rows, "series").length, 1);
  assert.equal(filterByTab(rows, "anime").length, 1);
  // No row appears in two narrow tabs.
  for (const r of rows) {
    const hits = (["movies", "series", "anime"] as const).filter((t) => rowInTab(r, t));
    assert.ok(hits.length <= 1, `${r.mediaType} appeared in ${hits.join(", ")}`);
  }
});

check("counts do not pretend the parts add up", () => {
  const counts = tabCounts([row("movie"), row("tv"), row(null), row("nonsense")]);
  assert.equal(counts.all, 4);
  assert.equal(counts.movies, 1);
  assert.equal(counts.series, 1);
  assert.equal(counts.anime, 0);
  // Two rows have no type. `all` exceeding the sum is the signal that says so,
  // and flattening it would hide a real fact about the library.
  assert.equal(counts.movies + counts.series + counts.anime, 2);
  assert.notEqual(counts.all, counts.movies + counts.series + counts.anime);
});

check("empty tabs are hidden, All never is", () => {
  assert.deepEqual(visibleTabs([]), ["all"]);
  assert.deepEqual(visibleTabs([row("movie")]), ["all", "movies"]);
  assert.deepEqual(visibleTabs([row("movie"), row("anime")]), ["all", "movies", "anime"]);
  // A library of nothing but unclassifiable rows still shows All and nothing
  // else - three dead tabs would be worse than none.
  assert.deepEqual(visibleTabs([row(null), row("???")]), ["all"]);
  assert.deepEqual(
    visibleTabs([row("movie"), row("tv"), row("anime")]),
    ["all", "movies", "series", "anime"],
  );
});

check("visible tabs keep their declared order regardless of arrival order", () => {
  assert.deepEqual(
    visibleTabs([row("anime"), row("tv"), row("movie")]),
    ["all", "movies", "series", "anime"],
    "the bar must not reshuffle itself based on what loaded first",
  );
});

check("a bad tab in the URL falls back to All rather than an empty page", () => {
  assert.equal(parseLibraryTab(null), DEFAULT_LIBRARY_TAB);
  assert.equal(parseLibraryTab(""), DEFAULT_LIBRARY_TAB);
  assert.equal(parseLibraryTab("films"), DEFAULT_LIBRARY_TAB);
  assert.equal(parseLibraryTab("MOVIES"), "movies");
  assert.equal(parseLibraryTab(" anime "), "anime");
  for (const tab of LIBRARY_TABS) assert.equal(parseLibraryTab(tab), tab);
});

check("All is the default", () => {
  // Arriving on an empty narrow tab is indistinguishable from an empty
  // library, and that is the first impression a new install would get.
  assert.equal(DEFAULT_LIBRARY_TAB, "all");
  assert.equal(LIBRARY_TABS[0], "all");
});

if (failures > 0) {
  console.error(`\n${failures} library-tab test(s) failed.`);
  process.exit(1);
}
console.log("\nAll library-tab tests passed.");
