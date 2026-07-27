/**
 * Engine-owned regression probe for two playback assumptions:
 * 1. Rehydrating many torrents must not accumulate WebTorrent `listening` listeners.
 * 2. An incomplete multi-file torrent exposes all files and can stream a mid-pack file.
 *
 * Run:
 *   $env:NODE_OPTIONS='--trace-warnings'; node node_modules\tsx\dist\cli.mjs scripts\probes\engine-listener-and-incomplete.mts
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
  configureBuiltinClientListeningWaitForTests,
  findLiveBuiltinTorrent,
  prioritizeBuiltinStreamFile,
  shutdownBuiltinEngine,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "../../src/lib/clients/builtin-engine";
import type { ClientConnectionConfig } from "../../src/lib/clients";

type ProbeTorrent = BuiltinStreamTorrent & {
  length: number;
  ready: boolean;
  pieceLength?: number;
  bitfield?: { get(index: number): boolean };
};

type WarningWithDetails = Error & {
  emitter?: { constructor?: { name?: string } };
  type?: string;
  count?: number;
};

Error.stackTraceLimit = 50;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-listener-and-incomplete");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const userId = `probe-listener-${randomUUID()}`;
const consoleWarningRecords: string[] = [];
const warningRecords: Array<{
  name: string;
  message: string;
  emitter: string | null;
  type: string | null;
  count: number | null;
  stack: string | null;
}> = [];

process.on("warning", (warning: WarningWithDetails) => {
  warningRecords.push({
    name: warning.name,
    message: warning.message,
    emitter: warning.emitter?.constructor?.name ?? null,
    type: warning.type ?? null,
    count: warning.count ?? null,
    stack: warning.stack ?? null,
  });
});

const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  consoleWarningRecords.push(line);
  originalConsoleWarn(...args);
};

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

async function waitForLive(hash: string, timeoutMs: number): Promise<ProbeTorrent> {
  const started = performance.now();
  for (;;) {
    const torrent = findLiveBuiltinTorrent(hash) as ProbeTorrent | null;
    if (torrent) return torrent;
    if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${hash}`);
    await sleep(25);
  }
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

async function seedListenerLoadRows() {
  for (let i = 0; i < 12; i += 1) {
    const file = path.join(seedRoot, `listener-${String(i).padStart(2, "0")}.bin`);
    writeFixtureFile(file, 256 * 1024, i + 1);
    const seeded = await swarm.seed(file);
    await prisma.engineTorrent.create({
      data: {
        userId,
        hash: seeded.infoHash.toLowerCase(),
        name: `Listener probe ${i}`,
        magnet: seeded.magnetURI,
        savePath: leechRoot,
        category: "probe",
        status: "downloading",
        progress: 0,
        sizeBytes: BigInt(seeded.length),
      },
    });
  }
}

async function measureListenerWarnings() {
  warningRecords.length = 0;
  await shutdownBuiltinEngine();
  const started = performance.now();
  const rows = await builtinClient.listTorrents(config);
  const listMs = performance.now() - started;
  await sleep(500);
  return {
    listMs: Math.round(listMs),
    rows: rows.length,
    maxListenerWarnings: warningRecords.filter((w) => w.name === "MaxListenersExceededWarning"),
  };
}

function makeSeasonPack(label = "Incomplete"): { dir: string; requestedName: string } {
  const dir = ensureDir(path.join(seedRoot, `${label} Probe S01 Complete`));
  let requestedName = "";
  for (const ep of [1, 2, 3, 4]) {
    const name = `${label}.Probe.S01E${String(ep).padStart(2, "0")}.bin`;
    writeFixtureFile(path.join(dir, name), 32 * 1024 * 1024, ep);
    if (ep === 3) requestedName = name;
  }
  return { dir, requestedName };
}

async function measureIncompleteMidpackStream() {
  await shutdownBuiltinEngine();
  const pack = makeSeasonPack();
  const seeded = await swarm.seed(pack.dir);
  const add = await builtinClient.addTorrent(config, {
    magnet: seeded.magnetURI,
    savePath: leechRoot,
    name: "Incomplete Probe S01 Complete",
    category: "tv",
  });
  assert.equal(add.ok, true, add.message);
  const torrent = await waitForLive(seeded.infoHash.toLowerCase(), 60_000);
  const files = torrent.files ?? [];
  const target = files.find((f) => f.path.replace(/\\/g, "/").endsWith(pack.requestedName));
  assert.ok(target, `requested file not found: ${files.map((f) => f.path).join(", ")}`);
  const targetRange = pieceRange(target);
  const beforeProgress = torrent.progress;
  const beforeVerified = verifiedPieces(torrent, targetRange);
  const streamStarted = performance.now();
  prioritizeBuiltinStreamFile(torrent, target, {
    seekOffset: 0,
    onPrefetchError(err) {
      console.warn(`[probe] edge prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  const firstByte = await readFirstByte(target);
  const streamMs = performance.now() - streamStarted;
  return {
    infoHash: seeded.infoHash.toLowerCase(),
    ready: torrent.ready,
    progressBeforeStream: beforeProgress,
    progressAfterStream: torrent.progress,
    files: files.map((f) => ({ path: f.path, length: f.length })),
    requestedFile: target.path,
    requestedFileIndex: files.indexOf(target),
    targetPieces: targetRange,
    targetVerifiedBeforeStream: beforeVerified,
    targetVerifiedAfterStream: verifiedPieces(torrent, targetRange),
    streamFirstByteMs: Math.round(streamMs),
    firstByte,
  };
}

async function measureForcedListeningTimeoutStream() {
  consoleWarningRecords.length = 0;
  await shutdownBuiltinEngine();
  configureBuiltinClientListeningWaitForTests({ timeoutMs: 1, forceTimeout: true });
  try {
    const pack = makeSeasonPack("ForcedTimeout");
    const seeded = await swarm.seed(pack.dir);
    const add = await builtinClient.addTorrent(config, {
      magnet: seeded.magnetURI,
      savePath: leechRoot,
      name: "Forced Listener Timeout Probe S01 Complete",
      category: "tv",
    });
    assert.equal(add.ok, true, add.message);
    const torrent = await waitForLive(seeded.infoHash.toLowerCase(), 60_000);
    const target = (torrent.files ?? []).find((f) =>
      f.path.replace(/\\/g, "/").endsWith(pack.requestedName),
    );
    assert.ok(target, "forced-timeout stream target not found");
    const streamStarted = performance.now();
    prioritizeBuiltinStreamFile(torrent, target, {
      seekOffset: 0,
      onPrefetchError(err) {
        console.warn(`[probe] edge prefetch failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
    const firstByte = await readFirstByte(target);
    const listenerTimeoutWarnings = consoleWarningRecords.filter((line) =>
      line.includes("peer listener did not open") && line.includes("continuing anyway"),
    );
    assert.equal(listenerTimeoutWarnings.length, 1, "forced listener timeout warning must be emitted once");
    return {
      infoHash: seeded.infoHash.toLowerCase(),
      addOk: add.ok,
      warning: listenerTimeoutWarnings[0],
      files: (torrent.files ?? []).map((f) => ({ path: f.path, length: f.length })),
      requestedFile: target.path,
      progressAfterStream: torrent.progress,
      streamFirstByteMs: Math.round(performance.now() - streamStarted),
      firstByte,
    };
  } finally {
    configureBuiltinClientListeningWaitForTests(null);
  }
}

let swarm: Awaited<ReturnType<typeof startLocalSwarm>>;

async function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  ensureDir(seedRoot);
  ensureDir(leechRoot);
  swarm = await startLocalSwarm();
  try {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, name: "Listener Probe" },
    });
    await prisma.engineTorrent.deleteMany({ where: { userId } });
    await seedListenerLoadRows();
    const listenerLoad = await measureListenerWarnings();
    const incompleteStream = await measureIncompleteMidpackStream();
    const forcedListeningTimeout = await measureForcedListeningTimeoutStream();
    console.log(JSON.stringify({ listenerLoad, incompleteStream, forcedListeningTimeout }, null, 2));
  } finally {
    console.warn = originalConsoleWarn;
    await shutdownBuiltinEngine().catch(() => false);
    await swarm?.close().catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
