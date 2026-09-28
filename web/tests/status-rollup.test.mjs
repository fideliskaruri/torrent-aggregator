import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../src/app/downloads/${path}`, import.meta.url), "utf8");
const { outputText } = ts.transpileModule(read("status-rollup.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { summarizeStatus, needsAttentionLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const counts = (over) => ({ total: 0, downloading: 0, queued: 0, paused: 0, done: 0, error: 0, ...over });

test("nothing failed: no rollup label, the single combined state speaks", () => {
  assert.deepEqual(summarizeStatus(counts({ total: 3, downloading: 2, done: 1 })), { label: null, tone: "default" });
  assert.deepEqual(summarizeStatus(counts()), { label: null, tone: "default" });
});

test("owner's screenshot: 1 downloading and most failed reads as counts, error-toned", () => {
  const s = summarizeStatus(counts({ total: 39, downloading: 1, error: 30, queued: 8 }));
  assert.equal(s.label, "1 downloading · 8 queued · 30 need attention");
  assert.equal(s.tone, "danger");
});

test("a few failures among moving downloads stay accent-toned", () => {
  const s = summarizeStatus(counts({ total: 10, downloading: 8, error: 2 }));
  assert.equal(s.label, "8 downloading · 2 need attention");
  assert.equal(s.tone, "accent");
});

test("one failure uses the singular verb", () => {
  assert.equal(needsAttentionLabel(1), "1 needs attention");
  assert.equal(summarizeStatus(counts({ total: 5, downloading: 4, error: 1 })).label, "4 downloading · 1 needs attention");
});

test("nothing moving: any failure is error-toned, ready and paused are counted", () => {
  const s = summarizeStatus(counts({ total: 12, done: 10, paused: 1, error: 1 }));
  assert.equal(s.label, "1 paused · 10 ready · 1 needs attention");
  assert.equal(s.tone, "danger");
  assert.deepEqual(summarizeStatus(counts({ total: 2, error: 2 })), { label: "2 need attention", tone: "danger" });
});

test("exactly half failed while moving is not 'most'", () => {
  assert.equal(summarizeStatus(counts({ total: 4, downloading: 2, error: 2 })).tone, "accent");
  assert.equal(summarizeStatus(counts({ total: 5, downloading: 2, error: 3 })).tone, "danger");
});

test("grouping carries per-state counts on the series and every season", () => {
  const grouping = read("grouping.ts");
  assert.match(grouping, /counts: statusCounts\(all\)/);
  assert.match(grouping, /if \(isError\(state\)\) counts\.error \+= 1/);
});

test("dialog and overview row use the rollup, not one member's state or error line", () => {
  const dialog = read("series-download-dialog.tsx");
  const page = read("page.tsx");
  assert.match(dialog, /const chip = rollupChip\(group\)/);
  assert.match(dialog, /const chip = rollupChip\(season\)/);
  assert.match(dialog, /data-season-tab-failed/);
  assert.doesNotMatch(dialog, /data-group-error-message/);
  assert.match(dialog, /data-group-find-release/);
  assert.match(dialog, /Find another release for \{firstFailedLabel\}/);
  assert.match(dialog, /data-episode-find-release/);
  assert.match(dialog, /aria-expanded=\{errorExpanded\}/);
  assert.match(page, /const chip = rollupChip\(group\)/);
  assert.match(page, /group\.counts\.error === 1/);
});
