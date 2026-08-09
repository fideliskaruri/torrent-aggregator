/**
 * Hybrid disk/engine range delivery for an INCOMPLETE torrent file.
 *
 * WHY THIS EXISTS
 * ---------------
 * `openVerifiedDiskStream` (disk-fastpath.ts) is all-or-nothing per request: it
 * serves a range only when *every* piece covering that range is already
 * verified. The moment one byte of the request is missing, the whole response
 * falls back to the live WebTorrent iterator — so a viewer who is 90% through a
 * still-downloading file re-streams bytes that are already sitting on their own
 * disk, through the engine, at swarm speed and swarm latency.
 *
 * The Jellyfin-style answer is to split the request at the availability
 * boundary: read the verified prefix straight off the sparse/growing file, and
 * only hand the missing tail to the engine — inside the SAME response, so the
 * `Content-Length` / `Content-Range` we already promised the player stays true.
 *
 * WHY BITFIELDS AND NOT SPARSE-FILE HOLES
 * ---------------------------------------
 * The engine uses WebTorrent's default fs chunk store (see builtin-engine.ts —
 * no custom `store`/`storeOpts` is configured). That store does positional
 * writes into one growing file per torrent file. Two consequences decide this
 * design:
 *
 *  1. There is NO portable hole oracle. Node exposes neither `SEEK_HOLE` nor a
 *     trustworthy `stat().blocks` on Windows (`blocks` is 0 / undefined on
 *     NTFS through libuv), and a hole reads back as zeroes rather than an
 *     error. Trusting the filesystem would silently feed a player a block of
 *     `0x00` — the worst possible failure, because it corrupts the stream
 *     without raising anything.
 *  2. `stat().size` is NOT a completeness signal either. A positional write at
 *     a high offset extends the file to that offset with a hole behind it, so
 *     `size === file.length` can be true while most of the file is a hole. It
 *     is only usable as an *upper bound* guard ("do not read past EOF").
 *
 * So the only sound availability oracle is the piece layer:
 * `torrent.bitfield.get(piece)` for a live torrent, which
 * `isTorrentRangeVerifiedOnDisk` already wraps. Every disk byte this module
 * emits is covered by a hash-verified piece; a hole is unreachable by
 * construction.
 *
 * BYTE -> PIECE MAPPING
 * ---------------------
 * Pieces are torrent-absolute, files are not. Absolute offset of file byte `b`
 * is `file.offset + b`; its piece is `floor(absolute / torrent.pieceLength)`.
 * That is exactly `torrentPieceRangeForFileRange`, which this module reuses so
 * there is one mapping in the codebase, not two. Edge pieces are shared with
 * the neighbouring files of a multi-file torrent, which is fine: a shared piece
 * is either verified (all of its bytes, in every file it covers, are good) or
 * it is not.
 *
 * SELF-HEALING CURSOR, NOT A FROZEN PLAN
 * --------------------------------------
 * Availability changes *while* the response is being written — that is the
 * whole point of a live download. So the runtime never commits to a whole-range
 * plan up front. It walks a cursor and re-asks the bitfield after every
 * segment, which means bytes that arrive during an engine wait are served from
 * disk on the next lap instead of being pulled through the engine again.
 * {@link planHybridRange} exists as the pure, snapshot-in-time projection of
 * that same rule so the segmentation logic is testable without a swarm.
 */
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import {
  isTorrentRangeVerifiedOnDisk,
  type ByteRange,
} from "@/lib/clients/disk-fastpath";

export type HybridSource = "disk" | "engine";

export type HybridSegment = {
  source: HybridSource;
  /** Inclusive, file-relative. */
  start: number;
  /** Inclusive, file-relative. */
  end: number;
};

type TorrentShape = BuiltinStreamTorrent & {
  path?: string;
  pieceLength?: number;
  pieces?: unknown[];
};

type FileShape = BuiltinStreamFile & { offset?: number };

/** Chunk size handed to the reader per pull. Matches a typical fs highWaterMark. */
export const HYBRID_DISK_CHUNK_BYTES = 64 * 1024;

/**
 * Cap on how many pieces one engine segment may cover before the loop
 * re-checks the bitfield.
 *
 * This is a two-sided trade and both sides are real:
 *
 *  - Too large and a single engine segment swallows the rest of the request,
 *    pulling bytes through the swarm that landed on disk meanwhile.
 *  - Too small — one piece, the original value — and a contiguous multi-piece
 *    hole is torn into one segment per piece, each paying a `prioritize()`
 *    call, a fresh `file.stream()` open and a reader cancel. On a 16 KiB-piece
 *    torrent a 4 MiB hole meant ~256 open/prioritize/cancel cycles, which
 *    thrashes the engine's stream selection far more than it helps: each new
 *    selection re-seeks the swarm to a point it was already fetching.
 *
 * Contiguous unverified pieces are therefore coalesced into ONE engine segment
 * served by ONE reader, bounded here. The bound still guarantees the bitfield
 * is re-consulted regularly, so bytes that arrive mid-response are picked up
 * from disk on the next lap.
 */
export const HYBRID_ENGINE_MAX_SEGMENT_PIECES = 16;

/**
 * Kill switch for the hybrid disk+engine body, mirroring
 * `streamingRetentionEnabled`'s shape: default-on, disabled by an explicit
 * `off`.
 *
 * Default-on is justified because the hybrid path is only ever entered when the
 * range's FIRST segment is already verified on disk — i.e. exactly the case the
 * pure-engine fallback serves at swarm speed today despite the bytes sitting on
 * the user's own disk. Every byte it emits comes from a verified piece or from
 * the same `file.stream()` the fallback would have used, and the total is
 * clamped to the promised `Content-Length`. The switch exists so a field
 * regression can be turned off without a deploy, not because the path is
 * speculative.
 */
export function hybridStreamEnabled(
  env: { TORRENTFLOW_HYBRID_STREAM?: string } = {
    TORRENTFLOW_HYBRID_STREAM: process.env.TORRENTFLOW_HYBRID_STREAM,
  },
): boolean {
  return env.TORRENTFLOW_HYBRID_STREAM !== "off";
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function pieceGeometry(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
): { pieceLength: number; fileOffset: number } | null {
  const t = torrent as TorrentShape;
  const f = file as FileShape;
  const pieceLength = wholeNumber(t.pieceLength);
  const fileOffset = wholeNumber(f.offset);
  if (!pieceLength || fileOffset == null) return null;
  return { pieceLength, fileOffset };
}

/**
 * Last file-relative byte covered by `piece`, clamped to `limit`.
 */
function pieceEndInFile(
  pieceLength: number,
  fileOffset: number,
  piece: number,
  limit: number,
): number {
  const absoluteEnd = (piece + 1) * pieceLength - 1;
  return Math.min(limit, absoluteEnd - fileOffset);
}

function pieceOf(pieceLength: number, fileOffset: number, byte: number): number {
  return Math.floor((fileOffset + byte) / pieceLength);
}

function byteVerified(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  byte: number,
): boolean {
  return isTorrentRangeVerifiedOnDisk(torrent, file, { start: byte, end: byte });
}

/**
 * The next contiguous segment of `range` starting at `cursor`, classified by
 * where its bytes must come from.
 *
 * A disk segment is extended greedily across every following verified piece, so
 * an already-downloaded prefix is one single sequential read rather than one
 * read per piece. An engine segment is extended the same way across contiguous
 * *unverified* pieces, but bounded by
 * {@link HYBRID_ENGINE_MAX_SEGMENT_PIECES} so the caller re-consults the
 * bitfield promptly — see that constant for why neither extreme works.
 *
 * Returns `null` when the geometry is unusable (no `pieceLength`/`offset`, or a
 * cursor outside the range) — the caller must then treat the whole remainder as
 * engine-sourced, which is the pre-existing behaviour and always correct.
 */
export function nextHybridSegment(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
  cursor: number,
): HybridSegment | null {
  const geo = pieceGeometry(torrent, file);
  if (!geo) return null;
  if (cursor < range.start || cursor > range.end) return null;
  if (range.start < 0 || range.end < range.start || range.end >= file.length) return null;

  const { pieceLength, fileOffset } = geo;
  const startPiece = pieceOf(pieceLength, fileOffset, cursor);
  const endPiece = pieceOf(pieceLength, fileOffset, range.end);
  const onDisk = byteVerified(torrent, file, cursor);

  // Both sources extend across contiguous same-availability pieces; only the
  // limit differs. Disk is unbounded (reading verified bytes can never be
  // wrong, and one sequential read beats N), engine is capped so the bitfield
  // is re-read while the response is still being written.
  const maxPiece = onDisk
    ? endPiece
    : Math.min(endPiece, startPiece + HYBRID_ENGINE_MAX_SEGMENT_PIECES - 1);
  let last = startPiece;
  while (
    last + 1 <= maxPiece &&
    byteVerified(
      torrent,
      file,
      pieceEndInFile(pieceLength, fileOffset, last, range.end) + 1,
    ) === onDisk
  ) {
    last += 1;
  }
  return {
    source: onDisk ? "disk" : "engine",
    start: cursor,
    end: pieceEndInFile(pieceLength, fileOffset, last, range.end),
  };
}

/**
 * Pure, snapshot-in-time segmentation of a whole requested range.
 *
 * This is what the runtime *would* do if the bitfield never changed. It is the
 * unit-testable core of the hybrid rule and is also useful for logging/metrics
 * ("this request was 82% disk"). The runtime itself re-derives each segment as
 * it goes, so its real output can contain more disk segments than this
 * predicts — never fewer, since pieces are only ever added.
 *
 * Adjacent segments from the same source are merged, so the result alternates.
 * When geometry is unusable the whole range is reported as one engine segment.
 */
export function planHybridRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
): HybridSegment[] {
  if (range.start < 0 || range.end < range.start || range.end >= file.length) return [];
  const out: HybridSegment[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    const seg = nextHybridSegment(torrent, file, range, cursor);
    if (!seg) {
      out.push({ source: "engine", start: cursor, end: range.end });
      break;
    }
    const prev = out[out.length - 1];
    if (prev && prev.source === seg.source && prev.end + 1 === seg.start) {
      prev.end = seg.end;
    } else {
      out.push({ ...seg });
    }
    cursor = seg.end + 1;
  }
  return out;
}

/** Fraction of a requested range that can be served without touching the swarm. */
export function hybridDiskShare(segments: readonly HybridSegment[]): number {
  let total = 0;
  let disk = 0;
  for (const s of segments) {
    const n = s.end - s.start + 1;
    total += n;
    if (s.source === "disk") disk += n;
  }
  return total > 0 ? disk / total : 0;
}

/**
 * Resolve the on-disk path of a torrent file, refusing to escape the save root.
 * Mirrors `safeDiskPath` in disk-fastpath.ts (kept private there).
 */
export function hybridDiskPath(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
): string | null {
  const t = torrent as TorrentShape;
  const root = typeof t.path === "string" ? t.path.trim() : "";
  const rel = (file.path || file.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !rel) return null;
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, ...rel.split("/").filter(Boolean));
  const between = path.relative(rootPath, filePath);
  if (!between || between.startsWith("..") || path.isAbsolute(between)) return null;
  return filePath;
}

export type HybridRangeDeps = {
  /**
   * Read `[start,end]` (inclusive, file-relative) off disk. MUST NOT return
   * bytes past EOF of the growing file. Injected so tests need no torrent.
   */
  readDisk?: (start: number, end: number) => AsyncIterable<Uint8Array>;
  /** Open an engine byte range. Defaults to `file.stream({start,end})`. */
  openEngine?: (start: number, end: number) => ReadableStream<Uint8Array>;
  /** Called once before each engine segment so the swarm fetches it first. */
  prioritize?: (byteOffset: number) => void;
  /** Aborts the whole response (the route's `request.signal`). */
  signal?: AbortSignal;
  /** Observability hook; fires as each segment starts. */
  onSegment?: (segment: HybridSegment) => void;
};

class AbortedError extends Error {
  constructor() {
    super("Hybrid range stream aborted");
    this.name = "AbortedError";
  }
}

/**
 * Default disk reader: positional reads through one FileHandle, bounded by the
 * file's CURRENT size.
 *
 * The EOF bound is the second safety net behind the bitfield. The sparse file
 * only grows as the store writes, so a verified piece whose bytes are still
 * being flushed, or a store that has not yet extended the file that far, would
 * otherwise produce a short read. `read()` returning fewer bytes than asked is
 * treated as a hard error rather than being padded — silently short-changing a
 * promised `Content-Length` is exactly the bug this module must not have.
 */
function defaultDiskReader(
  filePath: string,
  fileLength: number,
): (start: number, end: number) => AsyncIterable<Uint8Array> {
  return async function* read(start, end) {
    let handle: FileHandle | null = null;
    try {
      const s = await stat(filePath);
      if (!s.isFile() || s.size > fileLength || end >= s.size) {
        throw new Error("hybrid: requested disk bytes are past end of file");
      }
      handle = await open(filePath, "r");
      let pos = start;
      while (pos <= end) {
        const want = Math.min(HYBRID_DISK_CHUNK_BYTES, end - pos + 1);
        const buf = new Uint8Array(want);
        const { bytesRead } = await handle.read(buf, 0, want, pos);
        if (bytesRead !== want) {
          throw new Error("hybrid: short read from growing file");
        }
        pos += bytesRead;
        yield buf;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
}

/**
 * Build the response body for `range`, alternating between the sparse file on
 * disk and the live engine, and always delivering exactly
 * `range.end - range.start + 1` bytes.
 *
 * Backpressure: the stream is pull-based with one bounded chunk of read-ahead.
 * Both sources remain async iterators, so the queue can absorb routine disk or
 * promise latency without allowing the response to run away in memory.
 *
 * Cancellation: `cancel()` (browser seek, tab close) and `signal` (route abort)
 * both settle the current iterator via `return()`, which closes the FileHandle
 * and cancels the engine reader. No descriptor and no engine selection outlives
 * the response.
 *
 * Resilience: a disk segment that fails *before emitting anything* is retried
 * against the engine rather than breaking the committed response; after partial
 * emission the failure is fatal, because the byte position can no longer be
 * recovered without duplicating or skipping bytes.
 */
export function openHybridRangeStream(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
  deps: HybridRangeDeps = {},
): ReadableStream<Uint8Array> {
  const diskPath = hybridDiskPath(torrent, file);
  const readDisk =
    deps.readDisk ?? (diskPath ? defaultDiskReader(diskPath, file.length) : null);
  const openEngine =
    deps.openEngine ?? ((start: number, end: number) =>
      // WebTorrent treats `end: 0` as "unset" and would select the whole file.
      // The outer loop clamps the byte count, so a widened end is safe.
      file.stream({ start, end: Math.max(end, 1) }));

  async function* body(): AsyncGenerator<Uint8Array> {
    let cursor = range.start;
    while (cursor <= range.end) {
      if (deps.signal?.aborted) throw new AbortedError();
      const planned = nextHybridSegment(torrent, file, range, cursor);
      const segment: HybridSegment =
        planned && !(planned.source === "disk" && !readDisk)
          ? planned
          : { source: "engine", start: cursor, end: planned?.end ?? range.end };
      deps.onSegment?.(segment);

      let servedFromDisk = false;
      if (segment.source === "disk" && readDisk) {
        // A disk read can fail for reasons that say nothing about whether the
        // bytes are available in the swarm: the growing file has not been
        // extended that far yet, the store is mid-flush, the handle is denied
        // by a sharing lock (routine on Windows), the fingerprint moved. The
        // engine can still serve those bytes, and the response is already
        // committed — a `Content-Length` was promised — so killing it would
        // turn a recoverable local hiccup into broken playback.
        //
        // The fallback is therefore allowed ONLY while this segment has emitted
        // nothing. Once a byte of the segment is in the client's hands the
        // stream position is unrecoverable: replaying the segment from the
        // engine would duplicate bytes and resuming past them would need an
        // offset the failed reader cannot be trusted to report. A failure after
        // partial emission MUST stay fatal.
        let emitted = 0;
        try {
          for await (const chunk of readDisk(segment.start, segment.end)) {
            if (deps.signal?.aborted) throw new AbortedError();
            emitted += chunk.byteLength;
            yield chunk;
          }
          servedFromDisk = true;
        } catch (error) {
          if (emitted > 0 || error instanceof AbortedError) throw error;
          // Report the retry so the source switch is visible in the logs.
          deps.onSegment?.({ ...segment, source: "engine" });
        }
      }

      if (!servedFromDisk) {
        deps.prioritize?.(segment.start);
        const reader = openEngine(segment.start, segment.end).getReader();
        let remaining = segment.end - segment.start + 1;
        try {
          while (remaining > 0) {
            if (deps.signal?.aborted) throw new AbortedError();
            const next = await reader.read();
            if (next.done) throw new Error("hybrid: engine ended mid-range");
            const chunk =
              next.value.byteLength > remaining
                ? next.value.subarray(0, remaining)
                : next.value;
            remaining -= chunk.byteLength;
            yield chunk;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      cursor = segment.end + 1;
    }
  }

  const iterator = body()[Symbol.asyncIterator]();
  let closed = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return;
        try {
          const next = await iterator.next();
          if (closed) return;
          if (next.done) {
            closed = true;
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (err) {
          if (closed) return;
          closed = true;
          throw err;
        }
      },
      async cancel() {
        closed = true;
        await iterator.return?.(undefined).catch(() => undefined);
      },
    },
    { highWaterMark: 2 },
  );
}
