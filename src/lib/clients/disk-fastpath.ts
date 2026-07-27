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
    const bytes = await readTorrentPieceFromDisk(t, piece);
    if (!bytes) return false;
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) return false;
  }
  return true;
}

async function readTorrentPieceFromDisk(
  torrent: TorrentWithDiskState,
  piece: number,
): Promise<Uint8Array | null> {
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
  const out = new Uint8Array(expectedLength);
  let written = 0;

  for (const f of files) {
    const fileOffset = finiteWholeNumber(f.offset);
    if (fileOffset == null || !Number.isFinite(f.length) || f.length < 0) return null;
    const fileStart = fileOffset;
    const fileEnd = fileStart + f.length - 1;
    if (f.length === 0 || fileEnd < pieceStart || fileStart > pieceEnd) continue;

    const diskPath = safeDiskPath(torrent, f);
    if (!diskPath) return null;
    let handle: FileHandle | null = null;
    try {
      handle = await open(diskPath, "r");
      const s = await handle.stat();
      if (!s.isFile() || s.size !== f.length) return null;
      const startInFile = Math.max(pieceStart, fileStart) - fileStart;
      const length = Math.min(pieceEnd, fileEnd) - Math.max(pieceStart, fileStart) + 1;
      const { bytesRead } = await handle.read(
        out,
        written,
        length,
        startInFile,
      );
      if (bytesRead !== length) return null;
      written += bytesRead;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return written === expectedLength ? out : null;
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
