/**
 * Hybrid disk + engine stream route tests.
 *
 * The property under test is the one that makes this path safe to leave on:
 * a response that mixes bytes read off the growing sparse file with bytes
 * fetched from the swarm must be **byte-identical** to what the pure-engine
 * path would have produced, and must honour the `Content-Length` it promised.
 *
 * To prove the disk half is really coming off disk AND that a hole is never
 * read from disk, the fixture writes the file the way a real partial download
 * looks: verified regions hold the true bytes, unverified regions hold ZEROS
 * (a sparse hole reads back as zeroes on every filesystem Node can see — it
 * does not error, which is what makes it dangerous). The engine fake always
 * yields the true bytes. So:
 *
 *   - a zero anywhere in the body  ⇒ a hole was read from disk (the bug)
 *   - a byte-exact body           ⇒ verified regions came from disk and holes
 *                                    came from the engine
 */
import assert from "node:assert/strict";
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
import { FOREGROUND_IDLE_MS } from "@/lib/prewarm/foreground";
import { handleStreamFileRequest, withForegroundKeepalive } from "./route";

const HASH = "0123456789abcdef0123456789abcdef01234567";

const builtinConfig = {
  clientType: "builtin",
  userId: "user-1",
} as unknown as ClientConnectionConfig;

class FakeTorrent extends EventEmitter {
  infoHash = HASH;
  numPeers = 4;
  downloaded = 0;
  length?: number;
  files: BuiltinStreamFile[] = [];
  path?: string;
  pieceLength?: number;
  pieces?: unknown[];
  ready?: boolean;
  bitfield?: { get: (index: number) => boolean };
}

/** Deterministic, non-zero byte source — 0 is reserved to mean "hole". */
function byteAt(offset: number): number {
  return (offset % 251) + 1;
}

type Fixture = {
  root: string;
  torrent: FakeTorrent;
  file: BuiltinStreamFile;
  engineReads: Array<{ start: number; end: number }>;
  engineCancels: number;
  cleanup: () => Promise<void>;
};

/**
 * Build a partially-downloaded torrent on disk.
 *
 * `verifiedPieces` drives both the bitfield and which bytes actually exist in
 * the file; everything else is written as zeroes to stand in for a sparse hole.
 */
async function makePartialTorrent(opts: {
  length: number;
  pieceLength: number;
  fileOffset?: number;
  /**
   * Bytes actually present in the sparse file, when the store has not yet
   * extended it to the file's full length. Defaults to the full length.
   */
  diskBytes?: number;
  verifiedPieces: number[];
  engine?: (
    start: number,
    end: number,
    fixture: { cancels: () => void },
  ) => ReadableStream<Uint8Array> | null;
}): Promise<Fixture> {
  const root = makeScratchDir("hybrid-route");
  const rel = "Folder/Movie.mkv";
  const fullPath = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  const fileOffset = opts.fileOffset ?? 0;
  const verified = new Set(opts.verifiedPieces);
  const onDisk = new Uint8Array(opts.diskBytes ?? opts.length);
  for (let i = 0; i < onDisk.length; i += 1) {
    const piece = Math.floor((fileOffset + i) / opts.pieceLength);
    onDisk[i] = verified.has(piece) ? byteAt(i) : 0;
  }
  await fs.writeFile(fullPath, onDisk);

  const torrent = new FakeTorrent();
  const pieceCount = Math.ceil((fileOffset + opts.length) / opts.pieceLength);
  torrent.path = root;
  torrent.pieceLength = opts.pieceLength;
  torrent.pieces = Array.from({ length: pieceCount }, () => ({}));
  torrent.ready = true;
  torrent.bitfield = { get: (index: number) => verified.has(index) };

  const engineReads: Array<{ start: number; end: number }> = [];
  const fixture = { engineCancels: 0 };

  const file: BuiltinStreamFile & { offset?: number } = {
    name: "Movie.mkv",
    path: rel,
    length: opts.length,
    stream(streamOpts = {}) {
      const start = streamOpts.start ?? 0;
      // Mirror webtorrent's `opts?.end && ...`: an end of 0 is falsy and widens
      // to the whole file. The hybrid loop must clamp regardless.
      const end =
        streamOpts.end && streamOpts.end < opts.length
          ? streamOpts.end
          : opts.length - 1;
      engineReads.push({ start, end });
      const custom = opts.engine?.(start, end, {
        cancels: () => {
          fixture.engineCancels += 1;
        },
      });
      if (custom) return custom;
      let offset = start;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > end) {
            controller.close();
            return;
          }
          // Deliberately small so a segment spans several pulls — a segment
          // delivered in one chunk closes itself, and cancelling an
          // already-closed stream is a spec no-op, which would make the
          // cancellation test vacuous.
          const size = Math.min(256, end - offset + 1);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) chunk[i] = byteAt(offset + i);
          offset += size;
          controller.enqueue(chunk);
        },
        cancel() {
          fixture.engineCancels += 1;
        },
      });
    },
  };
  file.offset = fileOffset;

  return {
    root,
    torrent,
    file,
    engineReads,
    get engineCancels() {
      return fixture.engineCancels;
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function depsFor(
  fixture: Fixture,
  extra: Record<string, unknown> = {},
): Parameters<typeof handleStreamFileRequest>[2] {
  fixture.torrent.files = [fixture.file];
  const lookup: BuiltinStreamLookup = {
    status: "found",
    torrent: fixture.torrent as unknown as BuiltinStreamTorrent,
    file: fixture.file,
  };
  return {
    getConfig: async () => builtinConfig,
    // The persisted whole-file fast path must not intercept a partial torrent.
    findPersistedFile: async () => null,
    findFile: async () => lookup,
    prefetchEdges: async () => undefined,
    prioritizeFile: () => undefined,
    hybridEnabled: true,
    ...extra,
  } as Parameters<typeof handleStreamFileRequest>[2];
}

function get(
  fixture: Fixture,
  rangeHeader: string,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return handleStreamFileRequest(
    new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
      headers: { range: rangeHeader },
      ...(signal ? { signal } : {}),
    }),
    { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
    depsFor(fixture, extra),
  );
}

function expectedBytes(start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start + 1);
  for (let i = 0; i < out.length; i += 1) out[i] = byteAt(start + i);
  return out;
}

/** Stand-in for `acquireBuiltinStreamLease` that makes the refcount observable. */
function countingLease() {
  let outstanding = 0;
  let acquired = 0;
  return {
    get acquired() {
      return acquired;
    },
    held: () => outstanding,
    acquire: () => {
      acquired += 1;
      outstanding += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        outstanding -= 1;
      };
    },
  };
}

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

async function main() {
  await check("a verified prefix plus a hole is served byte-exact", async () => {
    // 4 pieces of 1024. Pieces 0,1 verified; 2 is a hole; 3 verified.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("Content-Length"), "4096");
      assert.equal(res.headers.get("Content-Range"), "bytes 0-4095/4096");
      assert.equal(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(body.length, 4096);
      assert.deepEqual(body, expectedBytes(0, 4095));
    } finally {
      await fixture.cleanup();
    }
  });

  await check("no zero byte survives into the body", async () => {
    // The direct assertion of "never serve a sparse hole": every zero on disk
    // sits in an unverified piece, so a single zero in the body means a hole
    // was read from the file instead of fetched.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
    });
    try {
      const body = new Uint8Array(await (await get(fixture, "bytes=0-4095")).arrayBuffer());
      assert.equal(body.indexOf(0), -1, "body contains a sparse-hole zero");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("the engine is asked only for the unverified segments", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    try {
      await (await get(fixture, "bytes=0-4095")).arrayBuffer();
      // Piece 2 is bytes 2048..3071 and is the only hole.
      assert.deepEqual(fixture.engineReads, [{ start: 2048, end: 3071 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("piece prioritization receives the hole offset, not the range start", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const seeks: number[] = [];
    try {
      const res = await get(fixture, "bytes=0-4095", {
        prioritizeFile: (
          _t: unknown,
          _f: unknown,
          o: { seekOffset: number },
        ) => {
          seeks.push(o.seekOffset);
        },
      });
      await res.arrayBuffer();
      assert.deepEqual(seeks, [2048], "the swarm must seek to the hole, not to byte 0");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("a mid-file range maps to the right pieces via the file offset", async () => {
    // A file that does not start on a piece boundary is where a naive
    // byte→piece mapping silently reads the neighbouring file's bytes.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      fileOffset: 512,
      verifiedPieces: [0, 1, 2, 4],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
      // File byte b lives in piece floor((512+b)/1024); piece 3 is unverified,
      // covering file bytes 2560..3583.
      assert.deepEqual(fixture.engineReads, [{ start: 2560, end: 3583 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("a partial range inside the file stays byte-exact and correctly sized", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
    });
    try {
      const res = await get(fixture, "bytes=100-2500");
      assert.equal(res.headers.get("Content-Length"), "2401");
      assert.equal(res.headers.get("Content-Range"), "bytes 100-2500/4096");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(body.length, 2401);
      assert.deepEqual(body, expectedBytes(100, 2500));
    } finally {
      await fixture.cleanup();
    }
  });

  await check("a range starting inside a hole is left to the pure engine path", async () => {
    // Hybrid must not take over a cold start: the pre-header stall probe is what
    // turns "no peers" into a 503 JSON instead of a hung body, and it only works
    // when hybrid stands aside.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [2, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      assert.notEqual(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
    } finally {
      await fixture.cleanup();
    }
  });

  await check("a fully verified range never enters the hybrid path", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 2, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      assert.notEqual(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      assert.deepEqual(fixture.engineReads, [], "no swarm read for a complete range");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
    } finally {
      await fixture.cleanup();
    }
  });

  await check("the feature gate returns the route to the pure engine path", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095", { hybridEnabled: false });
      assert.notEqual(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      assert.equal(res.headers.get("Content-Length"), "4096");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
      // The whole range came from the engine — the exact waste hybrid removes.
      assert.deepEqual(fixture.engineReads, [{ start: 0, end: 4095 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("HEAD is answered from headers alone, never through hybrid", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    try {
      const res = await handleStreamFileRequest(
        new Request(`http://localhost/api/stream/${HASH}/Folder/Movie.mkv`, {
          method: "HEAD",
          headers: { range: "bytes=0-4095" },
        }),
        { infoHash: HASH, filePath: ["Folder", "Movie.mkv"] },
        depsFor(fixture),
      );
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("Content-Length"), "4096");
      assert.equal(await res.text(), "");
      assert.deepEqual(fixture.engineReads, []);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("cancelling mid-body releases the engine reader", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      const reader = res.body!.getReader();
      // Stop partway INTO the engine segment (the verified prefix is bytes
      // 0..1023, the hole starts at 1024) so the engine reader is genuinely
      // mid-flight when the client seeks away.
      let read = 0;
      while (read < 1200) {
        const next = await reader.read();
        if (next.done) break;
        read += next.value.byteLength;
      }
      assert.ok(read < 2048, "must still be inside the first engine segment");
      await reader.cancel("client seek");
      // Cancel propagates through releaseWhenSettled → the hybrid generator's
      // `finally` → the engine reader; give the microtask chain a turn.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(fixture.engineCancels >= 1, "the engine reader must be cancelled");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("an engine segment that ends early errors instead of truncating", async () => {
    // Ending short would let the player treat a truncated body as EOF and stop
    // playback silently; the promised Content-Length can no longer be met, so
    // the response must break loudly.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
      engine: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.close();
          },
        }),
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      await assert.rejects(async () => {
        await res.arrayBuffer();
      });
    } finally {
      await fixture.cleanup();
    }
  });

  await check("an engine segment that errors breaks the response", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
      engine: () =>
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("swarm exploded");
          },
        }),
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      await assert.rejects(async () => {
        await res.arrayBuffer();
      });
    } finally {
      await fixture.cleanup();
    }
  });

  await check("an aborted request tears the body down", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 3],
    });
    const controller = new AbortController();
    try {
      const res = await get(fixture, "bytes=0-4095", {}, controller.signal);
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await assert.rejects(async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
        }
      });
    } finally {
      await fixture.cleanup();
    }
  });

  await check("an all-verified range of a still-GROWING file is served from disk", async () => {
    // The regression this locks down. `openVerifiedDiskStream` additionally
    // requires stat().size === file.length, so while the file is still growing
    // it refuses even a range whose every byte is present and hash-verified,
    // and the whole request would fall through to the swarm. Hybrid bounds
    // reads by the file's CURRENT size, so it must pick this up.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      diskBytes: 2048,
      verifiedPieces: [0, 1],
    });
    try {
      const res = await get(fixture, "bytes=0-2047");
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("Content-Length"), "2048");
      assert.equal(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 2047));
      assert.deepEqual(
        fixture.engineReads,
        [],
        "bytes already on disk must never be pulled through the swarm",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await check("a disk read that runs past the growing file falls back to the engine", async () => {
    // The bitfield claims every piece, but the store has only extended the file
    // to 2048 bytes. Reading on would serve zeroes; breaking would kill a
    // response whose headers are already committed. Nothing has been emitted
    // for the segment, so the engine answers it instead.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      diskBytes: 2048,
      verifiedPieces: [0, 1, 2, 3],
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      assert.equal(res.headers.get("Content-Length"), "4096");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
      assert.equal(body.indexOf(0), -1, "a hole reached the client as zeroes");
      assert.ok(fixture.engineReads.length > 0, "the engine must have covered the gap");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("contiguous holes cost one engine open, not one per piece", async () => {
    // 16 pieces of 256. Piece 0 verified, 1..15 one contiguous hole.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 256,
      verifiedPieces: [0],
    });
    const seeks: number[] = [];
    try {
      const res = await get(fixture, "bytes=0-4095", {
        prioritizeFile: (...args: unknown[]) => {
          const opts = args[args.length - 1] as { seekOffset?: number };
          seeks.push(opts?.seekOffset ?? -1);
        },
      });
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095));
      assert.deepEqual(fixture.engineReads, [{ start: 256, end: 4095 }]);
      assert.deepEqual(seeks, [256]);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("the stream lease is released once the body completes", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const lease = countingLease();
    try {
      const res = await get(fixture, "bytes=0-4095", { acquireLease: lease.acquire });
      assert.equal(lease.held(), 1, "a hybrid body must hold a lease while streaming");
      await res.arrayBuffer();
      assert.equal(lease.held(), 0, "completion must release the lease");
      assert.equal(lease.acquired, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  await check("the stream lease is released on cancel, abort and engine failure", async () => {
    const cancelFixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const cancelLease = countingLease();
    try {
      const res = await get(cancelFixture, "bytes=0-4095", {
        acquireLease: cancelLease.acquire,
      });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel("client seek");
      assert.equal(cancelLease.held(), 0, "cancel must release the lease");
    } finally {
      await cancelFixture.cleanup();
    }

    const abortFixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const abortLease = countingLease();
    const controller = new AbortController();
    try {
      const res = await get(
        abortFixture,
        "bytes=0-4095",
        { acquireLease: abortLease.acquire },
        controller.signal,
      );
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.read().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      assert.equal(abortLease.held(), 0, "abort must release the lease");
    } finally {
      await abortFixture.cleanup();
    }

    const errorFixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
      engine: () =>
        new ReadableStream<Uint8Array>({
          start(controllerRef) {
            controllerRef.error(new Error("swarm exploded"));
          },
        }),
    });
    const errorLease = countingLease();
    try {
      const res = await get(errorFixture, "bytes=0-4095", {
        acquireLease: errorLease.acquire,
      });
      await assert.rejects(res.arrayBuffer());
      assert.equal(errorLease.held(), 0, "an errored body must release the lease");
    } finally {
      await errorFixture.cleanup();
    }
  });

  await check("foreground activity is refreshed while a long body is flowing", async () => {
    // A single beacon at response start expires after FOREGROUND_IDLE_MS (20s)
    // and the prewarm sweep then parks the very torrent being watched. A slow
    // engine tail behind a fast disk prefix is exactly that shape.
    let clock = 0;
    const marks: number[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Each chunk "takes" 2s of wall time — 20 chunks span 40s.
        clock += 2_000;
        if (clock > 40_000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(8));
      },
    });
    const kept = withForegroundKeepalive(source, HASH, {
      now: () => clock,
      mark: () => marks.push(clock),
    });
    const reader = kept.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    // Beaconed on a clock, not per chunk: 20 chunks, far fewer beacons, and
    // never a gap wider than the idle window.
    assert.ok(marks.length >= 3, `expected periodic beacons, got ${marks.length}`);
    assert.ok(marks.length < 20, "the beacon must be throttled, not per chunk");
    let previous = 0;
    for (const at of marks) {
      assert.ok(
        at - previous < FOREGROUND_IDLE_MS,
        `foreground went stale for ${at - previous}ms while bytes were flowing`,
      );
      previous = at;
    }
    assert.ok(clock - previous < FOREGROUND_IDLE_MS);
  });

  await check("the PURE-ENGINE path also keeps foreground activity alive", async () => {
    // The engine path needs this more than hybrid does: with no verified prefix
    // every byte waits on the swarm, so a capped open-ended read comfortably
    // outlives the 20s foreground stamp. If the stamp lapses the prewarm sweep
    // parks and deselects the torrent mid-body and the response stalls.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const lease = countingLease();
    // Every clock read advances 2s, so the 4096-byte body spans ~30s of wall
    // time across its 256-byte chunks — well past FOREGROUND_IDLE_MS.
    let clock = 0;
    const marks: number[] = [];
    try {
      const res = await get(fixture, "bytes=0-4095", {
        hybridEnabled: false,
        acquireLease: lease.acquire,
        foregroundClock: {
          now: () => (clock += 2_000),
          mark: () => marks.push(clock),
        },
      });
      assert.notEqual(res.headers.get("X-TorrentFlow-Stream-Source"), "hybrid");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(body, expectedBytes(0, 4095), "the keepalive must not disturb bytes");

      assert.ok(marks.length >= 2, `expected periodic beacons, got ${marks.length}`);
      assert.ok(marks.length < body.length / 256, "the beacon must be throttled, not per chunk");
      let previous = 0;
      for (const at of marks) {
        assert.ok(
          at - previous < FOREGROUND_IDLE_MS,
          `foreground went stale for ${at - previous}ms while bytes were flowing`,
        );
        previous = at;
      }
      assert.equal(lease.held(), 0, "no lease leak through the keepalive wrapper");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("cancelling a pure-engine body still tears down through the keepalive", async () => {
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
    });
    const lease = countingLease();
    try {
      const res = await get(fixture, "bytes=0-4095", {
        hybridEnabled: false,
        acquireLease: lease.acquire,
      });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel("client seek");
      assert.equal(lease.held(), 0, "cancel must release the lease");
      assert.ok(fixture.engineCancels >= 1, "cancel must reach the engine reader");
    } finally {
      await fixture.cleanup();
    }
  });

  await check("an over-delivering engine is clamped to the promised length", async () => {
    // The `end: 0` widening bug in reverse: an engine that hands back more than
    // the segment asked for must not push the body past Content-Length.
    const fixture = await makePartialTorrent({
      length: 4096,
      pieceLength: 1024,
      verifiedPieces: [0, 1, 3],
      engine: (start) =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const size = 8192;
            const chunk = new Uint8Array(size);
            for (let i = 0; i < size; i += 1) chunk[i] = byteAt(start + i);
            controller.enqueue(chunk);
          },
        }),
    });
    try {
      const res = await get(fixture, "bytes=0-4095");
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(body.length, 4096);
      assert.deepEqual(body, expectedBytes(0, 4095));
    } finally {
      await fixture.cleanup();
    }
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} hybrid stream route test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll hybrid stream route tests passed.");
});
