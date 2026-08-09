/**
 * Which season the series dialog opens to, and how that choice survives a
 * poll — see `season-selection.ts` for the two rules under test.
 *
 * Run: npx tsx src/app/downloads/season-selection.test.ts
 */
import assert from "node:assert/strict";
import { groupDownloads, type SeriesGroup, type TransferRow } from "./grouping";
import { filterDownloadsByTab } from "./media-filter";
import {
  defaultSeasonKey,
  resolveSelectedSeasonKey,
  seriesGroupByKey,
} from "./season-selection";

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

const MB = 1024 * 1024;
const GB = 1024 * MB;

function row(partial: Partial<TransferRow> & { name: string }): TransferRow {
  return {
    hash: partial.hash ?? partial.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    name: partial.name,
    category: "category" in partial ? partial.category : "TV",
    progress: partial.progress ?? 0,
    sizeBytes: partial.sizeBytes ?? 1 * GB,
    dlspeed: partial.dlspeed ?? 0,
    upspeed: partial.upspeed ?? 0,
    state: partial.state ?? "downloading",
  };
}

function firstSeries(rows: TransferRow[]): SeriesGroup<TransferRow> {
  const group = groupDownloads(rows).find((g) => g.kind === "series");
  assert.ok(group, "expected a series group in the fixture");
  return group as SeriesGroup<TransferRow>;
}

console.log("\ndownloads season-selection");

check("default season is the first that is still downloading or incomplete", () => {
  const group = firstSeries([
    row({ name: "Show S01E01", state: "seeding", progress: 1 }),
    row({ name: "Show S02E01", state: "downloading", progress: 0.4 }),
    row({ name: "Show S03E01", state: "queuedDL", progress: 0 }),
  ]);
  const key = defaultSeasonKey(group.seasons);
  const chosen = group.seasons.find((s) => s.key === key);
  assert.equal(chosen?.season, 2, "season 2 is downloading; it should win over the finished season 1");
});

check("default season falls back to the first ordered season when every season is ready", () => {
  const group = firstSeries([
    row({ name: "Show S02E01", state: "seeding", progress: 1 }),
    row({ name: "Show S01E01", state: "seeding", progress: 1 }),
  ]);
  const key = defaultSeasonKey(group.seasons);
  const chosen = group.seasons.find((s) => s.key === key);
  assert.equal(
    chosen?.season,
    1,
    "nothing is incomplete, so the first ordered season (1, not 2) is the fallback",
  );
});

check("an incomplete season beats a downloading-but-finished-progress season by order", () => {
  // Season 1 reports 100% but a stray paused release still exists in it —
  // combinedState would report season 1 as "paused", not "downloading" — while
  // season 2 is genuinely incomplete. The incomplete one should win regardless
  // of which one is "downloading" in raw state terms.
  const group = firstSeries([
    row({ name: "Show S01E01", state: "seeding", progress: 1 }),
    row({ name: "Show S02E01", state: "stalledDL", progress: 0.1 }),
  ]);
  const key = defaultSeasonKey(group.seasons);
  const chosen = group.seasons.find((s) => s.key === key);
  assert.equal(chosen?.season, 2);
});

check("no seasons resolves to no default", () => {
  assert.equal(defaultSeasonKey([]), null);
});

check("selection survives a poll when the season is still present", () => {
  const before = firstSeries([
    row({ name: "Show S01E01", state: "downloading", progress: 0.2 }),
    row({ name: "Show S02E01", state: "queuedDL", progress: 0 }),
  ]);
  const selected = resolveSelectedSeasonKey(before.seasons, null);
  const season1Key = before.seasons.find((s) => s.season === 1)?.key ?? null;
  assert.equal(selected, season1Key, "season 1 is downloading and should default first");

  // A poll five seconds later: season 1 finished, season 2 is now the one
  // downloading. The user is looking at season 1 — the selection must not
  // jump to season 2 just because season 2 is now the "active" one.
  const after = firstSeries([
    row({ name: "Show S01E01", state: "seeding", progress: 1 }),
    row({ name: "Show S02E01", state: "downloading", progress: 0.3 }),
  ]);
  const stillSelected = resolveSelectedSeasonKey(after.seasons, selected);
  assert.equal(stillSelected, selected, "an existing selection must survive the poll unchanged");
});

check("selection falls back to the default once the selected season is gone", () => {
  const before = firstSeries([
    row({ name: "Show S01E01", state: "downloading", progress: 0.2 }),
    row({ name: "Show S02E01", state: "downloading", progress: 0.5 }),
  ]);
  const season2Key = before.seasons.find((s) => s.season === 2)?.key ?? null;

  // Season 2 got deleted entirely between polls.
  const after = firstSeries([
    row({ name: "Show S01E01", state: "downloading", progress: 0.2 }),
  ]);
  const resolved = resolveSelectedSeasonKey(after.seasons, season2Key);
  const season1Key = after.seasons.find((s) => s.season === 1)?.key ?? null;
  assert.equal(resolved, season1Key, "the vanished season falls back to the remaining default");
});

check("the series dialog's data contract is independent of the page's search/status filters", () => {
  const rows = [
    row({ name: "Show S01E01", state: "seeding", progress: 1 }),
    row({ name: "Show S02E01", state: "downloading", progress: 0.5 }),
  ];
  const full = groupDownloads(rows);
  const series = full.find((g) => g.kind === "series") as SeriesGroup<TransferRow>;

  // A status filter that only keeps "Ready" rows would drop season 2 entirely
  // from the page's own rendered list...
  const readyOnly = rows.filter((r) => r.state === "seeding");
  const narrowedGroups = groupDownloads(readyOnly);
  const narrowedSeries = narrowedGroups.find((g) => g.kind === "series") as
    | SeriesGroup<TransferRow>
    | undefined;
  assert.equal(narrowedSeries?.seasons.length, 1, "the filtered list itself only has season 1");

  // ...but the dialog must still be handed every season, because it derives
  // from the unfiltered set via `seriesGroupByKey`, not from the narrowed one.
  const fromFullSet = seriesGroupByKey(full, series.key);
  assert.equal(fromFullSet?.seasons.length, 2, "the dialog's own lookup must see both seasons");
});

check("a media-tab filter cannot hide seasons from the dialog's own lookup either", () => {
  const rows = [
    row({ name: "Show S01E01", category: "TV", state: "seeding", progress: 1 }),
    row({ name: "Show S02E01", category: "TV", state: "downloading", progress: 0.5 }),
  ];
  const full = groupDownloads(rows);
  const series = full.find((g) => g.kind === "series") as SeriesGroup<TransferRow>;

  const moviesOnly = filterDownloadsByTab(rows, "movies");
  assert.equal(moviesOnly.length, 0, "a series has nothing to show under the Movies tab");

  const fromFullSet = seriesGroupByKey(full, series.key);
  assert.equal(fromFullSet?.seasons.length, 2, "still both seasons, regardless of the tab in effect");
});

check("seriesGroupByKey returns null for a key that names no series", () => {
  const rows = [row({ name: "Show S01E01" })];
  const full = groupDownloads(rows);
  assert.equal(seriesGroupByKey(full, "single:doesnotexist"), null);
});

if (failures) {
  console.error(`\nFAIL — ${failures} season-selection check(s) regressed`);
  process.exitCode = 1;
} else {
  console.log("\nPASS — season-selection rules hold");
}
