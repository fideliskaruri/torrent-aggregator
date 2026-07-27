import rangeParser from "range-parser";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  findBuiltinTorrentFile,
  prefetchBuiltinFileEdges,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { isWebVtt, srtToVtt } from "@/lib/media/subtitles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const STREAM_STALL_TIMEOUT_MS = 15_000;
export const OPEN_ENDED_RANGE_CAP_BYTES = 8 * 1024 * 1024;

type RouteParams = {
  infoHash: string;
  filePath?: string[];
};

type StreamRange = {
  start: number;
  end: number;
  header: string | null;
  status: 200 | 206;
};

type StreamDeps = {
  getConfig?: () => Promise<ClientConnectionConfig | null>;
  findFile?: typeof findBuiltinTorrentFile;
  prefetchEdges?: typeof prefetchBuiltinFileEdges;
  stallTimeoutMs?: number;
};

const prefetchedFiles = new Set<string>();

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status });
}

function normalizeFilePath(segments: string[] | undefined): string | null {
  if (!segments?.length) return null;
  const clean: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
    if (segment.includes("\\") || segment.includes("/")) return null;
    clean.push(segment);
  }
  return clean.join("/");
}

function parseStreamRange(
  rangeHeader: string | null,
  fileLength: number,
): StreamRange | { error: 416 } {
  const lastByte = Math.max(0, fileLength - 1);
  if (!rangeHeader) {
    return { start: 0, end: lastByte, header: null, status: 200 };
  }

  const parsed = rangeParser(fileLength, rangeHeader);
  if (!Array.isArray(parsed) || parsed.length === 0) return { error: 416 };

  const first = parsed[0];
  let end = Math.min(first.end, lastByte);
  if (/^bytes=\d+-\s*$/i.test(rangeHeader.trim())) {
    end = Math.min(end, first.start + OPEN_ENDED_RANGE_CAP_BYTES - 1);
  }
  if (first.start < 0 || first.start > end || end >= fileLength) {
    return { error: 416 };
  }
  return {
    start: first.start,
    end,
    header: `bytes ${first.start}-${end}/${fileLength}`,
    status: 206,
  };
}

function contentTypeForPath(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "ogv":
      return "video/ogg";
    case "ts":
      return "video/mp2t";
    case "avi":
      return "video/x-msvideo";
    case "wmv":
      return "video/x-ms-wmv";
    case "srt":
    case "vtt":
      // .srt is converted to WebVTT before it is sent; see serveSubtitleAsVtt.
      return "text/vtt; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

function isSubtitlePath(filePath: string): boolean {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  return ext === "srt" || ext === "vtt";
}

/**
 * Subtitles are tiny and must be whole to parse, so they are read in full and
 * converted rather than streamed. A <track> element only ever accepts WebVTT --
 * serving raw SubRip makes the browser reject the cues with no visible error.
 */
async function serveSubtitleAsVtt(
  file: BuiltinStreamFile,
  method: string,
): Promise<Response | null> {
  if (file.length > MAX_SUBTITLE_BYTES) return null;
  const reader = file.stream({ start: 0, end: Math.max(file.length - 1, 1) }).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.length;
      if (total > MAX_SUBTITLE_BYTES) return null;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder("utf-8").decode(merged.subarray(0, file.length));
  const vtt = isWebVtt(raw) ? raw : srtToVtt(raw);
  const bytes = new TextEncoder().encode(vtt);
  const headers = new Headers({
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Accept-Ranges": "none",
  });
  return new Response(method === "HEAD" ? null : bytes, { status: 200, headers });
}

function torrentPeers(torrent?: BuiltinStreamTorrent): number | null {
  const peers = torrent?.numPeers;
  return typeof peers === "number" && Number.isFinite(peers) ? peers : null;
}

function torrentDownloadedPct(torrent?: BuiltinStreamTorrent): number | null {
  const progress = torrent?.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  return Math.round(progress * 10_000) / 100;
}

function logStreamRequest(entry: {
  infoHash: string;
  file?: string | null;
  range?: string | null;
  torrent?: BuiltinStreamTorrent;
  outcome: string;
}) {
  const peers = torrentPeers(entry.torrent);
  const downloaded = torrentDownloadedPct(entry.torrent);
  const payload = {
    infoHash: entry.infoHash,
    file: entry.file ?? null,
    range: entry.range ?? null,
    peers,
    downloadedPct: downloaded,
    outcome: entry.outcome,
    message:
      entry.outcome === "stalled"
        ? `stalled on piece, peers=${peers ?? 0}, downloaded=${downloaded ?? 0}%`
        : undefined,
  };
  const line = `[stream] ${JSON.stringify(payload)}`;
  if (entry.outcome === "stalled") console.warn(line);
  else console.info(line);
}

function responseHeaders(file: BuiltinStreamFile, range: StreamRange): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Content-Type": contentTypeForPath(file.path || file.name),
    "Content-Length": String(range.end - range.start + 1),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name || file.path)}`,
  });
  if (range.header) headers.set("Content-Range", range.header);
  return headers;
}

async function forceSettleParkedIterator(
  torrent: BuiltinStreamTorrent,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  // A parked FileIterator.next() only detaches its 'verified' listener when the
  // emitted index matches the piece it wants, or when the iterator is destroyed.
  // -1 can never be a real piece index, so this can only take the destroyed
  // branch -- it wakes the listener to unregister itself, never a spurious read.
  const wake = () => {
    try {
      torrent.emit?.("verified", -1);
    } catch {
      /* best-effort */
    }
  };

  const cancel = reader.cancel(reason).catch(() => undefined);
  // Once eagerly, in case cancel settled synchronously...
  wake();
  // ...then again once cancel has actually run and set destroyed. Waiting on the
  // cancel rather than a fixed number of microtask turns is what makes this
  // robust to WebTorrent's multi-hop cancel chain; the race only bounds a cancel
  // that never settles.
  await Promise.race([
    cancel,
    new Promise((resolve) => setTimeout(resolve, 25)),
  ]);
  wake();
}

async function firstChunkOrError(
  request: Request,
  torrent: BuiltinStreamTorrent,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<
  | { ok: true; first: ReadableStreamReadResult<Uint8Array> }
  | { ok: false; outcome: "stalled" | "aborted" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const firstRead = reader.read();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("stalled")), timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (request.signal.aborted) {
      reject(new DOMException("Request aborted", "AbortError"));
      return;
    }
    abort = () => reject(new DOMException("Request aborted", "AbortError"));
    request.signal.addEventListener("abort", abort, { once: true });
  });

  try {
    const first = await Promise.race([firstRead, timeout, aborted]);
    return { ok: true, first };
  } catch (err) {
    const outcome =
      err instanceof DOMException && err.name === "AbortError"
        ? "aborted"
        : "stalled";
    await forceSettleParkedIterator(torrent, reader, outcome);
    await Promise.race([
      firstRead.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 25)),
    ]);
    return { ok: false, outcome };
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) request.signal.removeEventListener("abort", abort);
  }
}

function prependFirstChunkStream(
  request: Request,
  torrent: BuiltinStreamTorrent,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: ReadableStreamReadResult<Uint8Array>,
  byteCount: number,
  stallTimeoutMs: number,
): ReadableStream<Uint8Array> {
  let pendingFirst: ReadableStreamReadResult<Uint8Array> | null = first;
  let remaining = byteCount;
  let abort: (() => void) | undefined;
  let closed = false;

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    controller.close();
    void forceSettleParkedIterator(torrent, reader, "range satisfied");
  };

  // WebTorrent decides the stream's end bound with `opts?.end && ...`, so an end
  // of 0 is falsy and silently widens to the whole file. Rather than trust the
  // bound, clamp to exactly the byte count we promised in Content-Length -- that
  // keeps the body honest whatever the source yields, and releases the iterator
  // as soon as the range is satisfied instead of draining the rest of the file.
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
  ) => {
    if (closed) return;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    if (slice.length > 0) {
      controller.enqueue(slice);
      remaining -= slice.length;
    }
    if (remaining <= 0) finish(controller);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        void forceSettleParkedIterator(torrent, reader, "client aborted");
        if (!closed) {
          closed = true;
          controller.error(new DOMException("Request aborted", "AbortError"));
        }
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (closed) return;
      if (remaining <= 0) return finish(controller);

      if (pendingFirst) {
        const next = pendingFirst;
        pendingFirst = null;
        if (next.done) finish(controller);
        else emit(controller, next.value);
        return;
      }

      // Every read needs the stall guard, not just the first. Playing a
      // partially-downloaded torrent whose swarm dries up mid-file would
      // otherwise park forever on a 'verified' listener that never fires: the
      // response would never end and never error, so the browser spins with no
      // way to fall back to an external player.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("stalled")), stallTimeoutMs);
          }),
        ]);
        if (next.done) finish(controller);
        else emit(controller, next.value);
      } catch (err) {
        await forceSettleParkedIterator(torrent, reader, "stalled mid-stream");
        if (!closed) {
          closed = true;
          controller.error(err instanceof Error ? err : new Error("stalled"));
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async cancel(reason) {
      closed = true;
      if (abort) request.signal.removeEventListener("abort", abort);
      await forceSettleParkedIterator(torrent, reader, String(reason ?? "cancelled"));
    },
  });
}

function triggerFirstPrefetch(
  infoHash: string,
  filePath: string,
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  prefetchEdges: typeof prefetchBuiltinFileEdges,
) {
  const key = `${infoHash}/${filePath}`;
  if (prefetchedFiles.has(key)) return;
  prefetchedFiles.add(key);
  void prefetchEdges(torrent, file).catch((err) => {
    // A stalled prefetch is exactly the cold-torrent case this exists to fix, so
    // release the key and let the next Play retry once peers show up.
    prefetchedFiles.delete(key);
    console.warn(
      "[stream]",
      JSON.stringify({
        infoHash,
        file: filePath,
        outcome: "prefetch_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });
}

export function resetStreamPrefetchForTests() {
  prefetchedFiles.clear();
}

export async function handleStreamFileRequest(
  request: Request,
  params: RouteParams,
  deps: StreamDeps = {},
): Promise<Response> {
  const infoHash = normalizeInfoHash(params.infoHash);
  const filePath = normalizeFilePath(params.filePath);
  if (!infoHash || !filePath) {
    logStreamRequest({
      infoHash: params.infoHash,
      file: filePath,
      range: request.headers.get("range"),
      outcome: "not_found",
    });
    return json(404, { error: "Torrent file not found" });
  }

  const getConfig =
    deps.getConfig ??
    (async () => {
      const session = await auth();
      if (!session?.user?.id) return null;
      return getUserClientConfig(session.user.id);
    });
  const config = await getConfig();
  if (!config) {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      outcome: "not_configured",
    });
    return json(503, { error: "No torrent client configured" });
  }
  if (config.clientType !== "builtin") {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      outcome: "non_builtin",
    });
    return json(409, {
      error: "Streaming requires the built-in client",
      message:
        "Only the built-in WebTorrent engine has live in-process file streams. Switch Settings → Built-in to play in the app.",
      clientType: config.clientType,
    });
  }

  const lookup = await (deps.findFile ?? findBuiltinTorrentFile)(
    config,
    infoHash,
    filePath,
  );
  if (lookup.status === "not_found") {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      outcome: "not_found",
    });
    return json(404, { error: "Torrent file not found" });
  }
  if (lookup.status === "metadata_pending") {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: "metadata_pending",
    });
    return json(425, {
      error: "Torrent metadata is not ready yet",
      message: "The torrent is still fetching metadata; try again in a moment.",
    });
  }

  if (isSubtitlePath(filePath)) {
    const subtitle = await serveSubtitleAsVtt(lookup.file, request.method);
    if (subtitle) {
      logStreamRequest({
        infoHash,
        file: filePath,
        range: request.headers.get("range"),
        torrent: lookup.torrent,
        outcome: "subtitle",
      });
      return subtitle;
    }
  }

  const range = parseStreamRange(request.headers.get("range"), lookup.file.length);
  if ("error" in range) {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: "bad_range",
    });
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${lookup.file.length}`,
      },
    });
  }

  const headers = responseHeaders(lookup.file, range);
  if (request.method === "HEAD") {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: range.status === 206 ? "partial_head" : "head",
    });
    return new Response(null, { status: range.status, headers });
  }

  triggerFirstPrefetch(
    infoHash,
    filePath,
    lookup.torrent,
    lookup.file,
    deps.prefetchEdges ?? prefetchBuiltinFileEdges,
  );

  const stallTimeoutMs = deps.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  // WebTorrent treats `end: 0` as "unset" and selects the whole file at
  // streaming priority. The player probes with `bytes=0-0` on every Play, so
  // without this floor each press would inject a whole-file critical selection
  // into the live download engine. The response body is clamped back to the
  // range we actually promised.
  const source = lookup.file.stream({
    start: range.start,
    end: Math.max(range.end, 1),
  });
  const reader = source.getReader();
  const first = await firstChunkOrError(
    request,
    lookup.torrent,
    reader,
    stallTimeoutMs,
  );
  if (!first.ok) {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: first.outcome === "aborted" ? "aborted" : "stalled",
    });
    return json(503, {
      error:
        first.outcome === "aborted"
          ? "Stream request aborted"
          : "Stream stalled waiting for data",
      message:
        first.outcome === "aborted"
          ? "The stream request was aborted before any bytes were available."
          : "stalled on piece",
    });
  }

  logStreamRequest({
    infoHash,
    file: filePath,
    range: request.headers.get("range"),
    torrent: lookup.torrent,
    outcome: range.status === 206 ? "partial" : "ok",
  });
  return new Response(
    prependFirstChunkStream(
      request,
      lookup.torrent,
      reader,
      first.first,
      range.end - range.start + 1,
      stallTimeoutMs,
    ),
    {
      status: range.status,
      headers,
    },
  );
}

type RouteContext = {
  params: RouteParams | Promise<RouteParams>;
};

export async function GET(request: Request, context: RouteContext) {
  return handleStreamFileRequest(request, await context.params);
}

export async function HEAD(request: Request, context: RouteContext) {
  return handleStreamFileRequest(request, await context.params);
}
