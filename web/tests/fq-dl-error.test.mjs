import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { readFileSync } from "node:fs";
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

const {
  isError,
  isPaused,
  groupDownloads,
} = await server.ssrLoadModule("/src/app/downloads/grouping.ts");
const {
  canDownloadNow,
  forcedStartLabel,
  isVerifiedDownload,
  stateBadgeVariant,
  stateLabel,
  transferErrorMessage,
} = await server.ssrLoadModule("/src/app/downloads/release-display.ts");

const pageSrc = readFileSync(new URL("../src/app/downloads/page.tsx", import.meta.url), "utf8");
const dialogSrc = readFileSync(
  new URL("../src/app/downloads/series-download-dialog.tsx", import.meta.url),
  "utf8",
);

function row(partial) {
  return {
    hash: partial.hash ?? "a".repeat(40),
    transferId: partial.transferId ?? `builtin:${partial.hash ?? "a".repeat(40)}`,
    name: partial.name ?? "Example.mkv",
    progress: partial.progress ?? 0,
    sizeBytes: partial.sizeBytes ?? 1_000_000,
    dlspeed: partial.dlspeed ?? 0,
    upspeed: partial.upspeed ?? 0,
    state: partial.state,
    category: partial.category ?? "movies",
    workKey: partial.workKey ?? null,
    workTitle: partial.workTitle ?? null,
    error: partial.error,
  };
}

test("error is not paused", () => {
  assert.equal(isError("error"), true);
  assert.equal(isError("ERROR"), true);
  assert.equal(isError("missingFiles"), true);
  assert.equal(isPaused("error"), false);
  assert.equal(isPaused("missingfiles"), false);
  assert.equal(isPaused("paused"), true);
  assert.equal(isPaused("pausedDL"), true);
});

test("state label and badge treat error as Error / danger", () => {
  assert.equal(stateLabel("error"), "Error");
  assert.equal(stateBadgeVariant("error"), "danger");
  assert.equal(stateBadgeVariant("missingFiles"), "danger");
  assert.notEqual(stateBadgeVariant("paused"), "danger");
});

test("transferErrorMessage reads the contract's error field", () => {
  assert.equal(
    transferErrorMessage({ state: "error", error: "  Metadata timeout  " }),
    "Metadata timeout",
  );
  assert.equal(transferErrorMessage({ state: "error", error: null }), null);
  assert.equal(transferErrorMessage({ state: "error", error: "   " }), null);
  assert.equal(transferErrorMessage({ state: "downloading", error: "x" }), null);
  assert.equal(transferErrorMessage({ state: "paused" }), null);
});

test("forced rows stop offering Download now and say they're starting", () => {
  assert.equal(canDownloadNow({ state: "queued" }), true);
  assert.equal(canDownloadNow({ state: "queued", forced: false }), true);
  assert.equal(canDownloadNow({ state: "queued", forced: true }), false);
  assert.equal(canDownloadNow({ state: "downloading" }), false);
  assert.equal(forcedStartLabel({ state: "queued", forced: true }), "Starting now");
  assert.equal(forcedStartLabel({ state: "queued" }), null);
  assert.equal(forcedStartLabel({ state: "downloading", forced: true }), null);
});

test("verified only shows on finished rows", () => {
  assert.equal(isVerifiedDownload({ state: "downloaded", verified: true }), true);
  assert.equal(isVerifiedDownload({ state: "downloaded", verified: false }), false);
  assert.equal(isVerifiedDownload({ state: "downloaded" }), false);
  assert.equal(isVerifiedDownload({ state: "downloading", verified: true }), false);
});
test("group aggregate state is error when a member failed", () => {
  const groups = groupDownloads([
    row({
      hash: "b".repeat(40),
      name: "Show.S01E01.mkv",
      state: "downloaded",
      category: "tv",
      workKey: "tv:show",
      workTitle: "Show",
      progress: 1,
    }),
    row({
      hash: "c".repeat(40),
      name: "Show.S01E02.mkv",
      state: "error",
      category: "tv",
      workKey: "tv:show",
      workTitle: "Show",
      error: "Metadata timeout",
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "series");
  assert.equal(isError(groups[0].state), true);
  assert.equal(isPaused(groups[0].state), false);
});

test("downloads UI wires error badge, message, and retry", () => {
  assert.match(pageSrc, /stateBadgeVariant/);
  assert.match(pageSrc, /transferErrorMessage/);
  assert.match(pageSrc, /data-torrent-error-message/);
  assert.match(pageSrc, /data-torrent-retry/);
  assert.match(pageSrc, /isError\(t\.state\)/);
  assert.match(dialogSrc, /data-episode-error-message/);
  assert.match(pageSrc, /canDownloadNow\(t\) && isBuiltin/);
  assert.match(pageSrc, /data-torrent-verified/);
  assert.match(pageSrc, /data-torrent-forced/);
  assert.match(dialogSrc, /canDownloadNow\(t\) && isBuiltin/);
  assert.match(dialogSrc, /data-episode-verified/);
  assert.match(dialogSrc, /data-episode-forced/);
  assert.doesNotMatch(pageSrc, /isQueued\(t\.state\) && isBuiltin/);
  assert.doesNotMatch(dialogSrc, /isQueued\(t\.state\) && isBuiltin/);
  assert.match(dialogSrc, /isError\(t\.state\) \? "Retry"/);
  assert.doesNotMatch(
    readFileSync(new URL("../src/app/downloads/grouping.ts", import.meta.url), "utf8"),
    /PAUSED_STATES = new Set\(\[[^\]]*["']error["']/,
  );
});
