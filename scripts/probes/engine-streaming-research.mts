/**
 * Streaming speed research probe for the built-in engine.
 *
 * It keeps Next.js and the browser out of the loop and measures the engine-side
 * phases that can make playback wait: metadata, ready/file-list exposure, first
 * byte from a mid-pack file, and first byte from that file's tail (container
 * index/cues region). This is intentionally loopback-only and repeatable.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-streaming-research.mts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { ensureDir, startLocalSwarm } from "../lib/local-swarm.mjs";
import {
  addTorrentWithEngineDefaults,
  getBuiltinClientForProbe,
  prioritizeBuiltinStreamFile,
  shutdownBuiltinEngine,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "../../src/lib/clients/builtin-engine";

type ProbeTorrent = BuiltinStreamTorrent & {
  length: number;
  ready: boolean;
  pieceLength?: number;
  bitfield?: { get(index: number): boolean };
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-streaming-research");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const episodeBytes = 32 * 1024 * 1024;
const runs = Number(process.argv[2] ?? 3);

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

function makeSeasonPack(label: string): { dir: string; requestedName: string } {
  const dir = ensureDir(path.join(seedRoot, `${label} S01 Complete`));
  let requestedName = "";
  for (const ep of [1, 2, 3, 4]) {
    const name = `${label}.S01E${String(ep).padStart(2, "0")}.bin`;
    writeFixtureFile(path.join(dir, name), episodeBytes, ep);
    if (ep === 3) requestedName = name;
  }
  return { dir, requestedName };
}

function once(torrent: ProbeTorrent, event: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    torrent.on(event, () => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
  });
}

function pieceRange(file: BuiltinStreamFile): { start: number; end: number } {
  const f = file as BuiltinStreamFile & { _startPiece?: number; _endPiece?: number };
  if (typeof f._startPiece !== "number") throw new Error("file has no _startPiece");
  if (typeof f._endPiece !== "number") throw new Error("file has no _endPiece");
  return { start: f._startPiece, end: f._endPiece };
}

function verifiedPieces(torrent: ProbeTorrent, range: { start: number; end: number }): number {
  let count = 0;
  for (let i = range.start; i <= range.end; i += 1) if (torrent.bitfield?.get(i)) count += 1;
  return count;
}

async function readFirstByte(file: BuiltinStreamFile, start: number): Promise<number> {
  const reader = file.stream({ start, end: Math.max(start + 1, 1) }).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error("stream ended before first byte");
      if (next.value.byteLength > 0) return next.value[0];
    }
  } finally {
    await reader.cancel("probe complete").catch(() => undefined);
  }
}

async function destroyTorrent(torrent: ProbeTorrent): Promise<void> {
  await new Promise<void>((resolve) => {
    try { torrent.destroy({ destroyStore: true }, () => resolve()); } catch { resolve(); }
    setTimeout(resolve, 5_000).unref();
  });
}

async function measureRun(index: number) {
  const label = `Research${index}`;
  const pack = makeSeasonPack(label);
  const swarm = await startLocalSwarm();
  let torrent: ProbeTorrent | null = null;
  try {
    const seeded = await swarm.seed(pack.dir);
    const client = await getBuiltinClientForProbe();
    const addStarted = performance.now();
    torrent = addTorrentWithEngineDefaults(client, seeded.magnetURI, leechRoot) as unknown as ProbeTorrent;
    const metadataMs = await once(torrent, "metadata", 60_000).catch(() => NaN);
    if (!torrent.ready) await once(torrent, "ready", 60_000);
    const readyMs = performance.now() - addStarted;
    const files = torrent.files ?? [];
    const target = files.find((f) => f.path.replace(/\\/g, "/").endsWith(pack.requestedName));
    assert.ok(target, `target file missing; files=${files.map((f) => f.path).join(",")}`);
    const targetPieces = pieceRange(target);
    const beforeVerified = verifiedPieces(torrent, targetPieces);

    const headStarted = performance.now();
    prioritizeBuiltinStreamFile(torrent, target, { seekOffset: 0, onPrefetchError: () => undefined });
    const headByte = await readFirstByte(target, 0);
    const headTtfbMs = performance.now() - headStarted;

    const tailStart = Math.max(0, target.length - 2 * 1024 * 1024);
    const tailStarted = performance.now();
    const tailByte = await readFirstByte(target, tailStart);
    const tailTtfbMs = performance.now() - tailStarted;

    return {
      run: index,
      infoHash: torrent.infoHash,
      filesExposedAtProgress: torrent.progress,
      fileCount: files.length,
      requestedFile: target.path,
      requestedFileIndex: files.indexOf(target),
      pieceLength: torrent.pieceLength,
      targetPieces,
      targetVerifiedBeforeRequest: beforeVerified,
      metadataMs: Math.round(metadataMs),
      readyMs: Math.round(readyMs),
      headTtfbMs: Math.round(headTtfbMs),
      tailTtfbMs: Math.round(tailTtfbMs),
      headByte,
      tailByte,
      progressAfter: torrent.progress,
      peers: torrent.numPeers,
    };
  } finally {
    if (torrent) await destroyTorrent(torrent);
    await shutdownBuiltinEngine().catch(() => false);
    await swarm.close().catch(() => undefined);
  }
}

async function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  ensureDir(seedRoot);
  ensureDir(leechRoot);
  const results = [];
  try {
    for (let i = 1; i <= runs; i += 1) results.push(await measureRun(i));
    const head = results.map((r) => r.headTtfbMs);
    const tail = results.map((r) => r.tailTtfbMs);
    console.log(JSON.stringify({
      runs: results,
      summary: {
        headTtfbMs: { min: Math.min(...head), max: Math.max(...head) },
        tailTtfbMs: { min: Math.min(...tail), max: Math.max(...tail) },
      },
    }, null, 2));
  } finally {
    await shutdownBuiltinEngine().catch(() => false);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
