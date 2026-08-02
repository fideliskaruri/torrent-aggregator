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

if (process.exitCode) {
  console.error("\nFAIL — client page source shape regressed");
} else {
  console.log("\nPASS — client page source shape is stable");
}
