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
  assert.match(dialog, /No other releases found\./);
  assert.match(dialog, /Try again later or search for the title\./);
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
