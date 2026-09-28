import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});

const { resolveTitleTransferControl } = await server.ssrLoadModule(
  "/src/components/title/title-actions.ts",
);
await server.close();

const transfer = (status, progress = 0, error = null) => ({
  status,
  progress,
  infoHash: status === "failed" ? null : "abc",
  filePath: null,
  error,
});
const see = { canSeeTransfers: true };

test("no transfer offers a runnable Download", () => {
  assert.deepEqual(resolveTitleTransferControl(null, "idle", see), {
    intent: "download",
    label: "Download",
    canRun: true,
    opensDownloads: false,
    error: null,
  });
});

test("queued, downloading and downloaded report status and open Downloads — never Retry", () => {
  for (const [state, progress, label] of [
    ["queued", 0, "Queued"],
    ["downloading", 0.427, "Downloading 42%"],
    ["downloaded", 1, "Downloaded"],
  ]) {
    for (const press of ["idle", "done", "error"]) {
      const control = resolveTitleTransferControl(transfer(state, progress), press, see);
      assert.equal(control.intent, "status", `${state}/${press}`);
      assert.equal(control.label, label);
      assert.equal(control.canRun, false);
      assert.equal(control.opensDownloads, true);
      assert.doesNotMatch(control.label, /retry/i);
    }
  }
});

test("status stays a status without the transfers capability", () => {
  const control = resolveTitleTransferControl(transfer("downloaded", 1), "idle", {
    canSeeTransfers: false,
  });
  assert.equal(control.intent, "status");
  assert.equal(control.opensDownloads, false);
});

test("only a failed transfer or a failed press offers Retry download", () => {
  const failed = resolveTitleTransferControl(
    transfer("failed", 0, "The requested file is no longer available."),
    "idle",
    see,
  );
  assert.equal(failed.intent, "retry");
  assert.equal(failed.label, "Retry download");
  assert.equal(failed.canRun, true);
  assert.equal(failed.error, "The requested file is no longer available.");

  const pressFailed = resolveTitleTransferControl(null, "error", see);
  assert.equal(pressFailed.intent, "retry");
  assert.equal(pressFailed.canRun, true);
});

test("an in-flight or spent press cannot grab twice", () => {
  assert.equal(resolveTitleTransferControl(null, "pending", see).canRun, false);
  assert.equal(resolveTitleTransferControl(null, "done", see).canRun, false);
  assert.equal(resolveTitleTransferControl(transfer("failed"), "pending", see).canRun, false);
});

test("library controls render independent of transfer state with a remove path", () => {
  const detail = readFileSync("src/components/title/title-detail.tsx", "utf8");
  const library = readFileSync("src/components/title/library-controls.tsx", "utf8");
  // The library control is rendered on capability alone, never inside a transfer branch.
  assert.match(detail, /\{caps\.canManage \? \(\s*<LibraryControls/);
  assert.match(library, /data-remove-from-library/);
  assert.match(library, /method: "DELETE"/);
  assert.match(library, /Remove, keep files/);
  assert.match(detail, /resolveTitleTransferControl\(titleTransfer, downloadStatus/);
  assert.match(detail, /to="\/downloads"/);
});
