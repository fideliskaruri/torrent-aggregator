/**
 * Byte-range serving for playback output files.
 *
 * Shared by the session HLS route and the complete-file VOD route because both
 * hand the browser the same kinds of file — a manifest, an fMP4 init segment
 * and media segments — and both must do it by streaming rather than reading the
 * whole thing into memory. A 4-second fMP4 segment of a 4K HEVC remux is tens
 * of megabytes, and `readFileSync` on it blocks the same event loop that is
 * feeding ffmpeg from the torrent: the transcode starves itself while the
 * server serves its own output.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export function contentTypeForSegment(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  // The init segment and the media segments are both fMP4; browsers and hls.js
  // accept video/mp4 for either, and iso.segment is what the HLS spec names.
  if (lower.endsWith(".m4s")) return "video/iso.segment";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

export type ParsedRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Minimal single-range parser. Segments are immutable once written, so only the
 * simple `bytes=a-b` / `bytes=a-` / `bytes=-n` forms need supporting.
 */
export function parseSegmentRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
  end = Math.min(end, size - 1);
  if (start > end || start < 0 || start >= size) return "unsatisfiable";
  return { start, end };
}

/**
 * Resolve a requested path inside an output directory, refusing anything that
 * escapes it. `path.resolve` alone is not enough — a sibling directory sharing a
 * name prefix (`.sessions/abc-evil` vs `.sessions/abc`) passes a bare
 * `startsWith` check, so the separator has to be part of the comparison.
 */
export function resolveWithinSessionDir(outputDir: string, filename: string): string | null {
  if (!filename || filename.includes("\0")) return null;
  const resolved = path.resolve(outputDir, filename);
  const base = path.resolve(outputDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function bodyFromFile(
  absolutePath: string,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(absolutePath, { start, end });
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export type ServeOptions = {
  /** `no-store` for a manifest that can still change; immutable for segments. */
  cacheControl: string;
  /** HEAD requests must not carry a body. */
  bodyless?: boolean;
};

/**
 * Serve a file on disk honouring `Range`, or 416 when the range cannot be met.
 */
export function serveFileRange(
  absolutePath: string,
  filename: string,
  rangeHeader: string | null,
  options: ServeOptions,
): Response {
  let size: number;
  try {
    size = fs.statSync(absolutePath).size;
  } catch {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const range = parseSegmentRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const headers = new Headers({
    "Content-Type": contentTypeForSegment(filename),
    "Content-Length": String(size === 0 ? 0 : end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl,
  });
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  if (options.bodyless || size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  return new Response(bodyFromFile(absolutePath, start, end), {
    status: range ? 206 : 200,
    headers,
  });
}
