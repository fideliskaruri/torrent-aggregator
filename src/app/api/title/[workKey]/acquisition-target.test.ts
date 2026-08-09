import assert from "node:assert/strict";
import {
  acquisitionTargetKey,
  resolveAcquisitionTransfer,
  validateAcquisitionScope,
} from "./acquisition-target";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\ntitle acquisition targets");

check("episode target key is stable and distinct from season scope", () => {
  assert.equal(
    acquisitionTargetKey("the-bear-2022", "episode", 2, 7),
    "the-bear-2022:episode:2:7",
  );
  assert.notEqual(
    acquisitionTargetKey("the-bear-2022", "episode", 2, 7),
    acquisitionTargetKey("the-bear-2022", "season", 2, null),
  );
});

check("episode scope requires exactly one explicit episode", () => {
  assert.deepEqual(
    validateAcquisitionScope({
      scope: "episode",
      season: 1,
      episode: 2,
      episodes: null,
      infoHash: null,
    }),
    { ok: true, scope: "episode", season: 1, episode: 2 },
  );
  assert.equal(
    validateAcquisitionScope({
      scope: "episode",
      season: 1,
      episode: 2,
      episodes: null,
      infoHash: "a".repeat(40),
    }).ok,
    false,
  );
});

check("persisted queued/downloading/downloaded transitions are target-linked", () => {
  const base = {
    status: "queued",
    progress: 0,
    infoHash: null,
    filePath: null,
    error: null,
  } as const;
  assert.equal(resolveAcquisitionTransfer(base, null).status, "queued");

  const downloading = resolveAcquisitionTransfer(
    { ...base, status: "downloading", infoHash: "b".repeat(40) },
    { hash: "b".repeat(40), status: "downloading", progress: 0.061 },
  );
  assert.equal(downloading.status, "downloading");
  assert.equal(downloading.progress, 0.061);

  const downloaded = resolveAcquisitionTransfer(
    { ...base, status: "downloading", infoHash: "b".repeat(40) },
    { hash: "b".repeat(40), status: "seeding", progress: 1 },
  );
  assert.equal(downloaded.status, "downloaded");
  assert.equal(downloaded.progress, 1);
});

check("an unrelated 12.69GB pack cannot become E02 state", () => {
  const target = {
    status: "downloading",
    progress: 0.061,
    infoHash: "c".repeat(40),
    filePath: null,
    error: null,
  } as const;
  const unrelatedPack = {
    hash: "d".repeat(40),
    status: "seeding",
    progress: 1,
    sizeBytes: 12_690_000_000,
  };
  const resolved = resolveAcquisitionTransfer(target, unrelatedPack);
  assert.equal(resolved.status, "downloading");
  assert.equal(resolved.progress, 0.061);
});

check("a deleted linked torrent cannot remain downloaded or playable", () => {
  const resolved = resolveAcquisitionTransfer(
    {
      status: "downloaded",
      progress: 1,
      infoHash: "e".repeat(40),
      filePath: "Show.S01E02.mkv",
      error: null,
    },
    null,
    "unknown",
  );
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.progress, 0);
  assert.equal(resolved.infoHash, null);
  assert.equal(resolved.filePath, null);
  assert.match(resolved.error ?? "", /no longer available/i);
});

check("an existing linked playable file remains downloaded", () => {
  const hash = "f".repeat(40);
  const resolved = resolveAcquisitionTransfer(
    {
      status: "downloaded",
      progress: 1,
      infoHash: hash,
      filePath: "Show.S01E02.mkv",
      error: null,
    },
    { hash, status: "seeding", progress: 1 },
    "present",
  );
  assert.equal(resolved.status, "downloaded");
  assert.equal(resolved.progress, 1);
  assert.equal(resolved.infoHash, hash);
  assert.equal(resolved.filePath, "Show.S01E02.mkv");
  assert.equal(resolved.error, null);
});

check("a confirmed-missing linked file is reconciled to failed", () => {
  const hash = "1".repeat(40);
  const resolved = resolveAcquisitionTransfer(
    {
      status: "downloaded",
      progress: 1,
      infoHash: hash,
      filePath: "Show.S01E02.mkv",
      error: null,
    },
    { hash, status: "seeding", progress: 1 },
    "absent",
  );
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.infoHash, null);
});

check("a 100 percent errored transfer cannot re-promote a failed target", () => {
  const hash = "2".repeat(40);
  const resolved = resolveAcquisitionTransfer(
    {
      status: "failed",
      progress: 1,
      infoHash: hash,
      filePath: "Show.S01E10.scr",
      error: "The downloaded release could not be used.",
    },
    { hash, status: "error", progress: 1 },
    "unknown",
  );
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.progress, 0);
  assert.equal(resolved.infoHash, null);
});

console.log(
  `\n${failures === 0 ? "acquisition-target: all tests passed" : `acquisition-target: ${failures} failing`}`,
);
process.exit(failures === 0 ? 0 : 1);
