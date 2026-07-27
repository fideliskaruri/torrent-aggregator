import type { ReadStream } from "node:fs";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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
  pieceLength?: number;
  pieces?: unknown[];
  ready?: boolean;
  bitfield?: { get?: (index: number) => boolean };
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
  if (!isTorrentRangeVerifiedOnDisk(torrent, file, range)) return null;
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
  const inner = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  const reader = inner.getReader();
  let closeStarted: Promise<void> | null = null;

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
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await closeOnce("end");
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        await closeOnce("error");
        throw err;
      }
    },
    async cancel(reason) {
      // Exactly one object owns this descriptor: the FileHandle. The Node stream
      // is only a reader over it. A browser seek or tab close cancels the web
      // stream before EOF, so explicitly destroy the Node side and close the
      // handle here instead of waiting for GC to discover an abandoned file.
      nodeStream.destroy(reason instanceof Error ? reason : undefined);
      await reader.cancel(reason).catch(() => undefined);
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
