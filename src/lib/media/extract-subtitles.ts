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

import { resolveFfmpegPath } from "./ff-binaries";
import { sessionsDir } from "./session";
import { isWebVtt, srtToVtt } from "./subtitles";

/** A cue file bigger than this is not a subtitle track; it is a mistake. */
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;

/**
 * A whole-file demux over a torrent is slow. Bounded anyway: a request that
 * never ends is worse than an honest "this took too long, try again".
 */
export const EXTRACT_TIMEOUT_MS = 5 * 60_000;

export type ExtractOutcome =
  | { ok: true; vtt: string; cached: boolean }
  | { ok: false; error: "timeout" | "failed" | "empty"; message: string };

/**
 * Cache root. Deliberately inside `.sessions/` — it is already gitignored and
 * already the place playback scratch lives. `cleanupStaleSessionDirs` skips
 * this name explicitly; see the guard there.
 */
export function subtitleCacheDir(): string {
  return path.join(sessionsDir(), "subtitles");
}

function cacheFile(infoHash: string, filePath: string, trackId: string): string {
  const key = crypto
    .createHash("sha1")
    .update(`${infoHash}\u0000${filePath}\u0000${trackId}`)
    .digest("hex");
  return path.join(subtitleCacheDir(), `${key}.vtt`);
}

function readCache(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function writeCache(file: string, vtt: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, vtt, "utf8");
  } catch {
    /* a cache that cannot be written is slow, not broken */
  }
}

/** In-flight extractions, keyed by cache file, so duplicates share one ffmpeg. */
const inFlight = new Map<string, Promise<ExtractOutcome>>();

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
export function buildSubtitleExtractArgs(sourceUrl: string, streamIndex: number): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    ...subtitleInputArgs(),
    "-i", sourceUrl,
    // Explicit map, for the same reason session.ts maps explicitly: default
    // stream selection would pick one subtitle track of its own choosing and
    // silently ignore which one was asked for.
    "-map", `0:${streamIndex}`,
    "-c:s", "webvtt",
    "-f", "webvtt",
    "-",
  ];
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<ExtractOutcome> {
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
      resolve(outcome);
    };

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
  timeoutMs?: number;
}): Promise<ExtractOutcome> {
  const trackId = `embedded:${input.streamIndex}`;
  const file = cacheFile(input.infoHash, input.filePath, trackId);
  const cached = readCache(file);
  if (cached) return { ok: true, vtt: cached, cached: true };

  const existing = inFlight.get(file);
  if (existing) return existing;

  const work = runFfmpeg(
    buildSubtitleExtractArgs(input.sourceUrl, input.streamIndex),
    input.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  ).then((outcome) => {
    if (outcome.ok) writeCache(file, outcome.vtt);
    inFlight.delete(file);
    return outcome;
  });
  inFlight.set(file, work);
  return work;
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
): string | null {
  return readCache(cacheFile(infoHash, filePath, trackId));
}

/** Test seam — the in-flight map would otherwise leak between cases. */
export function resetSubtitleExtractionForTests(): void {
  inFlight.clear();
}
