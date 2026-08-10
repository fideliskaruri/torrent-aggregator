/**
 * Turning a subtitle source into WebVTT the browser will actually render.
 *
 * Three hard constraints shaped this:
 *
 * 1. **Nothing is extracted until a viewer asks for it.** An embedded subtitle
 *    stream is interleaved through the whole container, so pulling it means
 *    demuxing the entire file — over a torrent that is bytes the player is
 *    competing for. Listing tracks is free (the probe already ran); *selecting*
 *    one is the moment the cost is paid, and only then.
 * 2. **The result is cached on disk**, so switching away and back, or a page
 *    reload, never pays it twice.
 * 3. **Concurrent requests for the same track share one ffmpeg.** Two `<track>`
 *    loads racing (React strict mode does exactly this) would otherwise spawn
 *    two whole-file demuxes.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { formatBytesShort } from "@/lib/library/disk-space";
import { resolveFfmpegPath } from "./ff-binaries";
import { sessionsDir } from "./session";
import {
  isWebVtt,
  srtToVtt,
  SUBTITLE_WINDOW_DURATION_SECONDS,
} from "./subtitles";

/** A cue file bigger than this is not a subtitle track; it is a mistake. */
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;

/**
 * A whole-file demux over a torrent is slow. Bounded anyway: a request that
 * never ends is worse than an honest "this took too long, try again".
 */
export const EXTRACT_TIMEOUT_MS = 45_000;
export const PREFETCH_EXTRACT_TIMEOUT_MS = 15_000;

/** Subtitle conversions are derived cache entries, not user downloads. */
export const SUBTITLE_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export type ExtractOutcome =
  | { ok: true; vtt: string; cached: boolean }
  | {
      ok: false;
      error: "timeout" | "failed" | "empty" | "aborted";
      message: string;
    };

/**
 * Cache root. Deliberately inside `.sessions/` — it is already gitignored and
 * already the place playback scratch lives. `cleanupStaleSessionDirs` skips
 * this name explicitly; see the guard there.
 */
export function subtitleCacheDir(): string {
  return path.join(sessionsDir(), "subtitles");
}

function cacheFile(
  infoHash: string,
  filePath: string,
  trackId: string,
  windowStartSec = 0,
): string {
  const key = crypto
    .createHash("sha1")
    .update(`${infoHash}\u0000${filePath}\u0000${trackId}\u0000${windowStartSec}`)
    .digest("hex");
  return path.join(subtitleCacheDir(), `${key}.vtt`);
}

function readCache(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.trim().length === 0) return null;
    touchCache(file);
    return text;
  } catch {
    return null;
  }
}

function writeCache(file: string, vtt: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, vtt, "utf8");
    touchCache(file);
    evictSubtitleCacheOverBudget();
  } catch {
    /* a cache that cannot be written is slow, not broken */
  }
}

function touchCache(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* best-effort LRU timestamp */
  }
}

/**
 * LRU eviction for subtitle conversions.
 *
 * This mirrors the repo's cache vocabulary: derived entries only, oldest
 * `lastUsedAt` first, and protected work in flight is never touched.
 */
export function evictSubtitleCacheOverBudget(
  budgetBytes: number = SUBTITLE_CACHE_BUDGET_BYTES,
): number {
  const root = subtitleCacheDir();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }

  const protectedFiles = new Set(inFlight.keys());
  const candidates = names
    .filter((name) => name.endsWith(".vtt"))
    .map((name) => {
      const file = path.join(root, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return null;
        return { file, size: stat.size, used: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((c): c is { file: string; size: number; used: number } => c !== null);

  let total = candidates.reduce((sum, c) => sum + c.size, 0);
  if (total <= budgetBytes) return 0;

  candidates.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const candidate of candidates) {
    if (total <= budgetBytes) break;
    if (protectedFiles.has(candidate.file)) continue;
    try {
      fs.rmSync(candidate.file, { force: true });
      total -= candidate.size;
      removed += 1;
      console.info(
        `[subtitles] evicted ${path.basename(candidate.file)} (${formatBytesShort(candidate.size)})`,
      );
    } catch {
      /* locked on Windows; the next write will try again */
    }
  }
  return removed;
}

/** In-flight extractions, keyed by cache file, so duplicates share one ffmpeg. */
type InFlightExtraction = {
  controller: AbortController;
  promise: Promise<ExtractOutcome>;
  consumers: Map<string, Map<symbol, () => void>>;
  settled: boolean;
};

const inFlight = new Map<string, InFlightExtraction>();
const MAX_CONCURRENT_SUBTITLE_JOBS = 2;
const MAX_QUEUED_SUBTITLE_JOBS = 16;
let activeSubtitleJobs = 0;
const queuedSubtitleJobs: Array<{
  start: () => void;
  signal?: AbortSignal;
  priority: "foreground" | "prefetch";
}> = [];

/**
 * ffmpeg input flags for a torrent-backed HTTP source.
 *
 * Same reasoning as `buildFfmpegArgs`: the stream route caps an open-ended
 * range at 8 MiB and a swarm drops peers, so a read *will* be cut short and
 * ffmpeg must reconnect from the current offset instead of treating the short
 * read as a fatal EOF. `-reconnect_at_eof` is deliberately NOT set — at a real
 * EOF the extraction is finished, and retrying there would never terminate.
 */
export function subtitleInputArgs(): string[] {
  return [
    "-rw_timeout", "15000000",
    "-analyzeduration", "5000000",
    "-probesize", "10000000",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
  ];
}

/** The full argv for pulling one embedded subtitle stream out as WebVTT. */
export function buildSubtitleExtractArgs(
  sourceUrl: string,
  streamIndex: number,
  windowStartSec = 0,
): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...subtitleInputArgs(),
    ...(windowStartSec > 0 ? ["-ss", String(windowStartSec)] : []),
    "-i", sourceUrl,
    "-t", String(SUBTITLE_WINDOW_DURATION_SECONDS),
    // Explicit map, for the same reason session.ts maps explicitly: default
    // stream selection would pick one subtitle track of its own choosing and
    // silently ignore which one was asked for.
    "-map", `0:${streamIndex}`,
    "-c:s", "webvtt",
    "-f", "webvtt",
    "-",
  ];
}

function runFfmpegNow(
  args: string[],
  timeoutMs: number,
  allowEmpty: boolean,
  signal?: AbortSignal,
): Promise<ExtractOutcome> {
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      error: "aborted",
      message: "subtitle extraction was canceled",
    });
  }
  let ffmpeg: string;
  try {
    ffmpeg = resolveFfmpegPath();
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return new Promise<ExtractOutcome>((resolve) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;

    const finish = (outcome: ExtractOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(outcome);
    };

    const abort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({
        ok: false,
        error: "aborted",
        message: "subtitle extraction was canceled",
      });
    };
    signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({
        ok: false,
        error: "timeout",
        message: `subtitle extraction exceeded ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SUBTITLE_BYTES) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: "failed", message: "subtitle stream exceeded the size cap" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on("error", (err) => finish({ ok: false, error: "failed", message: err.message }));
    child.on("close", (code) => {
      const vtt = Buffer.concat(chunks).toString("utf8");
      // A WebVTT file with no cues is just the header. ffmpeg exits 0 for it, so
      // the exit code cannot tell "extracted" from "there was nothing there" —
      // the same lesson as the session watchdog, one layer down.
      const hasCues = /-->/.test(vtt);
      if (code === 0 && hasCues) {
        finish({ ok: true, vtt, cached: false });
        return;
      }
      if (code === 0 && allowEmpty) {
        finish({ ok: true, vtt: vtt.trim() ? vtt : "WEBVTT\n\n", cached: false });
        return;
      }
      if (code === 0) {
        finish({
          ok: false,
          error: "empty",
          message: "the track produced no cues",
        });
        return;
      }
      finish({
        ok: false,
        error: "failed",
        message: stderr.trim().split("\n").slice(-2).join(" | ") || `ffmpeg exited with ${code}`,
      });
    });
  });
}

function releaseSubtitleJob(): void {
  activeSubtitleJobs = Math.max(0, activeSubtitleJobs - 1);
  for (;;) {
    const next = queuedSubtitleJobs.shift();
    if (!next) return;
    if (next.signal?.aborted) continue;
    next.start();
    return;
  }
}

function runFfmpeg(
  args: string[],
  timeoutMs: number,
  allowEmpty = false,
  signal?: AbortSignal,
  priority: "foreground" | "prefetch" = "foreground",
): Promise<ExtractOutcome> {
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      error: "aborted",
      message: "subtitle extraction was canceled",
    });
  }
  if (
    activeSubtitleJobs >= MAX_CONCURRENT_SUBTITLE_JOBS &&
    queuedSubtitleJobs.length >= MAX_QUEUED_SUBTITLE_JOBS
  ) {
    return Promise.resolve({
      ok: false,
      error: "failed",
      message: "subtitle extraction queue is full",
    });
  }

  return new Promise<ExtractOutcome>((resolve) => {
    let queued = false;
    const abortQueued = () => {
      if (!queued) return;
      const index = queuedSubtitleJobs.findIndex((job) => job.start === start);
      if (index >= 0) queuedSubtitleJobs.splice(index, 1);
      queued = false;
      resolve({
        ok: false,
        error: "aborted",
        message: "subtitle extraction was canceled",
      });
    };
    const start = () => {
      queued = false;
      signal?.removeEventListener("abort", abortQueued);
      activeSubtitleJobs += 1;
      void runFfmpegNow(args, timeoutMs, allowEmpty, signal)
        .then(resolve)
        .finally(releaseSubtitleJob);
    };
    if (activeSubtitleJobs < MAX_CONCURRENT_SUBTITLE_JOBS) start();
    else {
      queued = true;
      const job = { start, signal, priority };
      const firstPrefetch = queuedSubtitleJobs.findIndex(
        (queuedJob) => queuedJob.priority === "prefetch",
      );
      if (priority === "foreground" && firstPrefetch >= 0) {
        queuedSubtitleJobs.splice(firstPrefetch, 0, job);
      } else {
        queuedSubtitleJobs.push(job);
      }
      signal?.addEventListener("abort", abortQueued, { once: true });
    }
  });
}

function consumeExtraction(
  entry: InFlightExtraction,
  signal?: AbortSignal,
  consumerId = "anonymous",
): Promise<ExtractOutcome> {
  const consumer = Symbol(consumerId);
  const bucket = entry.consumers.get(consumerId) ?? new Map();
  entry.consumers.set(consumerId, bucket);

  return new Promise<ExtractOutcome>((resolve) => {
    let finished = false;
    const release = () => {
      bucket.delete(consumer);
      if (bucket.size === 0) entry.consumers.delete(consumerId);
      if (!entry.settled && entry.consumers.size === 0) {
        entry.controller.abort();
      }
    };
    const settle = (outcome: ExtractOutcome) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      release();
      resolve(outcome);
    };
    const abort = () =>
      settle({
        ok: false,
        error: "aborted",
        message: "subtitle extraction was canceled",
      });
    bucket.set(consumer, abort);

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    void entry.promise.then(settle);
  });
}

/**
 * Extract one embedded subtitle stream as WebVTT, cached on disk.
 *
 * `sourceUrl` is the app's own stream endpoint, exactly as probe and session
 * use it, so the bytes come through the torrent engine's range support.
 */
export async function extractEmbeddedSubtitle(input: {
  infoHash: string;
  filePath: string;
  streamIndex: number;
  sourceUrl: string;
  windowStartSec?: number;
  signal?: AbortSignal;
  consumerId?: string;
  priority?: "foreground" | "prefetch";
  timeoutMs?: number;
}): Promise<ExtractOutcome> {
  if (input.signal?.aborted) {
    return {
      ok: false,
      error: "aborted",
      message: "subtitle extraction was canceled",
    };
  }
  const trackId = `embedded:${input.streamIndex}`;
  const windowStartSec = Math.max(0, input.windowStartSec ?? 0);
  const file = cacheFile(input.infoHash, input.filePath, trackId, windowStartSec);
  const cached = readCache(file);
  if (cached) return { ok: true, vtt: cached, cached: true };

  const existing = inFlight.get(file);
  if (existing) {
    return consumeExtraction(existing, input.signal, input.consumerId);
  }

  const controller = new AbortController();
  const work = runFfmpeg(
    buildSubtitleExtractArgs(input.sourceUrl, input.streamIndex, windowStartSec),
    input.timeoutMs ?? EXTRACT_TIMEOUT_MS,
    true,
    controller.signal,
    input.priority,
  ).then((outcome) => {
    if (outcome.ok) writeCache(file, outcome.vtt);
    const entry = inFlight.get(file);
    if (entry) entry.settled = true;
    inFlight.delete(file);
    return outcome;
  });
  const entry: InFlightExtraction = {
    controller,
    promise: work,
    consumers: new Map(),
    settled: false,
  };
  inFlight.set(file, entry);
  return consumeExtraction(entry, input.signal, input.consumerId);
}

export function cancelEmbeddedSubtitle(input: {
  infoHash: string;
  filePath: string;
  streamIndex: number;
  windowStartSec?: number;
  consumerId: string;
}): boolean {
  const file = cacheFile(
    input.infoHash,
    input.filePath,
    `embedded:${input.streamIndex}`,
    Math.max(0, input.windowStartSec ?? 0),
  );
  const entry = inFlight.get(file);
  const consumers = entry?.consumers.get(input.consumerId);
  if (!consumers?.size) return false;
  for (const cancel of [...consumers.values()]) cancel();
  return true;
}

/**
 * Convert sidecar subtitle bytes to WebVTT.
 *
 * `.vtt` passes through, `.srt` is pure text surgery, and `.ass`/`.ssa` go
 * through ffmpeg (their styling model has no VTT equivalent, but the dialogue —
 * the part a viewer needs — converts fine).
 */
export async function convertSidecarSubtitle(input: {
  bytes: Uint8Array;
  extension: string;
  timeoutMs?: number;
}): Promise<ExtractOutcome> {
  const ext = input.extension.replace(/^\./, "").toLowerCase();
  const text = new TextDecoder("utf-8").decode(input.bytes);
  if (ext === "vtt" || isWebVtt(text)) {
    return { ok: true, vtt: text, cached: false };
  }
  if (ext === "srt") {
    return { ok: true, vtt: srtToVtt(text), cached: false };
  }
  if (ext !== "ass" && ext !== "ssa") {
    return { ok: false, error: "failed", message: `unsupported sidecar type .${ext}` };
  }

  // ffmpeg cannot read ASS from a pipe without being told the format, and the
  // file is small enough that a temp file inside the cache dir is simpler and
  // more reliable than juggling stdin backpressure.
  const dir = subtitleCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const scratch = path.join(dir, `in-${crypto.randomBytes(6).toString("hex")}.${ext}`);
  try {
    fs.writeFileSync(scratch, input.bytes);
    return await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-f", ext,
        "-i", scratch,
        "-c:s", "webvtt",
        "-f", "webvtt",
        "-",
      ],
      input.timeoutMs ?? 30_000,
    );
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

/** Cache a converted sidecar so a re-select does not re-read the torrent. */
export function cacheSidecarVtt(
  infoHash: string,
  filePath: string,
  trackId: string,
  vtt: string,
): void {
  writeCache(cacheFile(infoHash, filePath, trackId), vtt);
}

/** Read a cached sidecar conversion, if there is one. */
export function readCachedSubtitle(
  infoHash: string,
  filePath: string,
  trackId: string,
  windowStartSec = 0,
): string | null {
  return readCache(cacheFile(infoHash, filePath, trackId, windowStartSec));
}

/** Test seam — the in-flight map would otherwise leak between cases. */
export function resetSubtitleExtractionForTests(): void {
  for (const entry of inFlight.values()) entry.controller.abort();
  inFlight.clear();
  queuedSubtitleJobs.length = 0;
  activeSubtitleJobs = 0;
}
