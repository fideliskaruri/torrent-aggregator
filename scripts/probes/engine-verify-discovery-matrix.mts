/**
 * Measure WebTorrent startup discovery when complete files already exist on disk.
 *
 * Matrix:
 *   - magnet vs .torrent metadata
 *   - full verify vs guarded startup bitfield
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\engine-verify-discovery-matrix.mts 3
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Server as TrackerServer } from "bittorrent-tracker";
import WebTorrent from "webtorrent";

import { ensureDir } from "../lib/local-swarm.mjs";

type MatrixMode = "magnet-verify" | "magnet-bitfield" | "torrent-verify" | "torrent-bitfield";

type WtTorrent = {
  infoHash: string;
  magnetURI: string;
  torrentFile?: Uint8Array;
  files: Array<{ path?: string; name: string; length: number }>;
  pieces?: unknown[];
  pieceLength?: number;
  ready?: boolean;
  numPeers?: number;
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
};

type WtClient = {
  add(input: string | Uint8Array, opts: object, cb?: (torrent: WtTorrent) => void): WtTorrent;
  seed(input: string, opts: object, cb?: (torrent: WtTorrent) => void): WtTorrent;
  destroy(cb?: (err?: Error) => void): void;
};

type Result = {
  mode: MatrixMode;
  run: number;
  wireMs: number | null;
  readyMs: number | null;
  peersAtReady: number;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(repoRoot, "scripts", "probes", ".engine-verify-discovery-matrix");
const seedRoot = ensureDir(path.join(workRoot, "seed"));
const leechRoot = ensureDir(path.join(workRoot, "leech"));
const runCount = Number(process.argv[2] ?? 3);
const fixtureBytes = Number(process.argv[3] ?? 128 * 1024 * 1024);

function makeClient(): WtClient {
  return new WebTorrent({ dht: false, utp: false }) as unknown as WtClient;
}

function writeFixture(filePath: string, size: number) {
  const fd = fs.openSync(filePath, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    for (let written = 0; written < size;) {
      const n = Math.min(chunk.length, size - written);
      fs.writeSync(fd, chunk, 0, n, written);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function startTracker(): Promise<{ trackerUrl: string; close: () => Promise<void> }> {
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false, http: true });
  tracker.on("error", () => undefined);
  tracker.on("warning", () => undefined);
  const trackerUrl = await new Promise<string>((resolve, reject) => {
    tracker.listen(0, "127.0.0.1", () => {
      const addr = tracker.http?.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("tracker did not report a port"));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}/announce`);
    });
  });
  return {
    trackerUrl,
    close: () => new Promise((resolve) => {
      try { tracker.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 2_000).unref();
    }),
  };
}

async function seedFixture(filePath: string, trackerUrl: string) {
  const client = makeClient();
  const torrent = await new Promise<WtTorrent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out seeding")), 60_000);
    client.seed(filePath, { announce: [trackerUrl] }, (t) => {
      clearTimeout(timer);
      resolve(t);
    });
  });
  const torrentFile = torrent.torrentFile;
  if (!torrentFile) throw new Error("seeder did not expose torrentFile");
  const fileName = torrent.files[0]?.path || torrent.files[0]?.name;
  if (!fileName) throw new Error("seeder exposed no file");
  const pieceCount = torrent.pieces?.length;
  if (!pieceCount) throw new Error("seeder exposed no piece count");
  return { client, torrent, torrentFile, fileName: fileName.replace(/\\/g, "/"), pieceCount };
}

function completeBitfield(pieceCount: number): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(pieceCount / 8));
  for (let i = 0; i < pieceCount; i += 1) {
    bytes[i >> 3] |= 0b1000_0000 >> (i % 8);
  }
  return bytes;
}

async function destroyClient(client: WtClient) {
  await new Promise<void>((resolve) => {
    try { client.destroy(() => resolve()); } catch { resolve(); }
    setTimeout(resolve, 5_000).unref();
  });
}

async function measure(
  mode: MatrixMode,
  run: number,
  input: string | Uint8Array,
  fileName: string,
  trackerUrl: string,
  bitfield: Uint8Array | null,
  seedFile: string,
): Promise<Result> {
  const dir = ensureDir(path.join(leechRoot, `${mode}-${run}`));
  fs.copyFileSync(seedFile, path.join(dir, fileName));
  const client = makeClient();
  const started = performance.now();
  let wireMs: number | null = null;
  let readyMs: number | null = null;
  try {
    const torrent = client.add(input, {
      announce: [trackerUrl],
      path: dir,
      strategy: "sequential",
      storeCacheSlots: 200,
      ...(bitfield ? { bitfield } : {}),
    });
    torrent.on("wire", () => {
      wireMs ??= performance.now() - started;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${mode} timed out`)), 120_000);
      torrent.on("ready", () => {
        clearTimeout(timer);
        readyMs = performance.now() - started;
        resolve();
      });
      torrent.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    if (wireMs == null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 3_000);
        torrent.on("wire", () => {
          clearTimeout(timer);
          wireMs ??= performance.now() - started;
          resolve();
        });
      });
    }
    return {
      mode,
      run,
      wireMs: wireMs == null ? null : Math.round(wireMs),
      readyMs: readyMs == null ? null : Math.round(readyMs),
      peersAtReady: torrent.numPeers ?? 0,
    };
  } finally {
    await destroyClient(client);
  }
}

async function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  ensureDir(seedRoot);
  ensureDir(leechRoot);
  const tracker = await startTracker();
  const seedFile = path.join(seedRoot, "verify-matrix.bin");
  writeFixture(seedFile, fixtureBytes);
  const seeded = await seedFixture(seedFile, tracker.trackerUrl);
  const bitfield = completeBitfield(seeded.pieceCount);
  const results: Result[] = [];
  try {
    for (let i = 1; i <= runCount; i += 1) {
      results.push(await measure("magnet-verify", i, seeded.torrent.magnetURI, seeded.fileName, tracker.trackerUrl, null, seedFile));
      results.push(await measure("magnet-bitfield", i, seeded.torrent.magnetURI, seeded.fileName, tracker.trackerUrl, bitfield, seedFile));
      results.push(await measure("torrent-verify", i, seeded.torrentFile, seeded.fileName, tracker.trackerUrl, null, seedFile));
      results.push(await measure("torrent-bitfield", i, seeded.torrentFile, seeded.fileName, tracker.trackerUrl, bitfield, seedFile));
    }
    const modes: MatrixMode[] = ["magnet-verify", "magnet-bitfield", "torrent-verify", "torrent-bitfield"];
    const span = (values: Array<number | null>) => {
      const nums = values.filter((v): v is number => typeof v === "number");
      return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null;
    };
    console.log(JSON.stringify({
      fixtureMiB: Math.round(fixtureBytes / 1024 / 1024),
      results,
      summary: Object.fromEntries(modes.map((mode) => {
        const rows = results.filter((r) => r.mode === mode);
        return [mode, { wireMs: span(rows.map((r) => r.wireMs)), readyMs: span(rows.map((r) => r.readyMs)) }];
      })),
    }, null, 2));
  } finally {
    await destroyClient(seeded.client);
    await tracker.close();
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
