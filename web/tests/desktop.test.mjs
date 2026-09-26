import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  await server.close();
});
const desktop = await server.ssrLoadModule("/src/lib/desktop.ts");

const idle = { state: "idle", receivedBytes: 0, totalBytes: null, error: null };

function status(overrides = {}) {
  return {
    supported: true,
    platform: "windows",
    version: "1.0.0",
    editable: true,
    autostart: { available: true, enabled: false, pointsElsewhere: false },
    updates: {
      available: true,
      enabled: true,
      checking: false,
      lastCheckedAt: null,
      lastError: null,
      updateAvailable: true,
      latest: { version: "1.1.0", tag: "v1.1.0", pageUrl: "https://github.com/x", hasInstaller: true },
      install: idle,
      ...overrides.updates,
    },
    ffmpeg: {
      ffmpeg: null,
      ffprobe: null,
      managed: false,
      canDownload: true,
      toolsDirectory: "C:\\tools",
      packageLabel: "ffmpeg 7.1.1",
      packageSize: 92234348,
      download: idle,
    },
    ...overrides.root,
  };
}

test("update banner shows for an offered update until that version is dismissed", () => {
  assert.equal(desktop.shouldShowUpdateBanner(status(), null), true);
  assert.equal(desktop.shouldShowUpdateBanner(status(), "1.1.0"), false);
  assert.equal(desktop.shouldShowUpdateBanner(status(), "1.0.5"), true);
});

test("update banner stays hidden off-desktop, for remote viewers, and with no update", () => {
  assert.equal(desktop.shouldShowUpdateBanner(null, null), false);
  assert.equal(desktop.shouldShowUpdateBanner(status({ root: { supported: false } }), null), false);
  assert.equal(desktop.shouldShowUpdateBanner(status({ root: { editable: false } }), null), false);
  assert.equal(desktop.shouldShowUpdateBanner(status({ updates: { updateAvailable: false } }), null), false);
  assert.equal(desktop.shouldShowUpdateBanner(status({ updates: { latest: null } }), null), false);
});

test("update banner stays visible while an install runs even if dismissed", () => {
  const running = status({ updates: { install: { ...idle, state: "downloading", receivedBytes: 5, totalBytes: 10 } } });
  assert.equal(desktop.shouldShowUpdateBanner(running, "1.1.0"), true);
});

test("progress percent clamps and needs a known size", () => {
  assert.equal(desktop.progressPercent({ ...idle, receivedBytes: 50, totalBytes: 200 }), 25);
  assert.equal(desktop.progressPercent({ ...idle, receivedBytes: 500, totalBytes: 200 }), 100);
  assert.equal(desktop.progressPercent({ ...idle, receivedBytes: 50, totalBytes: null }), null);
  assert.equal(desktop.progressPercent({ ...idle, receivedBytes: 50, totalBytes: 0 }), null);
});

test("busy only while downloading or installing", () => {
  assert.equal(desktop.isBusy({ ...idle, state: "downloading" }), true);
  assert.equal(desktop.isBusy({ ...idle, state: "installing" }), true);
  assert.equal(desktop.isBusy({ ...idle, state: "failed" }), false);
  assert.equal(desktop.isBusy(null), false);
});

test("megabytes are whole and empty for unknown sizes", () => {
  assert.equal(desktop.formatMegabytes(92234348), "88 MB");
  assert.equal(desktop.formatMegabytes(null), "");
  assert.equal(desktop.formatMegabytes(0), "");
});
