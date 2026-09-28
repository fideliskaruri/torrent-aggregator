import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../src/app/downloads/${path}`, import.meta.url), "utf8");
const dialog = read("release-swap-dialog.tsx");
const page = read("page.tsx");
const series = read("series-download-dialog.tsx");

test("release swap codes against the documented alternatives contract", () => {
  assert.match(dialog, /\/api\/client\/torrents\/\$\{encodeURIComponent\(hash\.toLowerCase\(\)\)\}\/alternatives/);
  assert.match(dialog, /method: "POST"/);
  assert.match(dialog, /JSON\.stringify\(\{ token: candidate\.token \}\)/);
  assert.match(dialog, /cache: "no-store"/);
  assert.match(dialog, /connectedSeeders\?: number/);
  assert.match(dialog, /stalledForSeconds/);
});

test("release swap renders loading, empty, error and ready states", () => {
  assert.match(dialog, /data-release-alternatives-loading/);
  assert.match(dialog, /SkeletonBlock/);
  assert.match(dialog, /No other releases found on any source/);
  assert.match(dialog, /No other releases on \$\{selectedLabel\}/);
  assert.match(dialog, /Try again later or search for the title\./);
  assert.match(dialog, /Searching \{selectedLabel \?\? "all sources"\}…/);
  assert.match(dialog, /Couldn't search right now\. Try again\./);
  assert.match(dialog, /<TfErrorState[^>]*onRetry=\{retry\}/);
  assert.match(dialog, /data-release-alternative\b/);
  assert.match(dialog, /data-use-release/);
  assert.match(dialog, /data-release-health/);
});

test("switching disables every button, marks the pressed one and toasts the release name", () => {
  assert.match(dialog, /disabled=\{switching \|\| stale\}/);
  assert.match(dialog, /Find releases again/);
  assert.match(dialog, /CHOICES_TTL_MS = 10 \* 60_000/);
  assert.match(dialog, /sessionAwareFetch\(endpoint/);
  assert.doesNotMatch(dialog, /HTTP \$\{status\}/);
  assert.match(dialog, /Switching…/);
  assert.match(dialog, /toast\.success\(`Switched to \$\{candidate\.title\}`\)/);
  assert.match(dialog, /min-h-\[44px\]/);
});

test("find the best one for me posts best with the selected source and reuses the swap success path", () => {
  assert.match(dialog, /Find the best one for me/);
  assert.match(dialog, /Finding the best release…/);
  assert.match(dialog, /data-swap-best/);
  assert.match(dialog, /JSON\.stringify\(source \? \{ best: true, source \} : \{ best: true \}\)/);
  assert.match(dialog, /onSwapped\(releaseName\)/);
});

test("source picker is a keyboard radiogroup with counts, stable across refetches", () => {
  assert.match(dialog, /role="radiogroup"/);
  assert.match(dialog, /role="radio"/);
  assert.match(dialog, /data-swap-sources/);
  assert.match(dialog, /data-swap-source=\{option\.id \?\? "all"\}/);
  assert.match(dialog, /"All sources"/);
  assert.match(dialog, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.match(dialog, /aria-disabled=\{empty \|\| disabled \|\| undefined\}/);
  assert.match(dialog, /\?source=\$\{encodeURIComponent\(source\)\}/);
  assert.match(dialog, /mergeSources\(previous, body\.sources\)/);
  assert.match(dialog, /import \{ RULE_SOURCE_OPTIONS \} from "@\/lib\/rules\/form"/);
});

test("only the recommended card gets the Best match tag and the primary button", () => {
  assert.match(dialog, /candidate\.token === state\.data\.recommendedToken/);
  assert.match(dialog, /Best match/);
  assert.match(dialog, /data-recommended=\{recommended \? "true" : undefined\}/);
  assert.match(dialog, /data-swap-card/);
  assert.match(dialog, /variant=\{recommended \? "default" : "secondary"\}/);
  assert.doesNotMatch(dialog, /index === 0 \? "default"/);
});

test("Find another release is a row action on films and episode cards, and success refreshes the list", () => {
  for (const source of [page, series]) {
    assert.match(source, /canFindAnotherRelease\(t\) \? \(\s*<DropdownMenuItem\s*onClick=\{\(\) => onAction\("swap", t\)\}/);
    assert.match(source, /data-find-release/);
  }
  assert.match(page, /if \(act === "swap"\) \{ setSwapTorrent\(torrent\); return; \}/);
  assert.match(page, /onSwapped=\{[\s\S]*?invalidateInFlight\(\);[\s\S]*?void load\(\);/);
});

test("Downloads rows and episode cards keep text at 12px or larger and show Download now on the card", () => {
  for (const [name, source] of [["page.tsx", page], ["series-download-dialog.tsx", series]]) {
    assert.doesNotMatch(source, /text-\[(9|10|11)px\]/, `${name} has text under 12px`);
  }
  assert.match(series, /data-episode-force-now/);
  assert.match(series, /aria-label=\{`Download \$\{epLabel\} now`\}/);
});

test("menus cap their width so long release names wrap instead of pushing the menu off screen", () => {
  const menu = readFileSync(new URL("../src/components/ui/dropdown-menu.tsx", import.meta.url), "utf8");
  assert.match(menu, /max-w-\[min\(20rem,calc\(100vw-1rem\)\)\]/);
  assert.match(menu, /collisionPadding=\{collisionPadding\}/);
  assert.match(series, /data-find-release/);
  assert.match(page, /data-find-release/);
});

test("every unfinished built-in row offers Find another release, including queued and just-swapped rows", () => {
  const dialog = read("release-swap-dialog.tsx");
  const gate = dialog.match(/export function canFindAnotherRelease[\s\S]*?\n\}/)[0];
  // Imported/streaming rows are explained by the server in the dialog, never hidden by the menu.
  assert.doesNotMatch(gate, /imported/);
  assert.doesNotMatch(gate, /isQueued|isPaused|dlspeed|peers/);
  assert.match(gate, /ownerClientType === "builtin"/);
  assert.match(gate, /!\(Number\(t\.progress\) >= 0\.9999\)/);
  assert.match(dialog, /refused: res\.status === 409/);
  assert.match(dialog, /This release can't be replaced/);
});
