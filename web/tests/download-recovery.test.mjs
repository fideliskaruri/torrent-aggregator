import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const recovery = readFileSync(new URL("../src/components/settings/download-recovery.tsx", import.meta.url), "utf8");
test("recovery hides owner-only routes on 404 and does not cache storage paths", () => {
  assert.match(recovery, /response\.status === 404/);
  assert.match(recovery, /setInfo\(null\)/);
  assert.match(recovery, /cache: "no-store"/);
});
test("recovery waits for completion, disables duplicate submissions and uses toast feedback", () => {
  assert.match(recovery, /disabled=\{busy \|\| !info\.downloadDirectory\}/);
  assert.match(recovery, /Scanning and importing/);
  assert.match(recovery, /toast\.success/);
  assert.match(recovery, /toast\.error/);
  assert.match(recovery, /finally \{ setBusy\(false\); \}/);
});
test("recovery appears in empty Downloads and Settings; paths live in Downloads Details", () => {
  const downloads = readFileSync(new URL("../src/app/downloads/page.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8");
  assert.match(downloads, /DownloadRecovery mode="paths"/);
  assert.match(downloads, /DownloadRecovery mode="empty" onImported=/);
  assert.match(settings, /DownloadRecovery revision=\{savedForm\.baseDownloadPath\}/);
});
