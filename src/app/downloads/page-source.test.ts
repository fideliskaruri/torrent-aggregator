import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/downloads/page.tsx", "utf8");

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log("\n/downloads page source shape");

check("downloads rows render parsed display titles, not raw release names", () => {
  assert.match(source, /import \{ parseEpisode \} from "@\/lib\/torrents\/episodes";/);
  assert.match(
    source,
    /import \{ parseResolution, parseSourceTier, SOURCE_TIER \} from "@\/lib\/torrents\/quality";/,
  );
  assert.doesNotMatch(source, /function\s+(?:episodeChip|sourceChip)\s*\(/);
  assert.doesNotMatch(source, /<p[\s\S]*?>\s*\{t\.name\}/);
  assert.match(source, /<p[\s\S]*?>\s*\{display\.title\}/);
  assert.match(source, /title=\{t\.name\}/, "raw release name should remain available on hover");
});

check("overflow contains secondary actions and remains keyboard reachable", () => {
  assert.match(source, /<DropdownMenuTrigger asChild>\s*<Button[\s\S]*?aria-label="More actions"/);
  assert.match(source, /<DropdownMenuItem[\s\S]*?data-open-folder/);
  assert.match(source, /Copy stream URL/);
  assert.doesNotMatch(source, /data-inline-player|Hide player|<video\b/);
});

check("downloads page does not poll from a fixed interval", () => {
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
  assert.match(source, /startVisiblePoller/);
});

check("downloads rows are keyboard-selectable with named progress", () => {
  assert.match(source, /role="button"\s+tabIndex=\{0\}\s+aria-pressed=\{isSelected\}/);
  assert.match(source, /e\.key === "Enter" \|\| e\.key === " "/);
  assert.match(source, /aria-label=\{`\$\{display\.title\} download progress`\}/);
});

check("destructive dialogs restore their opener", () => {
  assert.match(source, /deleteOpenerRef/);
  assert.match(source, /requestAnimationFrame\(\(\) => opener\.focus\(\)\)/);
});

check("the page reuses the shared classification rules instead of its own", () => {
  assert.match(source, /from "\.\/media-filter"/);
  assert.match(source, /from "\.\/grouping"/);
  assert.match(source, /filterDownloadsByTab\(/);
  assert.match(source, /groupDownloads\(/);
  // These moved into ./grouping so the status filter, the badge colours and a
  // group's combined state answer "is this seeding" identically. A local copy
  // is how a row shows a Seeding badge while its group calls it downloading.
  assert.doesNotMatch(source, /function\s+is(?:Downloading|Seeding|Paused)\s*\(/);
  // The tab vocabulary belongs to library-tabs.ts. Spelled out again here, the
  // Library and this page would drift the first time either list changes.
  assert.doesNotMatch(source, /"movies"[\s\S]{0,20}"series"[\s\S]{0,20}"anime"/);
});

check("a series draws one expandable row, not one row per episode", () => {
  assert.match(source, /data-download-group/);
  assert.match(source, /data-group-expand/);
  assert.match(source, /data-season-row/);
  // The body iterates the grouped, disclosure-aware list. Iterating the raw
  // filtered rows again is the regression that would silently un-group the
  // page while leaving the group markup in the file, unreachable.
  assert.doesNotMatch(source, /\{filtered\.map\(/);
  assert.match(source, /\{renderItems\.map\(/);
});

check("the page presents as Downloads, not the client's plumbing name", () => {
  // The nav already says Downloads; an H1 of "Client" leaked the torrent-app
  // framing the product rule hides.
  assert.match(source, /title="Downloads"/);
  assert.doesNotMatch(source, /title="Client"/);
  // But the honest built-in status line stays.
  assert.match(source, /live · auto-refresh 5s/);
});

check("an episode row leads with its own identity, not the show's name again", () => {
  // A child row opens with S09E01, drawn from the parsed label; the show name
  // and poster belong to the group header above it, and repeating them on
  // every episode is the torrent-client noise being removed.
  assert.match(source, /data-episode-lead/);
  assert.match(source, /\{display\.episodeLabel \?\? display\.title\}/);
  // The poster is only drawn for a non-child (film) row.
  assert.match(source, /\{!isChild \?/);
});

check("torrent mechanics leave the default row for the overflow's Details", () => {
  // The folder-path chip, the multi-chip release-tag array and the raw peer
  // count are gone from the row itself.
  assert.doesNotMatch(source, /TfPathChip/);
  assert.doesNotMatch(source, /display\.chips/);
  // What was removed is one keystroke away, not lost.
  assert.match(source, /data-torrent-details/);
  // At most one quality tag survives in the row.
  assert.match(source, /display\.qualityChip/);
});

check("the default row shows one speed at most, and only while downloading", () => {
  // Upload speed and the two dedicated speed columns are gone; download speed
  // is shown through the shared, honest `speedLabel` (absent, never "0 B/s").
  assert.doesNotMatch(source, /formatBytes\(t\.upspeed\)/);
  assert.doesNotMatch(source, /formatBytes\(group\.upspeed\)/);
  assert.match(source, /speedLabel\(t\.dlspeed\)/);
  assert.match(source, /speedLabel\(group\.dlspeed\)/);
});

check("the season sub-header drops the folder's zero-padding", () => {
  // Grouping keeps `Season 09` to match the folder on disk; the row reads it
  // back to a person as "Season 9".
  assert.match(source, /`Season \$\{season\.season\}`/);
});

if (process.exitCode) {
  console.error("\nFAIL — client page source shape regressed");
} else {
  console.log("\nPASS — client page source shape is stable");
}
