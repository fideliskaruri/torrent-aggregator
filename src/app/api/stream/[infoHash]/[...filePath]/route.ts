import rangeParser from "range-parser";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  findBuiltinTorrentFile,
  prefetchBuiltinFileEdges,
  prioritizeBuiltinStreamFile,
  resetBuiltinStreamPriorityForTests,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import {
  openVerifiedDiskStream,
  readVerifiedDiskFile,
} from "@/lib/clients/disk-fastpath";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { isWebVtt, srtToVtt } from "@/lib/media/subtitles";
import { markForegroundActive } from "@/lib/prewarm/foreground";
import {
  readWithStallGuard,
  sampleStreamTransfer,
  streamStallOptions,
  type StallGuardDeps,
  type StallGuardResult,
} from "@/lib/clients/stream-stall";
import {
  classifyPlaybackFailure,
  type PlaybackFailure,
} from "@/lib/clients/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Legacy fixed-timeout constant, retained as the DEFAULT stall WINDOW (max time
 * with zero delivered bytes) rather than a wall-clock deadline. A stream that is
 * still receiving bytes is never abandoned; see {@link readWithStallGuard}.
 */
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
  prioritizeFile?: typeof prioritizeBuiltinStreamFile;
  openDiskStream?: typeof openVerifiedDiskStream;
  stallTimeoutMs?: number;
};

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
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  method: string,
): Promise<{ response: Response; source: "disk" | "swarm" } | null> {
  if (file.length > MAX_SUBTITLE_BYTES) return null;
  let merged = await readVerifiedDiskFile(torrent, file, MAX_SUBTITLE_BYTES);
  let source: "disk" | "swarm" = "disk";
  if (!merged) {
    source = "swarm";
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

    merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
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
  return {
    response: new Response(method === "HEAD" ? null : bytes, { status: 200, headers }),
    source,
  };
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

/**
 * Build the byte-progress stall guard deps for one torrent. The `stallWindowMs`
 * (from `deps.stallTimeoutMs`, default {@link STREAM_STALL_TIMEOUT_MS}) becomes
 * the maximum ZERO-byte span tolerated — not a wall-clock deadline.
 */
function streamStallGuardDeps(
  torrent: BuiltinStreamTorrent,
  stallWindowMs: number,
): StallGuardDeps {
  return {
    sample: () => sampleStreamTransfer(torrent),
    options: streamStallOptions(stallWindowMs),
  };
}

async function firstChunkOrError(
  request: Request,
  torrent: BuiltinStreamTorrent,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  guardDeps: StallGuardDeps,
): Promise<
  | { ok: true; first: ReadableStreamReadResult<Uint8Array> }
  | { ok: false; outcome: "stalled" | "aborted"; guard: StallGuardResult<ReadableStreamReadResult<Uint8Array>> }
> {
  const firstRead = reader.read();
  // Race the SAME read promise against byte-progress; a progressing swarm keeps
  // the read alive however slow, and only a truly byte-stalled one errors.
  const result = await readWithStallGuard(() => firstRead, request.signal, guardDeps);
  if (result.ok) {
    return { ok: true, first: result.value };
  }
  const outcome = result.reason === "aborted" ? "aborted" : "stalled";
  await forceSettleParkedIterator(torrent, reader, outcome);
  // Always observe the parked read so its eventual rejection cannot escape.
  await Promise.race([
    firstRead.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 25)),
  ]);
  return { ok: false, outcome, guard: result };
}

function prependFirstChunkStream(
  request: Request,
  torrent: BuiltinStreamTorrent,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  first: ReadableStreamReadResult<Uint8Array>,
  byteCount: number,
  guardDeps: StallGuardDeps,
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
      // way to fall back to an external player. The guard uses byte progress,
      // so a slow-but-progressing swarm keeps streaming and only a truly frozen
      // one aborts the body.
      const guard = await readWithStallGuard(
        () => reader.read(),
        request.signal,
        guardDeps,
      );
      if (guard.ok) {
        const next = guard.value;
        if (next.done) finish(controller);
        else emit(controller, next.value);
        return;
      }
      await forceSettleParkedIterator(torrent, reader, "stalled mid-stream");
      if (!closed) {
        closed = true;
        const cause =
          guard.reason === "aborted"
            ? new DOMException("Request aborted", "AbortError")
            : guard.error instanceof Error
              ? guard.error
              : new Error("stalled");
        controller.error(cause);
      }
    },
    async cancel(reason) {
      closed = true;
      if (abort) request.signal.removeEventListener("abort", abort);
      await forceSettleParkedIterator(torrent, reader, String(reason ?? "cancelled"));
    },
  });
}

function triggerStreamPriority(
  infoHash: string,
  filePath: string,
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  seekOffset: number,
  prefetchEdges: typeof prefetchBuiltinFileEdges,
  prioritizeFile: typeof prioritizeBuiltinStreamFile,
) {
  prioritizeFile(torrent, file, {
    seekOffset,
    prefetchEdges,
    onPrefetchError(err) {
      // A stalled prefetch is exactly the cold-torrent case this exists to fix,
      // so let the engine release its prefetch key and let the next Play retry
      // once peers show up.
      console.warn(
        "[stream]",
        JSON.stringify({
          infoHash,
          file: filePath,
          outcome: "prefetch_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    },
  });
}

export function resetStreamPrefetchForTests() {
  // Kept for older stream-route tests. The prefetch de-dupe now lives beside the
  // WebTorrent priority state so non-route callers get the same cheap no-op.
  resetBuiltinStreamPriorityForTests();
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
    const subtitle = await serveSubtitleAsVtt(
      lookup.torrent,
      lookup.file,
      request.method,
    );
    if (subtitle) {
      // A subtitle body is not video, but it is still playback: the viewer chose
      // timed text for this torrent, and extracting or serving it can touch the
      // same disk and swarm the video needs. Listing subtitles stays invisible;
      // serving actual subtitle bytes keeps speculative work parked.
      if (request.method !== "HEAD") markForegroundActive(infoHash);
      logStreamRequest({
        infoHash,
        file: filePath,
        range: request.headers.get("range"),
        torrent: lookup.torrent,
        outcome: subtitle.source === "disk" ? "subtitle_disk" : "subtitle",
      });
      return subtitle.response;
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

  const disk = await (deps.openDiskStream ?? openVerifiedDiskStream)(
    lookup.torrent,
    lookup.file,
    range,
  );
  if (disk) {
    markForegroundActive(infoHash);
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: range.status === 206 ? "partial_disk" : "ok_disk",
    });
    // The stall guard below is for a live WebTorrent iterator that can park on a
    // future `verified` event forever when the swarm dries up. A local file read
    // does not wait for future pieces; if Windows or the disk rejects the open we
    // never enter this branch, and once the OS has accepted the handle a read
    // failure should surface as a real response error rather than be hidden as a
    // swarm stall.
    return new Response(disk.body, { status: range.status, headers });
  }

  triggerStreamPriority(
    infoHash,
    filePath,
    lookup.torrent,
    lookup.file,
    range.start,
    deps.prefetchEdges ?? prefetchBuiltinFileEdges,
    deps.prioritizeFile ?? prioritizeBuiltinStreamFile,
  );

  const stallWindowMs = deps.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  const guardDeps = streamStallGuardDeps(lookup.torrent, stallWindowMs);
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
    guardDeps,
  );
  if (!first.ok) {
    logStreamRequest({
      infoHash,
      file: filePath,
      range: request.headers.get("range"),
      torrent: lookup.torrent,
      outcome: first.outcome === "aborted" ? "aborted" : "stalled",
    });
    if (first.outcome === "aborted") {
      return json(503, {
        error: "Stream request aborted",
        code: "ABORTED",
        message:
          "The stream request was aborted before any bytes were available.",
      });
    }
    // I19: classify the byte-stall into a machine code the player can act on —
    // NO_PEERS is a delivery failure the SAME release can be retried once peers
    // return; STALLED means peers are present but bytes froze. The default copy
    // is mechanism-free and the player may override it.
    const failure: PlaybackFailure = classifyPlaybackFailure({
      stallReason: "stalled",
      peerCount: lookup.torrent.numPeers ?? 0,
      error: first.guard.ok ? undefined : first.guard.error,
    });
    return json(503, {
      error: "Stream stalled waiting for data",
      code: failure.kind,
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      message: failure.defaultMessage,
    });
  }

  markForegroundActive(infoHash);
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
      guardDeps,
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
