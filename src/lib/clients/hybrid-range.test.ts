/**
 * Hybrid disk/engine range delivery.
 *
 * The contract under test:
 *   1. Bytes covered by verified pieces come from the sparse file on disk.
 *   2. Bytes that are not covered are fetched through the engine.
 *   3. The response delivers EXACTLY the promised byte count, in order,
 *      whichever mix of sources it took.
 *   4. A hole is never read: nothing outside a verified piece is read on disk.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import { makeScratchDir, removeScratchDir } from "@/lib/test-support/scratch-dir";
import {
  hybridDiskPath,
  hybridDiskShare,
  hybridStreamEnabled,
  nextHybridSegment,
  openHybridRangeStream,
  planHybridRange,
  HYBRID_ENGINE_MAX_SEGMENT_PIECES,
  type HybridSegment,
} from "./hybrid-range";

type FakeTorrent = BuiltinStreamTorrent & {
  path?: string;
  pieceLength: number;
  pieces: unknown[];
  ready: boolean;
  bitfield: { get: (index: number) => boolean };
};

const PIECE = 1024;

function torrent(opts: {
  verified?: number[];
  pieceCount?: number;
  pieceLength?: number;
  savePath?: string;
} = {}): FakeTorrent {
  const verified = new Set(opts.verified ?? []);
  return {
    infoHash: "abcdef1234567890abcdef1234567890abcdef12",
    name: "Fake torrent",
    progress: 0.4,
    downloadSpeed: 0,
    numPeers: 3,
    files: [],
    path: opts.savePath,
    pieceLength: opts.pieceLength ?? PIECE,
    pieces: Array.from({ length: opts.pieceCount ?? 8 }, () => ({})),
    ready: true,
    bitfield: { get: (index) => verified.has(index) },
  };
}

function file(length: number, offset = 0): BuiltinStreamFile & { offset: number } {
  return {
    name: "Movie.mkv",
    path: "Folder/Movie.mkv",
    length,
    offset,
    stream() {
      throw new Error("engine stream not stubbed for this test");
    },
  };
}

/** A source of deterministic, position-identifiable bytes. */
function byteAt(i: number): number {
  return (i * 7 + 13) % 251;
}

function expectedBytes(start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start + 1);
  for (let i = 0; i < out.length; i += 1) out[i] = byteAt(start + i);
  return out;
}

function streamOf(bytes: Uint8Array, chunk = 100): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, pos + chunk);
      controller.enqueue(bytes.subarray(pos, end));
      pos = end;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
    total += next.value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function shape(segments: readonly HybridSegment[]): string {
  return segments.map((s) => `${s.source}:${s.start}-${s.end}`).join(" ");
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
  await check("a fully verified range plans as one single disk segment", () => {
    const t = torrent({ verified: [0, 1, 2, 3] });
    const f = file(4 * PIECE);
    const plan = planHybridRange(t, f, { start: 0, end: 4 * PIECE - 1 });
    assert.equal(shape(plan), `disk:0-${4 * PIECE - 1}`);
    assert.equal(hybridDiskShare(plan), 1);
  });

  await check("a range with no verified pieces plans as engine only", () => {
    const t = torrent({ verified: [] });
    const f = file(4 * PIECE);
    const plan = planHybridRange(t, f, { start: 0, end: 4 * PIECE - 1 });
    assert.equal(shape(plan), `engine:0-${4 * PIECE - 1}`);
    assert.equal(hybridDiskShare(plan), 0);
  });

  await check("a verified prefix is served from disk and the tail from the engine", () => {
    // Pieces 0 and 1 are in, 2 and 3 are not: the classic "watching ahead of
    // the download" case the whole feature exists for.
    const t = torrent({ verified: [0, 1] });
    const f = file(4 * PIECE);
    const plan = planHybridRange(t, f, { start: 0, end: 4 * PIECE - 1 });
    assert.equal(
      shape(plan),
      `disk:0-${2 * PIECE - 1} engine:${2 * PIECE}-${4 * PIECE - 1}`,
    );
    assert.equal(hybridDiskShare(plan), 0.5);
  });

  await check("an interior hole splits the range into disk/engine/disk", () => {
    const t = torrent({ verified: [0, 2, 3] });
    const f = file(4 * PIECE);
    const plan = planHybridRange(t, f, { start: 0, end: 4 * PIECE - 1 });
    assert.equal(
      shape(plan),
      [
        `disk:0-${PIECE - 1}`,
        `engine:${PIECE}-${2 * PIECE - 1}`,
        `disk:${2 * PIECE}-${4 * PIECE - 1}`,
      ].join(" "),
    );
  });

  await check("segments never exceed the requested range", () => {
    const t = torrent({ verified: [0, 1, 2, 3] });
    const f = file(4 * PIECE);
    const range = { start: 500, end: 2500 };
    const plan = planHybridRange(t, f, range);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].start, 500);
    assert.equal(plan[0].end, 2500);
  });

  await check("a file at a non-zero torrent offset maps to the right pieces", () => {
    // File starts halfway through piece 1, so its byte 0 lives in piece 1.
    const f = file(3 * PIECE, PIECE + PIECE / 2);
    const t = torrent({ verified: [1], pieceCount: 8 });
    const plan = planHybridRange(t, f, { start: 0, end: 3 * PIECE - 1 });
    // Piece 1 covers file bytes 0..511 only; the rest is unverified.
    assert.equal(plan[0].source, "disk");
    assert.equal(plan[0].end, PIECE / 2 - 1);
    assert.equal(plan[1].source, "engine");
  });

  await check("an unusable geometry degrades to a single engine segment", () => {
    const t = { ...torrent({ verified: [0, 1, 2, 3] }), pieceLength: 0 } as FakeTorrent;
    const f = file(4 * PIECE);
    const plan = planHybridRange(t, f, { start: 0, end: 100 });
    assert.equal(shape(plan), "engine:0-100");
  });

  await check("an invalid range plans nothing", () => {
    const t = torrent({ verified: [0] });
    const f = file(4 * PIECE);
    assert.deepEqual(planHybridRange(t, f, { start: 10, end: 5 }), []);
    assert.deepEqual(planHybridRange(t, f, { start: 0, end: 4 * PIECE }), []);
    assert.equal(nextHybridSegment(t, f, { start: 0, end: 10 }, 11), null);
  });

  await check("the body delivers the exact promised bytes across both sources", async () => {
    const t = torrent({ verified: [0, 1] });
    const f = file(4 * PIECE);
    const range = { start: 0, end: 4 * PIECE - 1 };
    const seen: HybridSegment[] = [];

    const body = openHybridRangeStream(t, f, range, {
      readDisk: async function* (start, end) {
        // Disk reads must stay inside verified pieces 0..1.
        assert.ok(end < 2 * PIECE, `disk read escaped verified pieces at ${end}`);
        yield expectedBytes(start, end);
      },
      openEngine: (start, end) => streamOf(expectedBytes(start, end)),
      onSegment: (s) => seen.push(s),
    });

    const out = await drain(body);
    assert.equal(out.byteLength, range.end - range.start + 1);
    assert.deepEqual(out, expectedBytes(range.start, range.end));
    assert.equal(shape(seen), `disk:0-${2 * PIECE - 1} engine:${2 * PIECE}-${4 * PIECE - 1}`);
  });

  await check("contiguous missing pieces coalesce into one engine segment", async () => {
    // The churn this prevents: one segment per piece meant one prioritize(),
    // one file.stream() open and one reader cancel per piece, so a multi-piece
    // hole re-seeked the swarm dozens of times while it was already fetching.
    const t = torrent({ verified: [0] });
    const f = file(8 * PIECE);
    const range = { start: 0, end: 8 * PIECE - 1 };
    const opens: Array<[number, number]> = [];
    const offsets: number[] = [];
    const cancels: number[] = [];

    const body = openHybridRangeStream(t, f, range, {
      readDisk: async function* (start, end) {
        yield expectedBytes(start, end);
      },
      openEngine: (start, end) => {
        opens.push([start, end]);
        const bytes = expectedBytes(start, end);
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
          },
          cancel() {
            cancels.push(start);
          },
        });
      },
      prioritize: (byte) => offsets.push(byte),
    });

    const out = await drain(body);
    // Byte exactness is the non-negotiable half of this optimisation.
    assert.deepEqual(out, expectedBytes(range.start, range.end));
    // Seven missing pieces, one reader — not seven.
    assert.deepEqual(opens, [[PIECE, 8 * PIECE - 1]]);
    assert.deepEqual(offsets, [PIECE]);
    assert.equal(cancels.length, 1);
  });

  await check("an engine run longer than the cap is split so the bitfield is re-read", async () => {
    const t = torrent({ verified: [0], pieceCount: 40 });
    const f = file(40 * PIECE);
    // planHybridRange merges adjacent same-source segments by design, so the
    // cap is observed on the runtime primitive the body actually walks.
    const seg = nextHybridSegment(t, f, { start: 0, end: 40 * PIECE - 1 }, PIECE);
    assert.equal(seg?.source, "engine");
    assert.equal(seg?.start, PIECE);
    // The bound, not the whole remainder: 16 pieces of engine at a time.
    assert.equal(seg?.end, (1 + HYBRID_ENGINE_MAX_SEGMENT_PIECES) * PIECE - 1);
  });

  await check("pieces that arrive mid-response are served from disk on the next lap", async () => {
    // Start with only piece 0. While the engine is delivering the coalesced
    // hole, the pieces beyond the cap land. The cursor must notice at the
    // segment boundary and switch back to disk instead of pulling bytes it
    // already owns through the swarm.
    const holePieces = HYBRID_ENGINE_MAX_SEGMENT_PIECES;
    const totalPieces = 1 + holePieces + 3;
    const verified = new Set([0]);
    const t = torrent({ verified: [], pieceCount: totalPieces });
    t.bitfield = { get: (i) => verified.has(i) };
    const f = file(totalPieces * PIECE);
    const range = { start: 0, end: totalPieces * PIECE - 1 };
    const seen: HybridSegment[] = [];

    const body = openHybridRangeStream(t, f, range, {
      readDisk: async function* (start, end) {
        yield expectedBytes(start, end);
      },
      openEngine: (start, end) => {
        for (let p = 1 + holePieces; p < totalPieces; p += 1) verified.add(p);
        return streamOf(expectedBytes(start, end));
      },
      onSegment: (s) => seen.push(s),
    });

    const out = await drain(body);
    assert.deepEqual(out, expectedBytes(range.start, range.end));
    assert.equal(
      shape(seen),
      [
        `disk:0-${PIECE - 1}`,
        `engine:${PIECE}-${(1 + holePieces) * PIECE - 1}`,
        `disk:${(1 + holePieces) * PIECE}-${totalPieces * PIECE - 1}`,
      ].join(" "),
    );
  });

  await check("the engine is prioritized at the first byte of every engine segment", async () => {
    const t = torrent({ verified: [0] });
    const f = file(3 * PIECE);
    const offsets: number[] = [];
    const body = openHybridRangeStream(t, f, { start: 0, end: 3 * PIECE - 1 }, {
      readDisk: async function* (start, end) {
        yield expectedBytes(start, end);
      },
      openEngine: (start, end) => streamOf(expectedBytes(start, end)),
      prioritize: (byte) => offsets.push(byte),
    });
    await drain(body);
    // Pieces 1 and 2 are one contiguous hole, so the swarm is seeked once, to
    // the start of that hole — never to bytes already verified.
    assert.deepEqual(offsets, [PIECE]);
  });

  await check("an over-long engine chunk is clamped to the segment", async () => {
    const t = torrent({ verified: [] });
    const f = file(PIECE);
    const range = { start: 0, end: 99 };
    const body = openHybridRangeStream(t, f, range, {
      // Deliberately hand back more bytes than asked for, which is what
      // WebTorrent does when `end` is widened off `Math.max(end, 1)`.
      openEngine: () => streamOf(expectedBytes(0, PIECE - 1)),
    });
    const out = await drain(body);
    assert.equal(out.byteLength, 100);
    assert.deepEqual(out, expectedBytes(0, 99));
  });

  await check("an engine source that ends early fails loudly instead of short-writing", async () => {
    const t = torrent({ verified: [] });
    const f = file(PIECE);
    const body = openHybridRangeStream(t, f, { start: 0, end: 499 }, {
      openEngine: () => streamOf(expectedBytes(0, 99)),
    });
    await assert.rejects(drain(body), /engine ended mid-range/);
  });

  await check("an aborted signal stops the response", async () => {
    const t = torrent({ verified: [] });
    const f = file(PIECE);
    const controller = new AbortController();
    controller.abort();
    const body = openHybridRangeStream(t, f, { start: 0, end: 99 }, {
      openEngine: () => streamOf(expectedBytes(0, 99)),
      signal: controller.signal,
    });
    await assert.rejects(drain(body), /aborted/i);
  });

  await check("cancelling the response releases the underlying source", async () => {
    const t = torrent({ verified: [0, 1] });
    const f = file(2 * PIECE);
    let released = false;
    const body = openHybridRangeStream(t, f, { start: 0, end: 2 * PIECE - 1 }, {
      readDisk: async function* (start, end) {
        try {
          for (let p = start; p <= end; p += 100) {
            yield expectedBytes(p, Math.min(end, p + 99));
          }
        } finally {
          released = true;
        }
      },
    });
    const reader = body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(released, true, "the disk iterator was not finalised on cancel");
  });

  await check("the response keeps one bounded disk chunk read ahead", async () => {
    const t = torrent({ verified: [0] });
    const f = file(PIECE);
    let produced = 0;
    const body = openHybridRangeStream(t, f, { start: 0, end: 299 }, {
      readDisk: async function* () {
        for (let start = 0; start < 300; start += 100) {
          produced += 1;
          yield expectedBytes(start, start + 99);
        }
      },
    });
    const reader = body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(produced >= 2, `expected bounded read-ahead, produced ${produced} chunk`);
    await reader.cancel();
  });

  await check("the default disk reader serves real bytes off a growing file", async () => {
    const root = makeScratchDir("hybrid-range-disk");
    try {
      const dir = path.join(root, "Folder");
      await fs.mkdir(dir, { recursive: true });
      const full = expectedBytes(0, 4 * PIECE - 1);
      await fs.writeFile(path.join(dir, "Movie.mkv"), full);

      const t = torrent({ verified: [0, 1, 2, 3], savePath: root });
      const f = file(4 * PIECE);
      assert.equal(hybridDiskPath(t, f), path.join(root, "Folder", "Movie.mkv"));

      const out = await drain(
        openHybridRangeStream(t, f, { start: 300, end: 3000 }),
      );
      assert.deepEqual(out, expectedBytes(300, 3000));
    } finally {
      removeScratchDir(root);
    }
  });

  await check("a growing file that stops short falls back to the engine, never to zeroes", async () => {
    // The bitfield claims piece 3 is verified but the sparse file has not been
    // extended that far yet. Reading anyway would hand the player a block of
    // zeroes. Nothing has been emitted for this segment, so the correct move is
    // not to break the committed response but to fetch it from the swarm.
    const root = makeScratchDir("hybrid-range-eof");
    try {
      const dir = path.join(root, "Folder");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "Movie.mkv"), expectedBytes(0, PIECE - 1));

      const t = torrent({ verified: [0, 1, 2, 3], savePath: root });
      const f = file(4 * PIECE);
      const range = { start: 0, end: 4 * PIECE - 1 };
      const opens: Array<[number, number]> = [];
      const seen: HybridSegment[] = [];
      const out = await drain(
        openHybridRangeStream(t, f, range, {
          openEngine: (start, end) => {
            opens.push([start, end]);
            return streamOf(expectedBytes(start, end));
          },
          onSegment: (s) => seen.push(s),
        }),
      );
      assert.deepEqual(out, expectedBytes(range.start, range.end));
      assert.deepEqual(opens, [[0, 4 * PIECE - 1]]);
      // The retry is reported so the source switch shows up in the logs.
      assert.equal(shape(seen), `disk:0-${4 * PIECE - 1} engine:0-${4 * PIECE - 1}`);
    } finally {
      removeScratchDir(root);
    }
  });

  await check("an unopenable disk file falls back to the engine for that segment", async () => {
    // Covers the open()/share-violation class: the path resolves but the handle
    // cannot be taken. Same rule — nothing emitted yet, so the swarm answers.
    const t = torrent({ verified: [0] });
    const f = file(2 * PIECE);
    const range = { start: 0, end: 2 * PIECE - 1 };
    const opens: Array<[number, number]> = [];
    const out = await drain(
      openHybridRangeStream(t, f, range, {
        readDisk: async function* () {
          throw new Error("EBUSY: resource busy or locked");
        },
        openEngine: (start, end) => {
          opens.push([start, end]);
          return streamOf(expectedBytes(start, end));
        },
      }),
    );
    assert.deepEqual(out, expectedBytes(range.start, range.end));
    assert.deepEqual(opens, [
      [0, PIECE - 1],
      [PIECE, 2 * PIECE - 1],
    ]);
  });

  await check("a disk failure AFTER bytes were emitted stays fatal", async () => {
    // The load-bearing half of the fallback rule. Once part of a segment is in
    // the client's hands the position is unrecoverable: replaying it from the
    // engine would duplicate bytes and resuming past it would corrupt them. So
    // this must break the response rather than paper over it.
    const t = torrent({ verified: [0] });
    const f = file(2 * PIECE);
    let engineOpens = 0;
    await assert.rejects(
      drain(
        openHybridRangeStream(t, f, { start: 0, end: 2 * PIECE - 1 }, {
          readDisk: async function* (start) {
            yield expectedBytes(start, start + 9);
            throw new Error("hybrid: short read from growing file");
          },
          openEngine: (start, end) => {
            engineOpens += 1;
            return streamOf(expectedBytes(start, end));
          },
        }),
      ),
      /short read from growing file/,
    );
    assert.equal(engineOpens, 0, "a partially emitted segment must not be retried");
  });

  await check("a save path outside the root is refused", () => {
    const t = torrent({ savePath: "D:/downloads/pack" });
    const escaping = { ...file(PIECE), path: "../../etc/passwd" };
    assert.equal(hybridDiskPath(t, escaping), null);
    assert.equal(hybridDiskPath(torrent({}), file(PIECE)), null);
  });

  await check("the hybrid kill switch is default-on and needs an explicit off", () => {
    assert.equal(hybridStreamEnabled({}), true);
    assert.equal(hybridStreamEnabled({ TORRENTFLOW_HYBRID_STREAM: undefined }), true);
    assert.equal(hybridStreamEnabled({ TORRENTFLOW_HYBRID_STREAM: "on" }), true);
    // Anything other than the exact opt-out keeps the path on, so a typo in an
    // env file cannot silently send every partial stream back to the swarm.
    assert.equal(hybridStreamEnabled({ TORRENTFLOW_HYBRID_STREAM: "" }), true);
    assert.equal(hybridStreamEnabled({ TORRENTFLOW_HYBRID_STREAM: "off" }), false);
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} hybrid range test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll hybrid range tests passed.");
});
