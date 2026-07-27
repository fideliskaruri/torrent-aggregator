import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import type { ClientConnectionConfig } from "../../src/lib/clients";
import type {
  BuiltinStreamFile,
  BuiltinStreamLookup,
  BuiltinStreamTorrent,
} from "../../src/lib/clients/builtin-engine";
import {
  isTorrentRangeVerifiedOnDisk,
  openVerifiedDiskStream,
} from "../../src/lib/clients/disk-fastpath";
import { handleStreamFileRequest } from "../../src/app/api/stream/[infoHash]/[...filePath]/route";

const HASH = "1111111111111111111111111111111111111111";
const REL = "Pack/S01E03.mkv";
const ROOT = path.join(process.cwd(), "scripts", "probes", ".range-disk-fastpath-work");
const FILE = path.join(ROOT, ...REL.split("/"));

const CONFIG: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  userId: "probe",
};

class ProbeTorrent extends EventEmitter {
  infoHash = HASH;
  name = "Probe pack";
  progress = 0;
  downloadSpeed = 0;
  numPeers = 0;
  done = false;
  ready = false;
  path = ROOT;
  length = 0;
  pieceLength = 1024;
  lastPieceLength = 1024;
  pieces: unknown[] = [];
  _hashes: string[] = [];
  files: BuiltinStreamFile[] = [];
  bitfield: { get: (index: number) => boolean } = { get: () => false };
}

function byteAt(offset: number): number {
  return (offset * 17) % 251;
}

function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = byteAt(i);
  return bytes;
}

function hashes(bytes: Uint8Array, pieceLength: number): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += pieceLength) {
    out.push(
      createHash("sha1")
        .update(bytes.subarray(offset, Math.min(bytes.length, offset + pieceLength)))
        .digest("hex"),
    );
  }
  return out;
}

function stalledFile(length: number): BuiltinStreamFile & { offset: number } {
  return {
    name: "S01E03.mkv",
    path: REL,
    length,
    offset: 0,
    stream() {
      return new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
      });
    },
  };
}

async function buildTorrent(): Promise<{ torrent: ProbeTorrent; file: BuiltinStreamFile }> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const bytes = makeBytes(4096);
  await fs.writeFile(FILE, bytes);

  const torrent = new ProbeTorrent();
  torrent.length = bytes.length;
  torrent.pieces = Array.from({ length: bytes.length / torrent.pieceLength });
  torrent._hashes = hashes(bytes, torrent.pieceLength);
  const file = stalledFile(bytes.length);
  torrent.files = [file];
  return { torrent, file };
}

function deps(torrent: ProbeTorrent, file: BuiltinStreamFile, mode: "old" | "fixed", stallTimeoutMs: number) {
  const lookup: BuiltinStreamLookup = {
    status: "found",
    torrent: torrent as unknown as BuiltinStreamTorrent,
    file,
  };
  return {
    getConfig: async () => CONFIG,
    findFile: async () => lookup,
    prefetchEdges: async () => undefined,
    stallTimeoutMs,
    async openDiskStream(
      t: BuiltinStreamTorrent,
      f: BuiltinStreamFile,
      range: { start: number; end: number },
    ) {
      if (mode === "old" && !isTorrentRangeVerifiedOnDisk(t, f, range)) return null;
      return openVerifiedDiskStream(t, f, range);
    },
  };
}

async function requestOnce(mode: "old" | "fixed", stallTimeoutMs: number) {
  const { torrent, file } = await buildTorrent();
  const oldVerified = isTorrentRangeVerifiedOnDisk(
    torrent as unknown as BuiltinStreamTorrent,
    file,
    { start: 0, end: 0 },
  );
  const started = performance.now();
  const res = await handleStreamFileRequest(
    new Request(`http://localhost/api/stream/${HASH}/Pack/S01E03.mkv`, {
      headers: { range: "bytes=0-0" },
    }),
    { infoHash: HASH, filePath: ["Pack", "S01E03.mkv"] },
    deps(torrent, file, mode, stallTimeoutMs),
  );
  const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return {
    mode,
    status: res.status,
    bodyBytes: body.byteLength,
    ms: Math.round(performance.now() - started),
    oldVerified,
    ready: torrent.ready,
    bitfield0: torrent.bitfield.get(0),
    hashes: torrent._hashes.length,
  };
}

async function ladder(attempts: number, stallTimeoutMs: number) {
  const started = performance.now();
  const rows = [];
  for (let i = 0; i < attempts; i += 1) {
    rows.push(await requestOnce("old", stallTimeoutMs));
  }
  return { rows, ms: Math.round(performance.now() - started) };
}

async function main() {
  const oldInfo = console.info;
  const oldWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    const oldDefault = await requestOnce("old", 15_000);
    const scaledLadder = await ladder(4, 500);
    const fixed = await requestOnce("fixed", 15_000);

    assert.equal(oldDefault.oldVerified, false);
    assert.equal(oldDefault.status, 503);
    assert.equal(fixed.status, 206);
    assert.equal(fixed.bodyBytes, 1);

    console.info = oldInfo;
    console.warn = oldWarn;
    console.log("── Range disk fast-path probe ──");
    console.log(
      `old precondition: ready=${oldDefault.ready}, bitfield[0]=${oldDefault.bitfield0}, hashes=${oldDefault.hashes}, isTorrentRangeVerifiedOnDisk=${oldDefault.oldVerified}`,
    );
    console.log(
      `old single request: HTTP ${oldDefault.status}, ${oldDefault.bodyBytes} bytes, ${oldDefault.ms}ms`,
    );
    console.log(
      `old retry ladder (scaled): ${scaledLadder.rows.length} × 500ms stall = ${scaledLadder.ms}ms`,
    );
    console.log(`fixed request: HTTP ${fixed.status}, ${fixed.bodyBytes} byte, ${fixed.ms}ms`);
  } finally {
    console.info = oldInfo;
    console.warn = oldWarn;
    await fs.rm(ROOT, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
