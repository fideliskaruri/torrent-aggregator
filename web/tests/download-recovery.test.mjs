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
test("recovery offers explicit, owner-only source scanning without scanning on mount", () => {
  assert.match(recovery, /\/api\/settings\/download-recovery\/sources/);
  assert.match(recovery, /data-import-other-client/);
  assert.match(recovery, /data-source-candidates/);
  assert.match(recovery, /cache: "no-store"/);
  assert.match(recovery, /function openSourceImport/);
  assert.match(recovery, /function openSourceImport\(\) \{\s*setSourceOpen\(true\);\s*void scanSources\(\)/);
  assert.doesNotMatch(recovery.slice(recovery.indexOf("useEffect(() =>"), recovery.indexOf("async function scanSources")), /scanSources\(/);
  assert.match(recovery, /mode !== "paths"/);
});
test("recovery requires acknowledgement and preserves other client data during import", () => {
  assert.match(recovery, /acknowledged: true/);
  assert.match(recovery, /data-source-acknowledgment/);
  assert.match(recovery, /!acknowledged/);
  assert.match(recovery, /never copied or moved/);
  assert.match(recovery, /without deleting data/);
  assert.match(recovery, /data-source-import-submit/);
});
test("recovery renders grouped source candidates with honest file state and recheck guidance", () => {
  assert.match(recovery, /data-source-group=\{source\}/);
  assert.match(recovery, /candidate\.savePath/);
  assert.match(recovery, /candidate\.dataExists/);
  assert.match(recovery, /candidate\.complete/);
  assert.match(recovery, /Hash will be rechecked/);
  assert.match(recovery, /candidate\.alreadyImported/);
  assert.match(recovery, /No other-client downloads were found/);
});
test("recovery appears in empty Downloads and Settings; paths live in Downloads Details", () => {
  const downloads = readFileSync(new URL("../src/app/downloads/page.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8");
  assert.match(downloads, /DownloadRecovery mode="paths"/);
  assert.match(downloads, /DownloadRecovery mode="empty" onImported=/);
  assert.match(settings, /DownloadRecovery revision=\{savedForm\.baseDownloadPath\}/);
});
