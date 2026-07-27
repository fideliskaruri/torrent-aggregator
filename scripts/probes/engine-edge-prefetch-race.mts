/**
 * Compare startup head delivery when edge prefetch drains file head+tail
 * concurrently versus deferring the tail until after the head edge is drained.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-edge-prefetch-race.mts 5
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { ensureDir, startLocalSwarm } from "../lib/local-swarm.mjs";
import {
  addTorrentWithEngineDefaults,
  prioritizeBuiltinStreamFile,
  shutdownBuiltinEngine,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "../../src/lib/clients/builtin-engine";

type ProbeTorrent = BuiltinStreamTorrent & {
  ready: boolean;
  files: BuiltinStreamFile[];
  progress: number;
  numPeers: number;
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
};

type RaceResult = {
  mode: "concurrent-tail" | "deferred-tail";
  run: number;
  firstByteMs: number;
  headDrainMs: number;
  firstByte: number;
  progress: number;
  peers: number;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-edge-prefetch-race");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const edgeBytes = 2 * 1024 * 1024;
const episodeBytes = 32 * 1024 * 1024;
const runCount = Number(process.argv[2] ?? 5);

function writeFixtureFile(filePath: string, size: number, marker: number) {
  const fd = fs.openSync(filePath, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, marker);
    for (let written = 0; written < size;) {
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

async function drainRange(file: BuiltinStreamFile, range: { start: number; end: number }) {
  const reader = file.stream(range).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
    }
  } finally {
    await reader.cancel("probe complete").catch(() => undefined);
  }
}

async function concurrentEdges(_torrent: BuiltinStreamTorrent, file: BuiltinStreamFile) {
  const lastByte = Math.max(0, file.length - 1);
  const ranges = [{ start: 0, end: Math.min(lastByte, edgeBytes - 1) }];
  if (file.length > edgeBytes) ranges.push({ start: file.length - edgeBytes, end: lastByte });
  const settled = await Promise.allSettled(ranges.map((range) => drainRange(file, range)));
  const failed = settled.find((s) => s.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
}

async function deferredTailEdges(_torrent: BuiltinStreamTorrent, file: BuiltinStreamFile) {
  const lastByte = Math.max(0, file.length - 1);
  await drainRange(file, { start: 0, end: Math.min(lastByte, edgeBytes - 1) });
  if (file.length > edgeBytes) await drainRange(file, { start: file.length - edgeBytes, end: lastByte });
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
    try { torrent.destroy({ destroyStore: true }, () => resolve()); } catch { resolve(); }
    setTimeout(resolve, 5_000).unref();
  });
}

async function measure(mode: "concurrent-tail" | "deferred-tail", index: number): Promise<RaceResult> {
  const pack = makeSeasonPack(`${mode}-${index}`);
  const swarm = await startLocalSwarm();
  let torrent: ProbeTorrent | null = null;
  try {
    const seeded = await swarm.seed(pack.dir);
    const client = await import("../../src/lib/clients/builtin-engine").then((m) => m.getBuiltinClientForProbe());
    torrent = addTorrentWithEngineDefaults(client, seeded.magnetURI, leechRoot) as unknown as ProbeTorrent;
    if (!torrent.ready) await new Promise<void>((resolve) => torrent?.on("ready", () => resolve()));
    const target = torrent.files.find((f) => f.path.replace(/\\/g, "/").endsWith(pack.requestedName));
    assert.ok(target, "target file missing");

    const started = performance.now();
    prioritizeBuiltinStreamFile(torrent, target, {
      prefetchEdges: mode === "concurrent-tail" ? concurrentEdges : deferredTailEdges,
      onPrefetchError: (err) => console.error(err),
    });
    const firstByte = await readFirstByte(target);
    const firstByteMs = performance.now() - started;

    const headStarted = performance.now();
    await drainRange(target, { start: 0, end: edgeBytes - 1 });
    const headDrainMs = performance.now() - headStarted;

    return {
      mode,
      run: index,
      firstByteMs: Math.round(firstByteMs),
      headDrainMs: Math.round(headDrainMs),
      firstByte,
      progress: torrent.progress,
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
  const results: RaceResult[] = [];
  try {
    for (let i = 1; i <= runCount; i += 1) {
      results.push(await measure("concurrent-tail", i));
      results.push(await measure("deferred-tail", i));
    }
    const byMode = (mode: string) => results.filter((r) => r.mode === mode);
    const span = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });
    console.log(JSON.stringify({
      results,
      summary: {
        concurrentTail: {
          firstByteMs: span(byMode("concurrent-tail").map((r) => r.firstByteMs)),
          headDrainMs: span(byMode("concurrent-tail").map((r) => r.headDrainMs)),
        },
        deferredTail: {
          firstByteMs: span(byMode("deferred-tail").map((r) => r.firstByteMs)),
          headDrainMs: span(byMode("deferred-tail").map((r) => r.headDrainMs)),
        },
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
