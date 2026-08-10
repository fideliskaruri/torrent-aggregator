import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/downloads/page.tsx", "utf8");
const dialogSource = fs.readFileSync(
  "src/app/downloads/series-download-dialog.tsx",
  "utf8",
);
const dialogPrimitiveSource = fs.readFileSync("src/components/ui/dialog.tsx", "utf8");

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
  assert.match(source, /from "\.\/release-display";/);
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

check("film rows are keyboard-selectable with named progress", () => {
  assert.match(source, /role="button"\s+tabIndex=\{0\}\s+aria-pressed=\{isSelected\}/);
  assert.match(source, /e\.key === "Enter" \|\| e\.key === " "/);
  assert.match(source, /aria-label=\{`\$\{display\.title\} download progress`\}/);
});

check("destructive dialogs restore their opener", () => {
  assert.match(source, /deleteOpenerRef/);
  assert.match(source, /requestAnimationFrame\(\(\) => opener\.focus\(\)\)/);
});

check("the series dialog restores its opener on close too", () => {
  assert.match(source, /seriesDialogOpenerRef/);
  assert.match(
    source,
    /function closeSeriesDialog\(\)[\s\S]{0,300}requestAnimationFrame\(\(\) => opener\.focus\(\)\)/,
  );
});

check("the page reuses the shared classification rules instead of its own", () => {
  assert.match(source, /from "\.\/media-filter"/);
  assert.match(source, /from "\.\/grouping"/);
  assert.match(source, /filterDownloadsByTab\(/);
  assert.match(source, /groupDownloads\(/);
  // These live in ./grouping so the status filter, the badge colours and a
  // group's combined state answer "is this downloaded" identically — on the
  // page and inside the dialog.
  assert.doesNotMatch(source, /function\s+is(?:Downloading|Downloaded|Paused)\s*\(/);
  assert.doesNotMatch(dialogSource, /function\s+is(?:Downloading|Downloaded|Paused)\s*\(/);
  // The tab vocabulary belongs to media-filter.ts. Spelled out again here, the
  // Library and this page would drift the first time either list changes.
  assert.doesNotMatch(source, /"movies"[\s\S]{0,20}"series"[\s\S]{0,20}"anime"/);
});

check("a series draws one compact overview row, never an inline accordion", () => {
  // The redesign's contract: one row per series on the page itself, an
  // explicit Details control that opens the dialog, and nothing that expands
  // in place. BUG-004 was the owner naming the previous "moved divs" attempt
  // for what it was — this guards against reverting to it.
  assert.match(source, /data-download-group/);
  assert.match(source, /data-group-details/);
  assert.doesNotMatch(source, /data-group-expand/);
  assert.doesNotMatch(source, /data-season-row/);
  assert.doesNotMatch(source, /expandedGroups|expandedSeasons/);
  assert.doesNotMatch(source, /\{renderItems\.map\(/);
  // The compact list draws from the filtered grouping; the dialog's own data
  // (asserted separately below) comes from the unfiltered one.
  assert.match(source, /\{grouped\.map\(\(group\)/);
});

check("the series dialog is the only place seasons and episodes are drawn", () => {
  assert.match(source, /import \{ SeriesDownloadDialog \} from "\.\/series-download-dialog";/);
  assert.match(source, /<SeriesDownloadDialog/);
  assert.doesNotMatch(source, /data-season-row|data-episode-lead|isChild/);
});

check(
  "the series dialog uses the general Radix Dialog primitive, never AlertDialog",
  () => {
    assert.match(dialogSource, /from "@\/components\/ui\/dialog";/);
    assert.doesNotMatch(dialogSource, /alert-dialog/);
    assert.doesNotMatch(dialogSource, /AlertDialog/);
    // The primitive itself wraps @radix-ui/react-dialog, not the alert variant.
    assert.match(dialogPrimitiveSource, /from "@radix-ui\/react-dialog";/);
    assert.doesNotMatch(dialogPrimitiveSource, /react-alert-dialog/);
  },
);

check(
  "@radix-ui/react-dialog is a direct dependency, pinned to the same version as alert-dialog",
  () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.ok(pkg.dependencies?.["@radix-ui/react-dialog"], "missing direct dependency");
    assert.equal(
      pkg.dependencies["@radix-ui/react-dialog"],
      pkg.dependencies["@radix-ui/react-alert-dialog"],
      "should be pinned to the same version as the existing alert-dialog dependency",
    );
  },
);

check("the season rail is a named button group, horizontally scrollable, arrow-key friendly", () => {
  assert.match(dialogSource, /data-season-rail/);
  assert.match(dialogSource, /role="group"/);
  assert.match(dialogSource, /aria-pressed=\{active\}/);
  assert.match(dialogSource, /aria-controls=\{panelId\}/);
  assert.doesNotMatch(dialogSource, /role="tab"/);
  assert.doesNotMatch(dialogSource, /aria-selected/);
  assert.match(dialogSource, /overflow-x-auto/);
  assert.match(dialogSource, /shrink-0/);
  assert.match(dialogSource, /ArrowRight/);
  assert.match(dialogSource, /ArrowLeft/);
});

check("season tabs auto-scroll into view while keeping keyboard focus behavior", () => {
  assert.match(dialogSource, /new ResizeObserver\(ensureSelectedSeasonVisible\)/);
  assert.match(dialogSource, /observer\.observe\(rail\)/);
  assert.match(dialogSource, /forEach\(\(tab\) => observer\.observe\(tab\)\)/);
  assert.match(dialogSource, /new MutationObserver\(observeRailAndTabs\)/);
  assert.match(dialogSource, /observer\.disconnect\(\)/);
  assert.match(dialogSource, /rail\.scrollLeft [+-]=/);
  assert.doesNotMatch(dialogSource, /window\.addEventListener\("resize"/);
  assert.doesNotMatch(dialogSource, /activeTab\.focus\(\)/);
  assert.match(dialogSource, /tabRefs\.current\[nextIndex\]\?\.focus\(\)/);
});

check("very small screens use a purpose-built season workspace instead of a compressed rail", () => {
  assert.match(dialogSource, /data-mobile-series-header/);
  assert.match(dialogSource, /data-mobile-season-picker/);
  assert.match(dialogSource, /data-mobile-season-select/);
  assert.match(dialogSource, /aria-controls=/);
  assert.match(dialogSource, /sm:hidden/);
  assert.match(dialogSource, /hidden shrink-0 sm:block/);
  assert.match(dialogSource, /role="region"/);
  assert.doesNotMatch(dialogSource, /role="tabpanel"/);
});

check("the bulk action bar adds safe-area padding on mobile without losing the normal desktop spacing", () => {
  assert.match(dialogSource, /data-dialog-bulk-bar/);
  assert.match(dialogSource, /pb-\[calc\(0\.5rem\+var\(--safe-bottom\)\)\]/);
  assert.match(dialogSource, /sm:pb-2/);
  assert.match(dialogSource, /shadow-\[var\(--shadow-md\)\]/);
  assert.match(dialogSource, /sm:shadow-none/);
});

check("only the dialog body scrolls vertically — no ancestor hides overflow-x", () => {
  assert.match(dialogSource, /data-season-panel/);
  assert.match(dialogSource, /overflow-y-auto/);
  // The one CSS footgun this contract explicitly forbids: setting overflow-x
  // to hidden on any dialog ancestor silently makes the other axis an
  // unintended scroll container and breaks the rail + any sticky header.
  assert.doesNotMatch(dialogSource, /overflow-x-hidden/);
  assert.doesNotMatch(dialogPrimitiveSource, /overflow-x-hidden/);
});

check("the dialog's data contract is independent of the page's own filters", () => {
  // Two groupings, built from two different bases: `filtered` (search/status/
  // tab-narrowed) drives the compact list; `downloadable` (excluding only
  // stream/prewarm) drives `allGroups`, which the dialog is looked up from —
  // never from `grouped`/`filtered`.
  assert.match(source, /const downloadable = useMemo\(\(\) => torrents\.filter\(isDownloadRow\)/);
  assert.match(source, /const allGroups = useMemo\(\(\) => groupDownloads\(downloadable\)/);
  assert.match(source, /seriesGroupByKey\(allGroups, openSeriesKey\)/);
  assert.doesNotMatch(source, /seriesGroupByKey\(grouped/);
});

check("the dialog closes cleanly and announces it if its series disappears", () => {
  assert.match(source, /shouldCloseMissingGroup\(\{/);
  assert.match(source, /openKey: openSeriesKey/);
  assert.match(source, /groupFound: Boolean\(openGroup\)/);
  assert.match(source, /setOpenSeriesKey\(null\)/);
  assert.match(source, /setAnnouncement\(/);
  assert.match(source, /role="status" aria-live="polite"/);
});

check("play stacking: the series dialog unmounts while the player is open", () => {
  // Never two focus traps: PlayOverlay is hand-rolled, not Radix, so the
  // series dialog must fully unmount (not just hide) while it is up, and
  // reappear on the same series/season once playback closes.
  assert.match(source, /\{openGroup && !playing \? \(\s*<SeriesDownloadDialog/);
  assert.match(source, /playFromDialog/);
});

check("films keep their existing direct row and play behavior, ETA included", () => {
  assert.match(source, /function FilmRow\(/);
  assert.match(source, /data-client-play\b/);
  assert.match(source, /canStreamTransfer\(t\)/);
  assert.match(
    source,
    /isDownloading\(t\.state\) && t\.eta != null && t\.eta > 0\s*\n\s*\? ` · ETA \$\{formatDuration\(t\.eta\)\}`/,
  );
});

check("the page presents as Downloads, not the client's plumbing name", () => {
  assert.match(source, /title="Downloads"/);
  assert.doesNotMatch(source, /title="Client"/);
  assert.match(source, /live · auto-refresh 5s/);
});

check("torrent mechanics leave the default row for the overflow's Details", () => {
  assert.doesNotMatch(source, /TfPathChip/);
  assert.doesNotMatch(source, /display\.chips/);
  assert.match(source, /data-torrent-details/);
  assert.match(source, /display\.qualityChip/);
  assert.match(dialogSource, /data-torrent-details/);
});

check("the default row shows one speed at most, and only while downloading", () => {
  assert.doesNotMatch(source, /formatBytes\(t\.upspeed\)/);
  assert.doesNotMatch(source, /formatBytes\(group\.upspeed\)/);
  assert.match(source, /speedLabel\(t\.dlspeed\)/);
  assert.match(source, /speedLabel\(group\.dlspeed\)/);
});

check("episode completion styling requires the downloaded state", () => {
  assert.match(dialogSource, /const done = isDownloaded\(t\.state\);/);
  assert.doesNotMatch(
    dialogSource,
    /const done\s*=\s*t\.progress\s*>?=/,
    "progress alone cannot paint a completion checkmark",
  );
});

check("episode cards preserve selection, overflow actions and stable data hooks", () => {
  assert.match(dialogSource, /data-episode-card/);
  assert.match(dialogSource, /onToggleSelect\(t\.transferId, true\)/);
  assert.match(dialogSource, /data-owner-client=\{t\.ownerClientType\}/);
  assert.match(dialogSource, /onCopyStreamUrl/);
  assert.match(dialogSource, /onOpenFolder/);
  assert.match(dialogSource, /data-episode-delete/);
  assert.match(dialogSource, /grid-cols-1[\s\S]{0,20}md:grid-cols-2/);
});

check("the dialog exposes a modal-scoped bulk action bar for multi-selected episodes", () => {
  assert.match(dialogSource, /data-dialog-bulk-bar/);
  assert.match(dialogSource, /selectedTransferIdsInGroup/);
});

check("row actions carry the verified owner identity back to the API", () => {
  assert.match(source, /ownerClientType:\s*torrent\.ownerClientType/);
  assert.match(source, /selected\.has\(t\.transferId\)/);
  assert.match(source, /const isBuiltin = t\.ownerClientType === "builtin"/);
});

check("a failed poll cannot blank the list or fake a deletion", () => {
  // The whole point of snapshot-sync.ts: state folds through it, quiet
  // failures keep the last good rows, and the dialog's auto-close is gated on
  // an authoritative read.
  assert.match(source, /from "\.\/snapshot-sync"/);
  assert.match(source, /applySnapshot\(/);
  assert.match(source, /shouldCloseMissingGroup\(\{[\s\S]{0,160}authoritative,/);
  // No direct row-clearing left anywhere on a failure path.
  assert.doesNotMatch(source, /setTorrents\(\[\]\)/);
  assert.doesNotMatch(source, /setTorrents\(/);
  // Preserved rows are shown with a non-blocking staleness strip, not
  // replaced by the full-page error panel.
  assert.match(source, /error && torrents\.length > 0/);
  assert.match(source, /error && !torrents\.length/);
  assert.match(source, /data-client-stale/);
});

check("concurrent loads, polls and action refreshes are sequenced", () => {
  assert.match(source, /shouldApplySnapshot\(seq, appliedSeqRef\.current\)/);
  assert.match(source, /requestSeqRef/);
  assert.match(source, /function invalidateInFlight|const invalidateInFlight/);
  // Mutations discard whatever read was already in flight before refreshing.
  assert.match(source, /setDeleting\(true\);[\s\S]{0,300}invalidateInFlight\(\)/);
  // One fetch implementation, not a hand-inlined mount copy that can drift.
  assert.equal(source.match(/fetch\("\/api\/client\/torrents"\)/g)?.length, 1);
});

check("select all reflects visible-row membership, not selection size", () => {
  assert.match(source, /areAllVisibleSelected\(/);
  assert.match(source, /toggleVisibleSelection\(/);
  assert.doesNotMatch(source, /selected\.size === filtered\.length/);
});

check("the dialog title links to the title page and the poster stays decorative", () => {
  assert.match(dialogSource, /data-dialog-title-link/);
  assert.equal(dialogSource.match(/<DialogTitle/g)?.length, 1);
  assert.match(dialogSource, /<DialogTitle className="sr-only">\{group\.title\}<\/DialogTitle>/);
  assert.match(dialogSource, /<Link href=\{titleHref\} tabIndex=\{-1\} aria-hidden/);
});

check("the dialog describes itself in plain language for assistive tech", () => {
  assert.equal(dialogSource.match(/<DialogDescription/g)?.length, 1);
  assert.match(dialogSource, /Every season and episode of this show/);
  assert.doesNotMatch(dialogSource, /aria-describedby=\{undefined\}/);
});

check("the shared dialog close control is a 44px touch target, dense on desktop", () => {
  assert.match(dialogPrimitiveSource, /h-11 w-11/);
  assert.match(dialogPrimitiveSource, /lg:h-9 lg:w-9/);
});

check("the desktop dialog frame is fixed, not content-driven", () => {
  // A explicit `sm:h-[...]` is what keeps a one-episode season the same size
  // as a forty-episode season; `sm:h-auto` (the primitive default) is the bug.
  assert.match(dialogSource, /sm:h-\[min\(88dvh,54rem\)\]/);
  assert.doesNotMatch(dialogSource, /className="[^"]*sm:h-auto/);
  assert.match(dialogSource, /sm:w-\[min\(100%-2rem,68rem\)\]/);
  // Mobile stays the primitive's full-height sheet.
  assert.match(dialogSource, /max-h-\[100dvh\]/);
  // Only the season panel scrolls; header and rail stay fixed.
  assert.match(dialogSource, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(dialogSource, /data-mobile-series-header/);
  assert.match(dialogSource, /<DialogHeader className="hidden shrink-0/);
});

check("the redesign's structural guarantees survive these fixes", () => {
  assert.match(dialogSource, /sm:max-w-\[68rem\]/);
  assert.match(dialogSource, /max-h-\[100dvh\][\s\S]{0,80}sm:max-h-\[88dvh\]/);
  assert.match(dialogSource, /<Checkbox/);
  assert.match(source, /data-delete-dialog/);
});

if (process.exitCode) {
  console.error("\nFAIL — client page source shape regressed");
} else {
  console.log("\nPASS — client page source shape is stable");
}
