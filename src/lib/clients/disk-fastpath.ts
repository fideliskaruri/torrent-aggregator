import type { ReadStream } from "node:fs";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";

export type ByteRange = {
  start: number;
  end: number;
};

type TorrentWithDiskState = BuiltinStreamTorrent & {
  path?: string;
  length?: number;
  _hashes?: string[];
  pieceLength?: number;
  lastPieceLength?: number;
  pieces?: unknown[];
  ready?: boolean;
  bitfield?: { get?: (index: number) => boolean };
  files?: FileWithDiskState[];
};

type FileWithDiskState = BuiltinStreamFile & {
  offset?: number;
};

type PieceDiskFingerprint = {
  path: string;
  size: number;
  mtimeMs: number;
};

type PieceDiskSegment = {
  path: string;
  position: number;
  length: number;
  outOffset: number;
  fingerprint: PieceDiskFingerprint;
};

type VerifiedPieceCacheEntry = {
  fingerprints: PieceDiskFingerprint[];
};

const VERIFIED_PIECE_CACHE_LIMIT_PER_TORRENT = 4096;
const verifiedPieceCache = new WeakMap<object, Map<string, VerifiedPieceCacheEntry>>();
const verifiedPieceCacheStats = {
  hits: 0,
  misses: 0,
  stores: 0,
  invalidations: 0,
  evictions: 0,
};

export type DiskFastPathStream = {
  body: ReadableStream<Uint8Array>;
  path: string;
};

export type DiskFastPathOptions = {
  onClose?: (reason: "end" | "error" | "cancel" | "close") => void;
};

function finiteWholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function safeDiskPath(
  torrent: TorrentWithDiskState,
  file: FileWithDiskState,
): string | null {
  const root = typeof torrent.path === "string" ? torrent.path.trim() : "";
  const rel = (file.path || file.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !rel) return null;
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, ...rel.split("/").filter(Boolean));
  const between = path.relative(rootPath, filePath);
  if (!between || between.startsWith("..") || path.isAbsolute(between)) return null;
  return filePath;
}

function cacheKey(torrent: TorrentWithDiskState, piece: number): string | null {
  const hash =
    typeof torrent.infoHash === "string" ? torrent.infoHash.trim().toLowerCase() : "";
  return hash ? `${hash}:${piece}` : null;
}

function fingerprintsEqual(
  a: PieceDiskFingerprint[],
  b: PieceDiskFingerprint[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].path !== b[i].path ||
      a[i].size !== b[i].size ||
      a[i].mtimeMs !== b[i].mtimeMs
    ) {
      return false;
    }
  }
  return true;
}

function cachedPositiveVerification(
  torrent: TorrentWithDiskState,
  piece: number,
  fingerprints: PieceDiskFingerprint[],
): boolean {
  const key = cacheKey(torrent, piece);
  if (!key) return false;
  const cache = verifiedPieceCache.get(torrent);
  if (!cache) {
    verifiedPieceCacheStats.misses += 1;
    return false;
  }
  const entry = cache.get(key);
  if (!entry) {
    verifiedPieceCacheStats.misses += 1;
    return false;
  }
  if (!fingerprintsEqual(entry.fingerprints, fingerprints)) {
    cache.delete(key);
    verifiedPieceCacheStats.invalidations += 1;
    verifiedPieceCacheStats.misses += 1;
    return false;
  }
  cache.delete(key);
  cache.set(key, entry);
  verifiedPieceCacheStats.hits += 1;
  return true;
}

function cachePositiveVerification(
  torrent: TorrentWithDiskState,
  piece: number,
  fingerprints: PieceDiskFingerprint[],
): void {
  const key = cacheKey(torrent, piece);
  if (!key) return;
  let cache = verifiedPieceCache.get(torrent);
  if (!cache) {
    cache = new Map();
    verifiedPieceCache.set(torrent, cache);
  }
  cache.set(key, { fingerprints });
  verifiedPieceCacheStats.stores += 1;
  while (cache.size > VERIFIED_PIECE_CACHE_LIMIT_PER_TORRENT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
    verifiedPieceCacheStats.evictions += 1;
  }
}

export function resetDiskFastPathVerificationCacheForTests(): void {
  verifiedPieceCacheStats.hits = 0;
  verifiedPieceCacheStats.misses = 0;
  verifiedPieceCacheStats.stores = 0;
  verifiedPieceCacheStats.invalidations = 0;
  verifiedPieceCacheStats.evictions = 0;
}

export function diskFastPathVerificationCacheStatsForTests(): Readonly<{
  hits: number;
  misses: number;
  stores: number;
  invalidations: number;
  evictions: number;
}> {
  return { ...verifiedPieceCacheStats };
}

export function torrentPieceRangeForFileRange(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
): { start: number; end: number } | null {
  const t = torrent as TorrentWithDiskState;
  const f = file as FileWithDiskState;
  const pieceLength = finiteWholeNumber(t.pieceLength);
  const fileOffset = finiteWholeNumber(f.offset);
  if (!pieceLength || fileOffset == null) return null;
  if (range.start < 0 || range.end < range.start || range.end >= file.length) return null;

  const absoluteStart = fileOffset + range.start;
  const absoluteEnd = fileOffset + range.end;
  return {
    start: Math.floor(absoluteStart / pieceLength),
    end: Math.floor(absoluteEnd / pieceLength),
  };
}

export function isTorrentRangeVerifiedOnDisk(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
): boolean {
  const t = torrent as TorrentWithDiskState;
  if (t.ready === false) return false;
  const pieceRange = torrentPieceRangeForFileRange(torrent, file, range);
  const pieces = Array.isArray(t.pieces) ? t.pieces : null;
  const get = t.bitfield?.get;
  if (!pieceRange || !pieces || typeof get !== "function") return false;
  if (pieceRange.end >= pieces.length) return false;

  try {
    for (let piece = pieceRange.start; piece <= pieceRange.end; piece += 1) {
      if (!get.call(t.bitfield, piece)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifiedDiskPath(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
): Promise<string | null> {
  if (
    !isTorrentRangeVerifiedOnDisk(torrent, file, range) &&
    !(await verifyTorrentRangeFromDisk(torrent, file, range))
  ) {
    return null;
  }
  const filePath = safeDiskPath(torrent as TorrentWithDiskState, file as FileWithDiskState);
  if (!filePath) return null;
  try {
    const s = await stat(filePath);
    if (!s.isFile() || s.size !== file.length) return null;
    return filePath;
  } catch {
    return null;
  }
}

async function verifyTorrentRangeFromDisk(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
): Promise<boolean> {
  const t = torrent as TorrentWithDiskState;
  const pieceRange = torrentPieceRangeForFileRange(torrent, file, range);
  const hashes = Array.isArray(t._hashes) ? t._hashes : null;
  if (!pieceRange || !hashes || pieceRange.end >= hashes.length) return false;

  for (let piece = pieceRange.start; piece <= pieceRange.end; piece += 1) {
    const expected = hashes[piece];
    if (typeof expected !== "string" || !/^[a-f0-9]{40}$/i.test(expected)) return false;
    const plan = await torrentPieceDiskPlan(t, piece);
    if (!plan) return false;
    if (cachedPositiveVerification(t, piece, plan.fingerprints)) continue;
    const bytes = await readTorrentPieceFromDisk(plan);
    if (!bytes) return false;
    const afterRead = await torrentPieceDiskPlan(t, piece);
    if (!afterRead || !fingerprintsEqual(plan.fingerprints, afterRead.fingerprints)) {
      return false;
    }
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) return false;
    cachePositiveVerification(t, piece, afterRead.fingerprints);
  }
  return true;
}

async function torrentPieceDiskPlan(
  torrent: TorrentWithDiskState,
  piece: number,
): Promise<{
  expectedLength: number;
  fingerprints: PieceDiskFingerprint[];
  segments: PieceDiskSegment[];
} | null> {
  const pieceLength = finiteWholeNumber(torrent.pieceLength);
  const torrentLength = finiteWholeNumber(torrent.length);
  if (!pieceLength || torrentLength == null) return null;

  const pieceStart = piece * pieceLength;
  if (pieceStart >= torrentLength) return null;
  const pieceEnd = Math.min(torrentLength - 1, pieceStart + pieceLength - 1);
  const expectedLength =
    piece === ((Array.isArray(torrent._hashes) ? torrent._hashes.length : 0) - 1)
      ? finiteWholeNumber(torrent.lastPieceLength) || pieceEnd - pieceStart + 1
      : pieceEnd - pieceStart + 1;
  if (expectedLength <= 0 || expectedLength !== pieceEnd - pieceStart + 1) return null;

  const files = Array.isArray(torrent.files)
    ? [...torrent.files].sort(
        (a, b) => (finiteWholeNumber(a.offset) ?? 0) - (finiteWholeNumber(b.offset) ?? 0),
      )
    : [];
  const segments: PieceDiskSegment[] = [];
  const fingerprints: PieceDiskFingerprint[] = [];
  let covered = pieceStart;

  for (const f of files) {
    const fileOffset = finiteWholeNumber(f.offset);
    if (fileOffset == null || !Number.isFinite(f.length) || f.length < 0) return null;
    const fileStart = fileOffset;
    const fileEnd = fileStart + f.length - 1;
    if (f.length === 0 || fileEnd < pieceStart || fileStart > pieceEnd) continue;

    const diskPath = safeDiskPath(torrent, f);
    if (!diskPath) return null;
    try {
      const s = await stat(diskPath);
      if (!s.isFile() || s.size !== f.length) return null;
      const overlapStart = Math.max(pieceStart, fileStart);
      const overlapEnd = Math.min(pieceEnd, fileEnd);
      if (overlapStart !== covered) return null;
      const startInFile = overlapStart - fileStart;
      const length = Math.min(pieceEnd, fileEnd) - Math.max(pieceStart, fileStart) + 1;
      const fingerprint = {
        path: diskPath,
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
      fingerprints.push(fingerprint);
      segments.push({
        path: diskPath,
        position: startInFile,
        length,
        outOffset: overlapStart - pieceStart,
        fingerprint,
      });
      covered = overlapEnd + 1;
    } catch {
      return null;
    }
  }

  return covered === pieceEnd + 1 ? { expectedLength, fingerprints, segments } : null;
}

async function readTorrentPieceFromDisk(plan: {
  expectedLength: number;
  segments: PieceDiskSegment[];
}): Promise<Uint8Array | null> {
  const out = new Uint8Array(plan.expectedLength);
  for (const segment of plan.segments) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(segment.path, "r");
      const { bytesRead } = await handle.read(
        out,
        segment.outOffset,
        segment.length,
        segment.position,
      );
      if (bytesRead !== segment.length) return null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return out;
}

export async function openVerifiedDiskStream(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  range: ByteRange,
  opts: DiskFastPathOptions = {},
): Promise<DiskFastPathStream | null> {
  const filePath = await verifiedDiskPath(torrent, file, range);
  if (!filePath) return null;

  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r");
    const s = await handle.stat();
    if (!s.isFile() || s.size !== file.length) {
      await handle.close().catch(() => undefined);
      return null;
    }
    const nodeStream = handle.createReadStream({
      start: range.start,
      end: range.end,
    });
    const body = fileHandleStreamToWeb(handle, nodeStream, opts);
    handle = null;
    return {
      path: filePath,
      body,
    };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    return null;
  }
}

function fileHandleStreamToWeb(
  handle: FileHandle,
  nodeStream: ReadStream,
  opts: DiskFastPathOptions,
): ReadableStream<Uint8Array> {
  // Deliberately NOT `Readable.toWeb`. That adapter subscribes to 'data' and
  // enqueues from the event handler with no check that its controller is still
  // open, so a chunk already in flight when the reader is cancelled throws
  // "Invalid state: Controller is already closed" from inside `emit`. Nothing
  // owns that throw -- it is not on our await chain -- so it escapes as an
  // uncaughtException and takes the server's in-flight requests with it. A
  // browser cancels a range request on every seek, so this fired on ordinary
  // playback. Reading the Node stream directly keeps every chunk on a promise
  // we await, which is the only way the guards below can hold.
  const iterator = nodeStream[Symbol.asyncIterator]();
  let closeStarted: Promise<void> | null = null;
  let closed = false;

  const closeOnce = (reason: "end" | "error" | "cancel" | "close") => {
    if (!closeStarted) {
      opts.onClose?.(reason);
      closeStarted = handle.close().catch(() => undefined);
    }
    return closeStarted;
  };

  nodeStream.once("close", () => {
    void closeOnce("close");
  });
  nodeStream.once("error", () => {
    void closeOnce("error");
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const next = await iterator.next();
        // Re-check: a cancel can land while we were awaiting the chunk.
        if (closed) return;
        if (next.done) {
          closed = true;
          controller.close();
          await closeOnce("end");
          return;
        }
        controller.enqueue(new Uint8Array(next.value));
      } catch (err) {
        await closeOnce("error");
        // A cancelled stream has no controller left to reject.
        if (closed) return;
        closed = true;
        throw err;
      }
    },
    async cancel(reason) {
      closed = true;
      // Exactly one object owns this descriptor: the FileHandle. The Node stream
      // is only a reader over it. A browser seek or tab close cancels the web
      // stream before EOF, so explicitly destroy the Node side and close the
      // handle here instead of waiting for GC to discover an abandoned file.
      // `return()` destroys the readable and settles any parked `next()`.
      await iterator.return?.().catch(() => undefined);
      nodeStream.destroy(reason instanceof Error ? reason : undefined);
      await closeOnce("cancel");
    },
  });
}

export async function readVerifiedDiskFile(
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (file.length > maxBytes) return null;
  const end = Math.max(0, file.length - 1);
  const filePath = await verifiedDiskPath(torrent, file, { start: 0, end });
  if (!filePath) return null;
  try {
    const data = await readFile(filePath);
    if (data.byteLength !== file.length || data.byteLength > maxBytes) return null;
    return data;
  } catch {
    return null;
  }
}
