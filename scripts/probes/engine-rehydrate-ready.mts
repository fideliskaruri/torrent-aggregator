/**
 * Measures how long a fully-downloaded built-in torrent takes to become
 * `ready` with verified target pieces after engine rehydrate.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-rehydrate-ready.mts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { prisma } from "../../src/lib/prisma";
import { ensureDir, startLocalSwarm } from "../lib/local-swarm.mjs";
import {
  builtinClient,
  findLiveBuiltinTorrent,
  shutdownBuiltinEngine,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "../../src/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "../../src/lib/clients";

type ProbeTorrent = BuiltinStreamTorrent & {
  length: number;
  ready: boolean;
  done: boolean;
  pieceLength?: number;
  bitfield?: { get(index: number): boolean };
  on(event: string, fn: (...args: unknown[]) => void): void;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-rehydrate-ready");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const userId = `probe-rehydrate-${randomUUID()}`;
const episodeBytes = 32 * 1024 * 1024;
const requestedEpisode = 3;

const config: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  userId,
  savePath: leechRoot,
  baseDownloadPath: leechRoot,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFixtureFile(filePath: string, size: number, marker: number) {
  const fd = fs.openSync(filePath, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, marker);
    let written = 0;
    while (written < size) {
      const n = Math.min(chunk.length, size - written);
      fs.writeSync(fd, chunk, 0, n, written);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function makeSeasonPack(): { dir: string; requestedName: string } {
  fs.rmSync(workRoot, { recursive: true, force: true });
  ensureDir(seedRoot);
  ensureDir(leechRoot);
  const dir = ensureDir(path.join(seedRoot, "Rehydrate Probe S01 Complete"));
  let requestedName = "";
  for (const ep of [1, 2, 3, 4]) {
    const name = `Rehydrate.Probe.S01E${String(ep).padStart(2, "0")}.bin`;
    writeFixtureFile(path.join(dir, name), episodeBytes, ep);
    if (ep === requestedEpisode) requestedName = name;
  }
  return { dir, requestedName };
}

function pieceRange(file: BuiltinStreamFile): { start: number; end: number } {
  const f = file as BuiltinStreamFile & { _startPiece?: number; _endPiece?: number };
  const start = f._startPiece;
  const end = f._endPiece;
  if (typeof start !== "number") throw new Error("file has no _startPiece");
  if (typeof end !== "number") throw new Error("file has no _endPiece");
  return { start, end };
}

function verifiedPieces(torrent: ProbeTorrent, range: { start: number; end: number }): number {
  let count = 0;
  for (let i = range.start; i <= range.end; i += 1) {
    if (torrent.bitfield?.get(i)) count += 1;
  }
  return count;
}

function isRangeFullyVerified(torrent: ProbeTorrent, range: { start: number; end: number }): boolean {
  return verifiedPieces(torrent, range) === range.end - range.start + 1;
}

function findTarget(torrent: ProbeTorrent, requestedName: string): BuiltinStreamFile {
  const files = torrent.files ?? [];
  const target = files.find((f) => f.path.replace(/\\/g, "/").endsWith(requestedName));
  assert.ok(target, `requested file not found: ${files.map((f) => f.path).join(", ")}`);
  return target;
}

async function waitForLive(hash: string, timeoutMs: number): Promise<ProbeTorrent> {
  const started = performance.now();
  for (;;) {
    const torrent = findLiveBuiltinTorrent(hash) as ProbeTorrent | null;
    if (torrent) return torrent;
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for live torrent");
    await sleep(25);
  }
}

async function waitForComplete(hash: string, requestedName: string, timeoutMs: number) {
  const started = performance.now();
  let targetRange: { start: number; end: number } | null = null;
  for (;;) {
    const torrent = await waitForLive(hash, timeoutMs);
    const target = findTarget(torrent, requestedName);
    targetRange = pieceRange(target);
    if (torrent.ready && isRangeFullyVerified(torrent, targetRange) && torrent.progress >= 0.9999) {
      return { torrent, target, targetRange, ms: performance.now() - started };
    }
    if (performance.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for complete download: ready=${torrent.ready} progress=${torrent.progress} ` +
          `targetVerified=${targetRange ? verifiedPieces(torrent, targetRange) : "?"}`,
      );
    }
    await sleep(100);
  }
}

async function waitForRehydrateVerified(hash: string, requestedName: string, timeoutMs: number) {
  const started = performance.now();
  let sawLiveAt: number | null = null;
  let sawFilesAt: number | null = null;
  let targetRange: { start: number; end: number } | null = null;
  for (;;) {
    const torrent = findLiveBuiltinTorrent(hash) as ProbeTorrent | null;
    if (torrent && sawLiveAt == null) sawLiveAt = performance.now() - started;
    if (torrent && (torrent.files?.length ?? 0) > 0 && sawFilesAt == null) sawFilesAt = performance.now() - started;
    if (torrent && (torrent.files?.length ?? 0) > 0) {
      const target = findTarget(torrent, requestedName);
      targetRange = pieceRange(target);
      if (torrent.ready && isRangeFullyVerified(torrent, targetRange)) {
        return {
          torrent,
          target,
          targetRange,
          liveMs: sawLiveAt,
          filesMs: sawFilesAt,
          readyVerifiedMs: performance.now() - started,
        };
      }
    }
    if (performance.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for rehydrate verification: live=${sawLiveAt != null} files=${sawFilesAt != null} ` +
          `targetVerified=${torrent && targetRange ? verifiedPieces(torrent, targetRange) : "?"}`,
      );
    }
    await sleep(25);
  }
}

async function main() {
  const pack = makeSeasonPack();
  const swarm = await startLocalSwarm();
  let hash = "";
  try {
    const seeded = await swarm.seed(pack.dir);
    hash = seeded.infoHash.toLowerCase();
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, name: "Rehydrate Probe" },
    });
    await prisma.engineTorrent.deleteMany({ where: { userId } });

    const add = await builtinClient.addTorrent(config, {
      magnet: seeded.magnetURI,
      savePath: leechRoot,
      name: "Rehydrate Probe S01 Complete",
      category: "tv",
      purpose: "keep",
    });
    assert.equal(add.ok, true, add.message);

    const initial = await waitForComplete(hash, pack.requestedName, 120_000);
    await shutdownBuiltinEngine();

    const rehydrateStarted = performance.now();
    const list = await builtinClient.listTorrents(config);
    const listReturnedMs = performance.now() - rehydrateStarted;
    assert.ok(list.some((t) => t.hash.toLowerCase() === hash), "rehydrated row missing from listTorrents");
    const rehydrated = await waitForRehydrateVerified(hash, pack.requestedName, 120_000);

    console.log(
      JSON.stringify(
        {
          verdict: rehydrated.readyVerifiedMs > 10_000 ? "rehydrate-verification-slow" : "rehydrate-verification-fast",
          infoHash: hash,
          requestedFile: rehydrated.target.path,
          requestedFileIndex: rehydrated.torrent.files?.indexOf(rehydrated.target),
          episodeBytes,
          pieceLength: rehydrated.torrent.pieceLength,
          targetPieces: rehydrated.targetRange,
          initialDownloadCompleteMs: Math.round(initial.ms),
          rehydrateListReturnedMs: Math.round(listReturnedMs),
          rehydrateLiveMs: rehydrated.liveMs == null ? null : Math.round(rehydrated.liveMs),
          rehydrateFilesMs: rehydrated.filesMs == null ? null : Math.round(rehydrated.filesMs),
          rehydrateReadyTargetVerifiedMs: Math.round(rehydrated.readyVerifiedMs),
          targetVerifiedPieces: verifiedPieces(rehydrated.torrent, rehydrated.targetRange),
          targetTotalPieces: rehydrated.targetRange.end - rehydrated.targetRange.start + 1,
          progress: rehydrated.torrent.progress,
          peers: rehydrated.torrent.numPeers,
        },
        null,
        2,
      ),
    );
  } finally {
    await shutdownBuiltinEngine().catch(() => false);
    await swarm.close().catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
