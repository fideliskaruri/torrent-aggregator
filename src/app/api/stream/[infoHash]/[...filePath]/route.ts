import rangeParser from "range-parser";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserClientConfig, type ClientConnectionConfig } from "@/lib/clients";
import {
  acquireBuiltinStreamLease,
  findLiveBuiltinTorrentFile,
  prefetchBuiltinFileEdges,
  prioritizeBuiltinStreamFile,
  resetBuiltinStreamPriorityForTests,
  type BuiltinStreamFile,
  type BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import {
  diskFileLengthByPath,
  openDiskFileByPath,
  openVerifiedDiskStream,
  readDiskFileByPath,
  readVerifiedDiskFile,
  resolveCompletedPersistedDiskFile,
  type PersistedDiskFile,
} from "@/lib/clients/disk-fastpath";
import {
  hybridStreamEnabled,
  openHybridRangeStream,
  planHybridRange,
  type HybridSegment,
} from "@/lib/clients/hybrid-range";
import prisma from "@/lib/prisma";
import { normalizeInfoHash } from "@/lib/torrents/infohash";
import { isSupportedMediaAssetFileName } from "@/lib/torrents/filters";
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
// Keep open-ended reads bounded so abandoned consumers release their stream
// selection, but large enough that high-bitrate 4K inputs do not reconnect
// every second and repeatedly repay torrent first-chunk latency.
export const OPEN_ENDED_RANGE_CAP_BYTES = 128 * 1024 * 1024;

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
  findPersistedFile?: (
    config: ClientConnectionConfig,
    infoHash: string,
    filePath: string,
  ) => Promise<PersistedDiskFile | null>;
  findFile?: typeof findLiveBuiltinTorrentFile;
  prefetchEdges?: typeof prefetchBuiltinFileEdges;
  prioritizeFile?: typeof prioritizeBuiltinStreamFile;
  diskFileLength?: typeof diskFileLengthByPath;
  openDiskFile?: typeof openDiskFileByPath;
  openDiskStream?: typeof openVerifiedDiskStream;
  openHybridStream?: typeof openHybridRangeStream;
  hybridEnabled?: boolean;
  acquireLease?: typeof acquireBuiltinStreamLease;
  /**
   * Injectable clock for the foreground keepalive. Production passes nothing;
   * tests use it to drive the 5s beacon interval without real wall time.
   */
  foregroundClock?: { now?: () => number; mark?: (hash: string) => void };
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

function responseHeaders(
  file: Pick<BuiltinStreamFile, "name" | "path" | "length">,
  range: StreamRange,
): Headers {
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

async function findPersistedDiskFile(
  config: ClientConnectionConfig,
  infoHash: string,
  filePath: string,
): Promise<PersistedDiskFile | null> {
  try {
    const row = await prisma.engineTorrent.findFirst({
      where: {
        hash: infoHash,
        status: { not: "removed" },
        ...(config.userId ? { userId: config.userId } : {}),
      },
      select: {
        progress: true,
        savePath: true,
        verifiedBitfield: true,
        verifiedFilesJson: true,
      },
    });
    if (!row?.verifiedBitfield?.trim()) return null;
    return resolveCompletedPersistedDiskFile(
      row.progress,
      row.savePath,
      row.verifiedFilesJson,
      filePath,
    );
  } catch {
    return null;
  }
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

/**
 * Wrap ONE engine segment of a hybrid body in the same byte-progress stall
 * guard the pure-engine path uses.
 *
 * Without this, a hybrid response that starts on disk and then reaches a hole
 * whose swarm has dried up would park on a `verified` listener forever: bytes
 * already flowed, so the client sees a live-but-frozen body that never ends and
 * never errors — strictly worse than the pure-engine path, which at least
 * fails. Erroring the segment errors the whole body, which is the correct
 * signal: the promised `Content-Length` can no longer be met, so the response
 * MUST break rather than end short and let the player treat truncation as EOF.
 */
function stallGuardedEngineSegment(
  request: Request,
  torrent: BuiltinStreamTorrent,
  file: BuiltinStreamFile,
  guardDeps: StallGuardDeps,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  // `end: 0` is falsy to WebTorrent and silently widens to the whole file; the
  // hybrid loop clamps the byte count, so flooring the bound is safe.
  const source = file.stream({ start, end: Math.max(end, 1) });
  const reader = source.getReader();
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      const guard = await readWithStallGuard(
        () => reader.read(),
        request.signal,
        guardDeps,
      );
      if (closed) return;
      if (guard.ok) {
        if (guard.value.done) {
          closed = true;
          controller.close();
          void forceSettleParkedIterator(torrent, reader, "segment complete");
          return;
        }
        controller.enqueue(guard.value.value);
        return;
      }
      closed = true;
      await forceSettleParkedIterator(torrent, reader, "stalled mid-segment");
      throw guard.reason === "aborted"
        ? new DOMException("Request aborted", "AbortError")
        : guard.error instanceof Error
          ? guard.error
          : new Error("stalled");
    },
    async cancel(reason) {
      closed = true;
      await forceSettleParkedIterator(torrent, reader, String(reason ?? "cancelled"));
    },
  });
}

/**
 * Interval between foreground beacons while a body is streaming.
 *
 * `markForegroundActive` is a timestamp, and `FOREGROUND_IDLE_MS` is 20s. A
 * single beacon at response start is therefore only enough for a SHORT
 * response. An open-ended read is capped at `OPEN_ENDED_RANGE_CAP_BYTES`
 * (128 MiB) — minutes of wall time on a slow swarm, and hybrid makes long
 * bodies *more* likely because a fast verified prefix is followed by a slow
 * engine tail. Without a refresh the stamp expires while bytes are still
 * flowing and `syncPrewarmSuspension` parks the very torrent being watched,
 * stalling the response it is in the middle of serving.
 *
 * Refreshing on a clock rather than per chunk keeps the hot path to one
 * `Date.now()` comparison per chunk; the beacon itself fires at most once per
 * interval however many chunks pass.
 */
export const FOREGROUND_KEEPALIVE_MS = 5_000;

/**
 * Keep the foreground stamp fresh for as long as the response is producing
 * bytes. Purely a side-channel: chunks pass through untouched, and a failure to
 * beacon can never affect the body.
 */
export function withForegroundKeepalive(
  body: ReadableStream<Uint8Array>,
  infoHash: string,
  clock: { now?: () => number; mark?: (hash: string) => void } = {},
): ReadableStream<Uint8Array> {
  const now = clock.now ?? Date.now;
  const mark = clock.mark ?? markForegroundActive;
  const reader = body.getReader();
  let lastMarkedAt = now();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      const at = now();
      if (at - lastMarkedAt >= FOREGROUND_KEEPALIVE_MS) {
        lastMarkedAt = at;
        mark(infoHash);
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function releaseWhenSettled(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
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
  if (!infoHash || !filePath || !isSupportedMediaAssetFileName(filePath)) {
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
  const persisted = await (deps.findPersistedFile ?? findPersistedDiskFile)(
    config,
    infoHash,
    filePath,
  );
  persistedFastPath: if (persisted) {
    const length = await (deps.diskFileLength ?? diskFileLengthByPath)(
      persisted.path,
      persisted.length,
      persisted.mtimeMs,
      persisted.rootPath,
    );
    if (length != null) {
      if (isSubtitlePath(filePath) && length <= MAX_SUBTITLE_BYTES) {
        try {
          const subtitle = await readDiskFileByPath(
            persisted.path,
            persisted.length,
            persisted.mtimeMs,
            MAX_SUBTITLE_BYTES,
            persisted.rootPath,
          );
          if (!subtitle) throw new Error("persisted subtitle changed");
          const raw = new TextDecoder("utf-8").decode(subtitle);
          const vtt = isWebVtt(raw) ? raw : srtToVtt(raw);
          const bytes = new TextEncoder().encode(vtt);
          const headers = new Headers({
            "Content-Type": "text/vtt; charset=utf-8",
            "Content-Length": String(bytes.length),
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Accept-Ranges": "none",
            "X-TorrentFlow-Stream-Source": "disk-fastpath",
          });
          logStreamRequest({
            infoHash,
            file: filePath,
            range: request.headers.get("range"),
            outcome: "subtitle_disk_fastpath",
          });
          return new Response(request.method === "HEAD" ? null : bytes, {
            status: 200,
            headers,
          });
        } catch {
          // The normal engine-backed subtitle path remains the safe fallback.
        }
      }
      if (isSubtitlePath(filePath)) break persistedFastPath;

      const range = parseStreamRange(request.headers.get("range"), length);
      if ("error" in range) {
        logStreamRequest({
          infoHash,
          file: filePath,
          range: request.headers.get("range"),
          outcome: "bad_range",
        });
        return new Response(null, {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${length}`,
          },
        });
      }

      const file = {
        name: filePath.split("/").pop() || filePath,
        path: filePath,
        length,
      };
      const headers = responseHeaders(file, range);
      headers.set("X-TorrentFlow-Stream-Source", "disk-fastpath");
      if (request.method === "HEAD") {
        logStreamRequest({
          infoHash,
          file: filePath,
          range: request.headers.get("range"),
          outcome:
            range.status === 206
              ? "partial_head_disk_fastpath"
              : "head_disk_fastpath",
        });
        return new Response(null, { status: range.status, headers });
      }

      const disk = await (deps.openDiskFile ?? openDiskFileByPath)(
        persisted.path,
        persisted.length,
        range,
        {
          expectedMtimeMs: persisted.mtimeMs,
          rootPath: persisted.rootPath,
        },
      );
      if (disk) {
        markForegroundActive(infoHash);
        logStreamRequest({
          infoHash,
          file: filePath,
          range: request.headers.get("range"),
          outcome:
            range.status === 206
              ? "partial_disk_fastpath"
              : "ok_disk_fastpath",
        });
        return new Response(disk.body, { status: range.status, headers });
      }
    }
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
        "This file is not available as completed local media. Switch Settings → Built-in to stream an active torrent.",
      clientType: config.clientType,
    });
  }

  const lookup = await (deps.findFile ?? findLiveBuiltinTorrentFile)(
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

  const stallWindowMs = deps.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  const guardDeps = streamStallGuardDeps(lookup.torrent, stallWindowMs);

  // ── Hybrid disk + engine body ──
  //
  // `openVerifiedDiskStream` above is all-or-nothing PER REQUEST: one missing
  // byte anywhere in the range sends the entire response to the swarm, even the
  // megabytes already verified on the user's own disk. That is the gap this
  // closes — serve the verified prefix from the sparse file at disk speed and
  // only pay swarm latency for the actual holes, inside the SAME response, so
  // `Content-Length`/`Content-Range` stay exactly what was promised.
  //
  // Entered whenever the range's FIRST segment is already on disk. That
  // restriction is deliberate and load-bearing:
  //   - the first byte is then instantaneous, so the `firstChunkOrError`
  //     pre-header stall probe below (which turns a cold start into a 503 JSON
  //     *before* any headers are sent) is not needed and not bypassed;
  //   - a range that starts inside a hole gains nothing from hybrid and falls
  //     through to the untouched pure-engine path.
  // So this can only ever improve a request the engine path would have served,
  // never take over one it handled well.
  //
  // Note there is deliberately NO "must contain a hole" condition. A range that
  // is entirely verified is not necessarily served by `openVerifiedDiskStream`
  // above: that helper additionally requires `stat().size === file.length`, so
  // for a still-GROWING file it refuses even a range whose every byte is
  // present and hash-verified, and the whole request would fall through to the
  // swarm. Hybrid's reader bounds reads by the file's *current* size instead,
  // so an all-disk range of a growing file is exactly the case that must be
  // allowed through here.
  const hybridOn = deps.hybridEnabled ?? hybridStreamEnabled();
  if (hybridOn) {
    const segments = planHybridRange(lookup.torrent, lookup.file, range);
    if (segments[0]?.source === "disk") {
      const releaseLease = (deps.acquireLease ?? acquireBuiltinStreamLease)(
        infoHash,
      );
      let body: ReadableStream<Uint8Array>;
      try {
        body = (deps.openHybridStream ?? openHybridRangeStream)(
          lookup.torrent,
          lookup.file,
          range,
          {
            signal: request.signal,
            openEngine: (start, end) =>
              stallGuardedEngineSegment(
                request,
                lookup.torrent,
                lookup.file,
                guardDeps,
                start,
                end,
              ),
            // The offset handed to the engine is the FILE-RELATIVE start of the
            // hole about to be read, not the request's range start — telling the
            // swarm to seek to bytes we already have would waste the deadline on
            // pieces that are already verified.
            prioritize: (byteOffset: number) =>
              triggerStreamPriority(
                infoHash,
                filePath,
                lookup.torrent,
                lookup.file,
                byteOffset,
                deps.prefetchEdges ?? prefetchBuiltinFileEdges,
                deps.prioritizeFile ?? prioritizeBuiltinStreamFile,
              ),
            onSegment: (segment: HybridSegment) => {
              // One line per source switch is enough to prove in the field that
              // disk segments really are being served from disk.
              if (segment.source === "engine") {
                logStreamRequest({
                  infoHash,
                  file: filePath,
                  range: `bytes=${segment.start}-${segment.end}`,
                  torrent: lookup.torrent,
                  outcome: "hybrid_hole",
                });
              }
            },
          },
        );
      } catch (error) {
        releaseLease();
        throw error;
      }
      markForegroundActive(infoHash);
      headers.set("X-TorrentFlow-Stream-Source", "hybrid");
      logStreamRequest({
        infoHash,
        file: filePath,
        range: request.headers.get("range"),
        torrent: lookup.torrent,
        outcome: range.status === 206 ? "partial_hybrid" : "ok_hybrid",
      });
      return new Response(
        releaseWhenSettled(withForegroundKeepalive(body, infoHash, deps.foregroundClock), releaseLease),
        {
          status: range.status,
          headers,
        },
      );
    }
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

  const releaseLease = acquireBuiltinStreamLease(infoHash);
  // WebTorrent treats `end: 0` as "unset" and selects the whole file at
  // streaming priority. The player probes with `bytes=0-0` on every Play, so
  // without this floor each press would inject a whole-file critical selection
  // into the live download engine. The response body is clamped back to the
  // range we actually promised.
  let source: ReadableStream<Uint8Array>;
  try {
    source = lookup.file.stream({
      start: range.start,
      end: Math.max(range.end, 1),
    });
  } catch (error) {
    releaseLease();
    throw error;
  }
  const reader = source.getReader();
  let first: Awaited<ReturnType<typeof firstChunkOrError>>;
  try {
    first = await firstChunkOrError(
      request,
      lookup.torrent,
      reader,
      guardDeps,
    );
  } catch (error) {
    releaseLease();
    throw error;
  }
  if (!first.ok) {
    releaseLease();
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
    releaseWhenSettled(
      // The pure-engine body needs the same keepalive as hybrid, and needs it
      // MORE: it has no verified prefix to race through, so every byte waits on
      // the swarm and a 128 MiB open-ended read can easily outlive the 20s
      // foreground stamp. Without this the prewarm sweep deselects and parks
      // the torrent mid-body and the response it is serving stalls forever.
      withForegroundKeepalive(
        prependFirstChunkStream(
        request,
        lookup.torrent,
        reader,
        first.first,
        range.end - range.start + 1,
        guardDeps,
        ),
        infoHash,
        deps.foregroundClock,
      ),
      releaseLease,
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
