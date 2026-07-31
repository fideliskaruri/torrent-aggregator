import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { makeScratchDir } from "@/lib/test-support/scratch-dir";
import type { ClientConnectionConfig } from "@/lib/clients";
import type {
  BuiltinStreamFile,
  BuiltinStreamLookup,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import {
  diskFastPathVerificationCacheStatsForTests,
  openVerifiedDiskStream,
  resetDiskFastPathVerificationCacheForTests,
} from "@/lib/clients/disk-fastpath";
import {
  OPEN_ENDED_RANGE_CAP_BYTES,
  handleStreamFileRequest,
  resetStreamPrefetchForTests,
} from "./route";
import { handleStreamIndexRequest } from "../route";

const HASH = "abcdef1234567890abcdef1234567890abcdef12";

const builtinConfig: ClientConnectionConfig = {
  clientType: "builtin",
  host: "",
  userId: "local",
};

class FakeTorrent extends EventEmitter {
  infoHash = HASH;
  name = "Fake torrent";
  progress = 0.25;
  downloadSpeed = 0;
  numPeers = 0;
  downloaded = 0;
  length?: number;
  files: BuiltinStreamFile[] = [];
  path?: string;
  pieceLength?: number;
  pieces?: unknown[];
  ready?: boolean;
  bitfield?: { get: (index: number) => boolean };
}

function byteAt(offset: number): number {
  return offset % 251;
}

function makeFile(path: string, length: number): BuiltinStreamFile {
  return {
    name: path.split("/").pop() || path,
    path,
    length,
    stream(opts = {}) {
      const start = opts.start ?? 0;
      const end = Math.min(opts.end ?? length - 1, length - 1);
      let offset = start;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          const size = Math.min(64 * 1024, end - offset + 1);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) chunk[i] = byteAt(offset + i);
          offset += size;
          controller.enqueue(chunk);
        },
      });
    },
  };
}

/**
 * Mimics the real webtorrent File.stream: it resolves the end bound with
 * `opts?.end && ...`, so an end of 0 is falsy and silently widens to the whole
 * file. The well-behaved `makeFile` fake above cannot catch bugs that depend on
 * this, which is exactly how the `bytes=0-0` over-delivery shipped.
 */
function makeLooseEndFile(
  path: string,
  length: number,
  onSelect?: (start: number, end: number) => void,
): BuiltinStreamFile {
  return {
    name: path.split("/").pop() || path,
    path,
    length,
    stream(opts = {}) {
      const start = opts.start ?? 0;
      const end = opts.end && opts.end < length ? opts.end : length - 1;
      onSelect?.(start, end);
      let offset = start;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          const size = Math.min(64 * 1024, end - offset + 1);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) chunk[i] = byteAt(offset + i);
          offset += size;
          controller.enqueue(chunk);
        },
      });
    },
  };
}

function makeStalledFile(
  path: string,
  length: number,
  torrent: FakeTorrent,
): BuiltinStreamFile {
  return {
    name: path.split("/").pop() || path,
    path,
    length,
    stream() {
      let destroyed = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            const listener = () => {
              if (!destroyed) return;
              torrent.removeListener("verified", listener);
              controller.close();
              resolve();
            };
            torrent.on("verified", listener);
          });
        },
        cancel() {
          destroyed = true;
        },
      });
    },
  };
}

async function makeDiskBackedTorrent(opts: {
  filePath?: string;
  length: number;
  pieceLength: number;
  fileOffset?: number;
  verifiedPieces: number[];
}): Promise<{
  root: string;
  torrent: FakeTorrent;
  file: BuiltinStreamFile;
  cleanup: () => Promise<void>;
}> {
  const root = makeScratchDir("disk-fastpath");
  const rel = opts.filePath ?? "Folder/Movie.mkv";
  const fullPath = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const bytes = new Uint8Array(opts.length);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = byteAt(i);
  await fs.writeFile(fullPath, bytes);

  const torrent = new FakeTorrent();
  const totalLength = (opts.fileOffset ?? 0) + opts.length;
  const pieceCount = Math.ceil(totalLength / opts.pieceLength);
  const verified = new Set(opts.verifiedPieces);
  torrent.path = root;
  torrent.pieceLength = opts.pieceLength;
  torrent.pieces = Array.from({ length: pieceCount }, () => ({}));
  torrent.ready = true;
  torrent.bitfield = { get: (index) => verified.has(index) };

  const file = makeFile(rel, opts.length) as BuiltinStreamFile & { offset?: number };
  file.offset = opts.fileOffset ?? 0;
  return {
    root,
    torrent,
    file,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function pieceHashes(bytes: Uint8Array, pieceLength: number): string[] {
  const hashes: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += pieceLength) {
    hashes.push(
      createHash("sha1")
        .update(bytes.subarray(offset, Math.min(bytes.length, offset + pieceLength)))
        .digest("hex"),
    );
  }
  return hashes;
}

function depsFor(
  torrent: FakeTorrent,
  file: BuiltinStreamFile,
  config: ClientConnectionConfig = builtinConfig,
) {
  torrent.files = [file];
  const lookup: BuiltinStreamLookup = {
    status: "found",
    torrent: torrent as unknown as BuiltinStreamTorrent,
    file,
  };
  return {
    getConfig: async () => config,
    findFile: async () => lookup,
    prefetchEdges: async () => undefined,
  };
}

async function requestFile(
  headers: Record<string, string>,
  file = makeFile("Folder/Movie.mkv", 2048),
  config = builtinConfig,
): Promise<Response> {
  resetStreamPrefetchForTests();
  const torrent = new FakeTorrent();
  return handleStreamFileRequest(
    new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
      headers,
    }),
    { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
    depsFor(torrent, file, config),
  );
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

function responseHeaderEntries(res: Response): Record<string, string> {
  return Object.fromEntries(Array.from(res.headers.entries()).sort());
}

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let failures = 0;

async function main() {
  const oldInfo = console.info;
  const oldWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    await check("bytes=100-199 returns 206 with exactly 100 bytes", async () => {
      const res = await requestFile({ range: "bytes=100-199" });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), "bytes 100-199/2048");
      assert.equal(res.headers.get("content-length"), "100");
      assert.equal(res.headers.get("content-type"), "video/x-matroska");
      const body = await bodyBytes(res);
      assert.equal(body.length, 100);
      assert.equal(body[0], byteAt(100));
      assert.equal(body[99], byteAt(199));
    });

    await check("bytes=0- is capped to a sane 8 MiB 206", async () => {
      const length = OPEN_ENDED_RANGE_CAP_BYTES + 1024;
      const res = await requestFile(
        { range: "bytes=0-" },
        makeFile("Folder/Movie.mp4", length),
      );
      assert.equal(res.status, 206);
      assert.equal(
        res.headers.get("content-range"),
        `bytes 0-${OPEN_ENDED_RANGE_CAP_BYTES - 1}/${length}`,
      );
      assert.equal(
        Number(res.headers.get("content-length")),
        OPEN_ENDED_RANGE_CAP_BYTES,
      );
      assert.equal((await bodyBytes(res)).length, OPEN_ENDED_RANGE_CAP_BYTES);
    });

    await check("suffix bytes=-500 returns the last 500 bytes", async () => {
      const res = await requestFile({ range: "bytes=-500" });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), "bytes 1548-2047/2048");
      const body = await bodyBytes(res);
      assert.equal(body.length, 500);
      assert.equal(body[0], byteAt(1548));
      assert.equal(body[499], byteAt(2047));
    });

    await check("garbage and unsatisfiable ranges return 416 with size", async () => {
      for (const range of ["garbage", "bytes=999999-1000000"]) {
        const res = await requestFile({ range });
        assert.equal(res.status, 416, range);
        assert.equal(res.headers.get("content-range"), "bytes */2048");
        assert.equal(await res.text(), "");
      }
    });

    await check("HEAD returns headers only and no body", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const file = makeFile("Folder/Movie.mkv", 2048);
      const res = await handleStreamFileRequest(
        new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
          method: "HEAD",
          headers: { range: "bytes=100-199" },
        }),
        { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
        depsFor(torrent, file),
      );
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), "bytes 100-199/2048");
      assert.equal(res.body, null);
      assert.equal(await res.text(), "");
    });

    await check("stalling first piece returns 503 within the timeout", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const file = makeStalledFile("Folder/Movie.mkv", 2048, torrent);
      const started = Date.now();
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=100-199" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          { ...depsFor(torrent, file), stallTimeoutMs: 50 },
        ),
        500,
      );
      assert.equal(res.status, 503);
      assert.ok(Date.now() - started < 450, "request hung instead of timing out");
      assert.equal(torrent.listenerCount("verified"), 0);
    });

    // I45/I37 acceptance: a stream slower than the stall window must keep being
    // served — the guard is byte-progress, not a wall clock — so long as bytes
    // are still arriving. A fixed timeout would have 503'd this working stream.
    await check("a slow-but-progressing first piece is served, not 503'd", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      torrent.numPeers = 6;
      torrent.length = 10_000_000;
      torrent.downloaded = 0;
      // Bytes keep arriving faster than the (tiny) window can elapse without any.
      const advance = setInterval(() => {
        torrent.downloaded += 1_000_000;
      }, 15);
      // The head read only resolves well after the 60ms stall window, mimicking
      // a swarm that is progressing overall but slow on the exact head piece.
      const file: BuiltinStreamFile = {
        name: "Movie.mkv",
        path: "Folder/Movie.mkv",
        length: 2048,
        stream(opts = {}) {
          const start = opts.start ?? 0;
          return new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                const chunk = new Uint8Array(100);
                for (let i = 0; i < 100; i += 1) chunk[i] = byteAt(start + i);
                controller.enqueue(chunk);
                controller.close();
              }, 300);
            },
          });
        },
      };
      try {
        const res = await withTimeout(
          handleStreamFileRequest(
            new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
              headers: { range: "bytes=100-199" },
            }),
            { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
            { ...depsFor(torrent, file), stallTimeoutMs: 60 },
          ),
          2_000,
        );
        assert.equal(res.status, 206, "a progressing stream must keep serving");
        const body = await bodyBytes(res);
        assert.equal(body.length, 100);
      } finally {
        clearInterval(advance);
      }
    });

    // I19: a genuinely byte-stalled stream errors with a machine code, not dead
    // air. No peers → NO_PEERS (retryable delivery failure); peers but frozen
    // bytes → STALLED.
    await check("a byte-stalled stream returns a structured failure code", async () => {
      const cases: Array<{ peers: number; downloaded: number; code: string }> = [
        { peers: 0, downloaded: 0, code: "NO_PEERS" },
        { peers: 5, downloaded: 1_000_000, code: "STALLED" },
      ];
      for (const c of cases) {
        resetStreamPrefetchForTests();
        const torrent = new FakeTorrent();
        torrent.numPeers = c.peers;
        torrent.length = 10_000_000;
        torrent.downloaded = c.downloaded; // static: never advances
        const file = makeStalledFile("Folder/Movie.mkv", 2048, torrent);
        const res = await withTimeout(
          handleStreamFileRequest(
            new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
              headers: { range: "bytes=100-199" },
            }),
            { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
            { ...depsFor(torrent, file), stallTimeoutMs: 60 },
          ),
          800,
        );
        assert.equal(res.status, 503, c.code);
        const body = (await res.json()) as { code?: string; retryable?: boolean };
        assert.equal(body.code, c.code, `expected ${c.code}`);
        assert.equal(body.retryable, true, `${c.code} is retryable`);
        assert.equal(torrent.listenerCount("verified"), 0);
      }
    });


    await check("aborting during a stalled read releases verified listener", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const file = makeStalledFile("Folder/Movie.mkv", 2048, torrent);
      const ac = new AbortController();
      const pending = handleStreamFileRequest(
        new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
          headers: { range: "bytes=100-199" },
          signal: ac.signal,
        }),
        { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
        { ...depsFor(torrent, file), stallTimeoutMs: 1000 },
      );
      await waitFor(() => torrent.listenerCount("verified") === 1);
      ac.abort();
      const res = await withTimeout(pending, 500);
      assert.equal(res.status, 503);
      assert.equal(torrent.listenerCount("verified"), 0);
    });

    await check("slow async cancel still releases the verified listener", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      // Unlike makeStalledFile, this cancel only marks the iterator destroyed
      // after several microtask hops -- which is what WebTorrent's real
      // reader.cancel() -> iterator.return() -> destroy() chain does. Any wake
      // that fires on a fixed microtask turn instead of waiting for cancel to
      // settle leaks the listener here.
      const file: BuiltinStreamFile = {
        name: "Movie.mkv",
        path: "Folder/Movie.mkv",
        length: 2048,
        stream() {
          let destroyed = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              return new Promise<void>((resolve) => {
                const listener = () => {
                  if (!destroyed) return;
                  torrent.removeListener("verified", listener);
                  controller.close();
                  resolve();
                };
                torrent.on("verified", listener);
              });
            },
            async cancel() {
              for (let i = 0; i < 8; i += 1) await Promise.resolve();
              destroyed = true;
            },
          });
        },
      };
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=100-199" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          { ...depsFor(torrent, file), stallTimeoutMs: 50 },
        ),
        500,
      );
      assert.equal(res.status, 503);
      assert.equal(torrent.listenerCount("verified"), 0);
    });

    await check("bytes=0-0 sends exactly one byte and selects only the head", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const selections: Array<[number, number]> = [];
      const file = makeLooseEndFile("Folder/Movie.mkv", 40 * 1024 * 1024, (s, e) =>
        selections.push([s, e]),
      );
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-0" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(torrent, file),
        ),
        2000,
      );
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-length"), "1");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(body.length, 1, "body must match the declared Content-Length");
      assert.ok(
        selections.length > 0 && selections[0][1] < 1024,
        `must not select the whole file for a 1-byte probe, got ${JSON.stringify(selections)}`,
      );
    });

    await check("an over-delivering source is clamped to the requested range", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const file = makeLooseEndFile("Folder/Movie.mkv", 5 * 1024 * 1024);
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-99" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(torrent, file),
        ),
        2000,
      );
      assert.equal(res.headers.get("content-length"), "100");
      assert.equal(new Uint8Array(await res.arrayBuffer()).length, 100);
    });

    await check("range playback tells the engine which file and offset are foreground", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const file = makeFile("Folder/Movie.mkv", 2048);
      const calls: Array<{ filePath: string; seekOffset: number | undefined }> = [];
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=512-1023" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            ...depsFor(torrent, file),
            prioritizeFile(_torrent, foregroundFile, opts) {
              calls.push({
                filePath: foregroundFile.path,
                seekOffset: opts?.seekOffset,
              });
            },
          },
        ),
        2000,
      );
      assert.equal(res.status, 206);
      assert.deepEqual(calls, [{ filePath: "Folder/Movie.mkv", seekOffset: 512 }]);
    });

    await check("a verified range is served from disk without WebTorrent priority", async () => {
      resetStreamPrefetchForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [0, 1],
      });
      try {
        disk.file.stream = () => {
          throw new Error("disk fast path should not touch WebTorrent stream");
        };
        let priorities = 0;
        const closes: string[] = [];
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-0" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            ...depsFor(disk.torrent, disk.file),
            prioritizeFile() {
              priorities += 1;
            },
            openDiskStream(torrent, file, range) {
              return openVerifiedDiskStream(torrent, file, range, {
                onClose(reason) {
                  closes.push(reason);
                },
              });
            },
          },
        );
        assert.equal(res.status, 206);
        assert.equal(res.headers.get("content-range"), "bytes 0-0/2048");
        assert.equal(res.headers.get("content-length"), "1");
        assert.equal((await bodyBytes(res)).length, 1);
        await waitFor(() => closes.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(closes.length, 1, `handle closed more than once: ${closes}`);
        assert.equal(priorities, 0, "complete disk bytes need no swarm priority");
      } finally {
        await disk.cleanup();
      }
    });

    await check("an on-disk range can be hash-verified before WebTorrent ready", async () => {
      resetStreamPrefetchForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [],
      });
      try {
        const bytes = new Uint8Array(2048);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = byteAt(i);
        Object.assign(disk.torrent, {
          ready: false,
          length: 2048,
          lastPieceLength: 1024,
          _hashes: pieceHashes(bytes, 1024),
          bitfield: { get: () => false },
        });
        disk.file.stream = () => {
          throw new Error("disk hash fast path should not touch WebTorrent stream");
        };
        let priorities = 0;
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=100-199" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            ...depsFor(disk.torrent, disk.file),
            prioritizeFile() {
              priorities += 1;
            },
          },
        );
        assert.equal(res.status, 206);
        assert.equal((await bodyBytes(res)).length, 100);
        assert.equal(priorities, 0, "disk-verified bytes need no swarm priority");
      } finally {
        await disk.cleanup();
      }
    });

    await check("disk hash verification covers pieces that span pack files", async () => {
      resetStreamPrefetchForTests();
      const root = makeScratchDir("disk-fastpath-pack");
      try {
        const prevRel = "Folder/Previous.mkv";
        const curRel = "Folder/Movie.mkv";
        const prevPath = path.join(root, ...prevRel.split("/"));
        const curPath = path.join(root, ...curRel.split("/"));
        await fs.mkdir(path.dirname(curPath), { recursive: true });
        const all = new Uint8Array(2048);
        for (let i = 0; i < all.length; i += 1) all[i] = byteAt(i);
        await fs.writeFile(prevPath, all.subarray(0, 512));
        await fs.writeFile(curPath, all.subarray(512));

        const torrent = new FakeTorrent();
        const prev = makeFile(prevRel, 512) as BuiltinStreamFile & { offset?: number };
        const file = makeFile(curRel, 1536) as BuiltinStreamFile & { offset?: number };
        prev.offset = 0;
        file.offset = 512;
        torrent.files = [file, prev];
        Object.assign(torrent, {
          path: root,
          ready: false,
          length: 2048,
          pieceLength: 1024,
          lastPieceLength: 1024,
          pieces: Array.from({ length: 2 }),
          _hashes: pieceHashes(all, 1024),
          bitfield: { get: () => false },
        });
        file.stream = () => {
          throw new Error("cross-file disk hash fast path should not touch WebTorrent stream");
        };
        const lookup: BuiltinStreamLookup = {
          status: "found",
          torrent: torrent as unknown as BuiltinStreamTorrent,
          file,
        };
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-99" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            getConfig: async () => builtinConfig,
            findFile: async () => lookup,
            prefetchEdges: async () => undefined,
          },
        );
        assert.equal(res.status, 206);
        const body = await bodyBytes(res);
        assert.equal(body.length, 100);
        assert.equal(body[0], byteAt(512));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    await check("disk hash verification memoises positive pieces only", async () => {
      resetStreamPrefetchForTests();
      resetDiskFastPathVerificationCacheForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [],
      });
      try {
        const bytes = new Uint8Array(2048);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = byteAt(i);
        Object.assign(disk.torrent, {
          ready: false,
          length: 2048,
          lastPieceLength: 1024,
          _hashes: pieceHashes(bytes, 1024),
          bitfield: { get: () => false },
        });
        disk.file.stream = () => {
          throw new Error("verified disk cache should not touch WebTorrent stream");
        };
        for (const range of ["bytes=0-99", "bytes=100-199"]) {
          const res = await handleStreamFileRequest(
            new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
              headers: { range },
            }),
            { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
            depsFor(disk.torrent, disk.file),
          );
          assert.equal(res.status, 206);
          assert.equal((await bodyBytes(res)).length, 100);
        }
        const stats = diskFastPathVerificationCacheStatsForTests();
        assert.equal(stats.stores, 1);
        assert.equal(stats.hits, 1);
      } finally {
        await disk.cleanup();
      }
    });

    await check("disk hash cache invalidates when a file changes", async () => {
      resetStreamPrefetchForTests();
      resetDiskFastPathVerificationCacheForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [],
      });
      try {
        const bytes = new Uint8Array(2048);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = byteAt(i);
        Object.assign(disk.torrent, {
          ready: false,
          length: 2048,
          lastPieceLength: 1024,
          _hashes: pieceHashes(bytes, 1024),
          bitfield: { get: () => false },
        });
        const first = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-99" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(disk.torrent, disk.file),
        );
        assert.equal(first.status, 206);
        assert.equal((await bodyBytes(first)).length, 100);

        const changed = new Uint8Array(bytes);
        changed[0] ^= 0xff;
        const diskPath = path.join(disk.root, "Folder", "Movie.mkv");
        await fs.writeFile(diskPath, changed);
        const future = new Date(Date.now() + 10_000);
        await fs.utimes(diskPath, future, future);

        let streams = 0;
        const original = disk.file.stream;
        disk.file.stream = (opts) => {
          streams += 1;
          return original.call(disk.file, opts);
        };
        const second = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-99" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(disk.torrent, disk.file),
        );
        assert.equal(second.status, 206);
        assert.equal((await bodyBytes(second)).length, 100);
        assert.equal(streams, 1, "changed disk bytes must be rechecked, not served from cache");
        assert.equal(diskFastPathVerificationCacheStatsForTests().invalidations, 1);
      } finally {
        await disk.cleanup();
      }
    });

    await check("unknown piece hashes still fall back instead of trusting disk size", async () => {
      resetStreamPrefetchForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [],
      });
      try {
        Object.assign(disk.torrent, {
          ready: false,
          length: 2048,
          lastPieceLength: 1024,
          bitfield: { get: () => false },
        });
        let streams = 0;
        const original = disk.file.stream;
        disk.file.stream = (opts) => {
          streams += 1;
          return original.call(disk.file, opts);
        };
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=100-199" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(disk.torrent, disk.file),
        );
        assert.equal(res.status, 206);
        assert.equal((await bodyBytes(res)).length, 100);
        assert.equal(streams, 1);
      } finally {
        await disk.cleanup();
      }
    });

    await check("disk and swarm paths return byte-identical range headers", async () => {
      resetStreamPrefetchForTests();
      const swarm = await requestFile(
        { range: "bytes=100-199" },
        makeFile("Folder/Movie.mkv", 2048),
      );
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [0, 1],
      });
      try {
        disk.file.stream = () => {
          throw new Error("disk fast path should not touch WebTorrent stream");
        };
        const fast = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=100-199" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          depsFor(disk.torrent, disk.file),
        );
        assert.equal(fast.status, swarm.status);
        assert.deepEqual(responseHeaderEntries(fast), responseHeaderEntries(swarm));
        const body = await bodyBytes(fast);
        assert.equal(body.length, 100);
        assert.equal(body[0], byteAt(100));
        assert.equal(body[99], byteAt(199));
      } finally {
        await disk.cleanup();
      }
    });

    await check("cancelling a fast-path response closes the disk handle once", async () => {
      resetStreamPrefetchForTests();
      const disk = await makeDiskBackedTorrent({
        length: 512 * 1024,
        pieceLength: 64 * 1024,
        verifiedPieces: Array.from({ length: 8 }, (_, i) => i),
      });
      try {
        const closes: string[] = [];
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-524287" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            ...depsFor(disk.torrent, disk.file),
            openDiskStream(torrent, file, range) {
              return openVerifiedDiskStream(torrent, file, range, {
                onClose(reason) {
                  closes.push(reason);
                },
              });
            },
          },
        );
        const reader = res.body?.getReader();
        assert.ok(reader, "fast path response should have a body");
        const first = await reader.read();
        assert.equal(first.done, false);
        await reader.cancel("viewer seek");
        await waitFor(() => closes.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(closes.length, 1, `handle closed more than once: ${closes}`);
      } finally {
        await disk.cleanup();
      }
    });

    await check("a range crossing an unverified piece falls back to WebTorrent", async () => {
      resetStreamPrefetchForTests();
      const disk = await makeDiskBackedTorrent({
        length: 2048,
        pieceLength: 1024,
        verifiedPieces: [0],
      });
      try {
        let streams = 0;
        const original = disk.file.stream;
        disk.file.stream = (opts) => {
          streams += 1;
          return original.call(disk.file, opts);
        };
        let priorities = 0;
        const res = await handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=900-1100" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          {
            ...depsFor(disk.torrent, disk.file),
            prioritizeFile() {
              priorities += 1;
            },
          },
        );
        assert.equal(res.status, 206);
        assert.equal((await bodyBytes(res)).length, 201);
        assert.equal(streams, 1);
        assert.equal(priorities, 1);
      } finally {
        await disk.cleanup();
      }
    });

    await check("a mid-stream stall ends the response instead of hanging", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      // Yields one chunk, then parks forever - a swarm drying up mid-file.
      const file: BuiltinStreamFile = {
        name: "Movie.mkv",
        path: "Folder/Movie.mkv",
        length: 8 * 1024 * 1024,
        stream() {
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new Uint8Array(64 * 1024));
                return;
              }
              return new Promise<void>(() => {});
            },
          });
        },
      };
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
            headers: { range: "bytes=0-2000000" },
          }),
          { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
          { ...depsFor(torrent, file), stallTimeoutMs: 60 },
        ),
        2000,
      );
      assert.equal(res.status, 206);
      // The point is not merely that it fails, but that it fails *promptly*.
      // Without a per-read stall guard the body simply never settles, so assert
      // on elapsed time against a much longer outer timeout.
      const startedAt = Date.now();
      await assert.rejects(
        withTimeout(res.arrayBuffer(), 4000),
        "a stalled body must error, not hang forever",
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 1500,
        `stalled body should error near the 60ms stall timeout, took ${elapsed}ms`,
      );
    });

    await check("srt sidecars are converted to WebVTT", async () => {
      resetStreamPrefetchForTests();
      const torrent = new FakeTorrent();
      const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello\n";
      const bytes = new TextEncoder().encode(srt);
      const file: BuiltinStreamFile = {
        name: "Movie.srt",
        path: "Folder/Movie.srt",
        length: bytes.length,
        stream() {
          let done = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (done) return controller.close();
              done = true;
              controller.enqueue(bytes);
            },
          });
        },
      };
      const res = await withTimeout(
        handleStreamFileRequest(
          new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.srt`),
          { infoHash: HASH, filePath: ["Folder", "Movie.srt"] },
          depsFor(torrent, file),
        ),
        2000,
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/vtt/);
      const text = await res.text();
      assert.ok(text.startsWith("WEBVTT"), "must carry the WebVTT signature");
      assert.ok(
        text.includes("00:00:01.000 --> 00:00:02.500"),
        `comma timestamps must become dots, got: ${text}`,
      );
    });

    await check("non-builtin active client returns 409", async () => {
      const res = await requestFile(
        {},
        makeFile("Folder/Movie.mkv", 2048),
        { ...builtinConfig, clientType: "qbittorrent", host: "http://127.0.0.1:8080" },
      );
      assert.equal(res.status, 409);
      const body = (await res.json()) as { clientType?: string; message?: string };
      assert.equal(body.clientType, "qbittorrent");
      assert.match(body.message || "", /built-in/i);
    });

    await check("stream index returns torrent files and clientType", async () => {
      const torrent = new FakeTorrent();
      const file = makeFile("Folder/Movie.mkv", 2048);
      const res = await handleStreamIndexRequest(
        { infoHash: HASH },
        depsFor(torrent, file),
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        clientType?: string;
        files?: { path: string; length: number; index: number; downloadedRanges: unknown[] }[];
      };
      assert.equal(body.clientType, "builtin");
      assert.deepEqual(body.files, [
        { path: "Folder/Movie.mkv", length: 2048, index: 0, downloadedRanges: [] },
      ]);
    });
  } finally {
    console.info = oldInfo;
    console.warn = oldWarn;
  }
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} stream route test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll stream route tests passed.");
});
