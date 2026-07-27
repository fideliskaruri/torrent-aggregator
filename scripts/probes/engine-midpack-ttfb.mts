/**
 * Isolated built-in-engine measurement for first byte of a mid-pack file.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-midpack-ttfb.mts
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
  paused: boolean;
  pieceLength?: number;
  bitfield?: { get(index: number): boolean };
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-midpack-ttfb");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const episodeBytes = 32 * 1024 * 1024;
const requestedEpisode = 3;

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
  const dir = ensureDir(path.join(seedRoot, "Probe Show S01 Complete"));
  let requestedName = "";
  for (const ep of [1, 2, 3, 4]) {
    const name = `Probe.Show.S01E${String(ep).padStart(2, "0")}.bin`;
    writeFixtureFile(path.join(dir, name), episodeBytes, ep);
    if (ep === requestedEpisode) requestedName = name;
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

async function readFirstByte(file: BuiltinStreamFile): Promise<number> {
  const reader = file.stream({ start: 0, end: 1 }).getReader();
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
    try {
      torrent.destroy({ destroyStore: true }, () => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 5_000).unref();
  });
}

async function main() {
  const pack = makeSeasonPack();
  const swarm = await startLocalSwarm();
  let torrent: ProbeTorrent | null = null;
  try {
    const seeded = await swarm.seed(pack.dir);
    const client = await getBuiltinClientForProbe();
    const addStarted = performance.now();
    torrent = addTorrentWithEngineDefaults(
      client,
      seeded.magnetURI,
      leechRoot,
    ) as unknown as ProbeTorrent;
    const metadataMs = await once(torrent, "metadata", 60_000).catch(() => NaN);
    if (!torrent.ready) await once(torrent, "ready", 60_000);
    const readyMs = performance.now() - addStarted;

    const files = torrent.files ?? [];
    const target = files.find((f) => f.path.replace(/\\/g, "/").endsWith(pack.requestedName));
    assert.ok(target, `requested episode not found in torrent files: ${files.map((f) => f.path).join(", ")}`);
    const targetRange = pieceRange(target);
    const beforeVerified = verifiedPieces(torrent, targetRange);

    const requestStarted = performance.now();
    prioritizeBuiltinStreamFile(torrent, target, {
      seekOffset: 0,
      onPrefetchError(err) {
        console.warn(`[probe] edge prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    const byte = await readFirstByte(target);
    const ttfbMs = performance.now() - requestStarted;
    const afterVerified = verifiedPieces(torrent, targetRange);

    console.log(
      JSON.stringify(
        {
          verdict: "engine-fast-in-isolation",
          infoHash: torrent.infoHash,
          files: files.map((f) => f.path),
          requestedFile: target.path,
          requestedFileIndex: files.indexOf(target),
          episodeBytes,
          pieceLength: torrent.pieceLength,
          targetPieces: targetRange,
          targetVerifiedBeforeRequest: beforeVerified,
          targetVerifiedAfterFirstByte: afterVerified,
          metadataMs: Number.isFinite(metadataMs) ? Math.round(metadataMs) : null,
          readyMs: Math.round(readyMs),
          ttfbMs: Math.round(ttfbMs),
          firstByte: byte,
          peers: torrent.numPeers,
          progress: torrent.progress,
        },
        null,
        2,
      ),
    );
  } finally {
    if (torrent) await destroyTorrent(torrent);
    await shutdownBuiltinEngine().catch(() => false);
    await swarm?.close().catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
