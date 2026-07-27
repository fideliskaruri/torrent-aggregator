/**
 * Measures next-episode peer prewarm: cold click vs already-added/deselected
 * torrent with peers connected but no pieces selected.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-next-prewarm.mts 3
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
  ready: boolean;
  progress: number;
  numPeers: number;
  files: BuiltinStreamFile[];
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
};

type Result = {
  mode: "cold" | "prewarmed";
  run: number;
  wireMs?: number;
  readyMs: number;
  prewarmProgress?: number;
  ttfbMs: number;
  peers: number;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-next-prewarm");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const episodeBytes = 64 * 1024 * 1024;
const runs = Number(process.argv[2] ?? 3);

function writeFixture(filePath: string, size: number) {
  const fd = fs.openSync(filePath, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 4);
    for (let written = 0; written < size;) {
      const n = Math.min(chunk.length, size - written);
      fs.writeSync(fd, chunk, 0, n, written);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function waitFor(torrent: ProbeTorrent, event: string, timeoutMs = 60_000): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    torrent.on(event, () => {
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
  });
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

async function destroyTorrent(torrent: ProbeTorrent) {
  await new Promise<void>((resolve) => {
    try { torrent.destroy({ destroyStore: true }, () => resolve()); } catch { resolve(); }
    setTimeout(resolve, 5_000).unref();
  });
}

async function measure(mode: "cold" | "prewarmed", run: number, magnet: string, fileName: string): Promise<Result> {
  await shutdownBuiltinEngine().catch(() => false);
  const client = await getBuiltinClientForProbe();
  let torrent: ProbeTorrent | null = null;
  try {
    const addStarted = performance.now();
    torrent = addTorrentWithEngineDefaults(
      client,
      magnet,
      ensureDir(path.join(leechRoot, `${mode}-${run}`)),
      undefined,
      mode === "prewarmed" ? { deselect: true } : {},
    ) as unknown as ProbeTorrent;
    let wireMs: number | undefined;
    torrent.on("wire", () => { wireMs ??= performance.now() - addStarted; });
    if (!torrent.ready) await waitFor(torrent, "ready");
    const readyMs = performance.now() - addStarted;
    if (mode === "prewarmed" && wireMs == null) {
      await waitFor(torrent, "wire", 10_000).catch(() => undefined);
    }
    const prewarmProgress = torrent.progress;
    const target = torrent.files.find((f) => (f.path || f.name).replace(/\\/g, "/").endsWith(fileName));
    assert.ok(target, "target file missing");

    const started = performance.now();
    prioritizeBuiltinStreamFile(torrent, target, { onPrefetchError: () => undefined });
    const byte = await readFirstByte(target);
    assert.equal(byte, 4);
    return {
      mode,
      run,
      wireMs: wireMs == null ? undefined : Math.round(wireMs),
      readyMs: Math.round(readyMs),
      ...(mode === "prewarmed" ? { prewarmProgress } : {}),
      ttfbMs: Math.round(performance.now() - started),
      peers: torrent.numPeers,
    };
  } finally {
    if (torrent) await destroyTorrent(torrent);
    await shutdownBuiltinEngine().catch(() => false);
  }
}

async function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  ensureDir(seedRoot);
  ensureDir(leechRoot);
  const fixture = path.join(seedRoot, "Next.S01E02.bin");
  writeFixture(fixture, episodeBytes);
  const swarm = await startLocalSwarm();
  try {
    const seeded = await swarm.seed(fixture);
    const results: Result[] = [];
    for (let i = 1; i <= runs; i += 1) {
      results.push(await measure("cold", i, seeded.magnetURI, seeded.filePath));
      results.push(await measure("prewarmed", i, seeded.magnetURI, seeded.filePath));
    }
    const span = (mode: Result["mode"], key: "ttfbMs" | "readyMs") => {
      const vals = results.filter((r) => r.mode === mode).map((r) => r[key]);
      return { min: Math.min(...vals), max: Math.max(...vals) };
    };
    console.log(JSON.stringify({
      results,
      summary: {
        cold: { readyMs: span("cold", "readyMs"), ttfbMs: span("cold", "ttfbMs") },
        prewarmed: { readyMs: span("prewarmed", "readyMs"), ttfbMs: span("prewarmed", "ttfbMs") },
      },
    }, null, 2));
  } finally {
    await shutdownBuiltinEngine().catch(() => false);
    await swarm.close().catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
