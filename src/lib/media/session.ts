/**
 * FFmpeg session manager — manages long-lived transcode/remux sessions.
 *
 * Sessions are keyed by infoHash + filePath + audio track + seek offset. Each
 * spawns an ffmpeg process producing fragmented MP4 via HLS into a temp
 * directory under `.sessions/`. Sessions are reference-counted and
 * idle-timeout cleaned.
 *
 * Three things here were learned the hard way and must not be undone:
 *
 * 1. ffmpeg runs with `cwd` set to the session directory and *relative* HLS
 *    filenames. With an absolute `-hls_segment_filename`, ffmpeg still resolves
 *    `-hls_fmp4_init_filename` against the process CWD — so `init.mp4` landed
 *    in the repo root and every fMP4 playback 404'd on its init segment.
 * 2. Streams are mapped explicitly. Without `-map`, ffmpeg's default stream
 *    selection silently keeps one audio track and ignores `-c:a:1`, and the
 *    `-c:a:N` index is output-relative while the plan's index is the ffprobe
 *    one — so a multi-track file got the wrong codec applied to the wrong
 *    stream, with no error at all.
 * 3. `-rw_timeout` does fire on a stalled HTTP source, but ffmpeg still exits
 *    **0** after aborting the demux. Exit code alone therefore cannot tell
 *    "finished" from "the torrent died half way", so there is an explicit
 *    output-progress watchdog and a stderr scan as well.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { PlaybackPlan } from "./decide";
import { resolveFfmpegPath } from "./ff-binaries";

export type SessionState = "starting" | "running" | "stalled" | "error" | "stopped";

export type Session = {
  id: string;
  infoHash: string;
  filePath: string;
  plan: PlaybackPlan;
  state: SessionState;
  /** Seconds into the source this session's output begins at. */
  startSec: number;
  /** Whether ffmpeg's input is the local file or the loopback stream route. */
  source: SessionSourceKind;
  /** ffprobe stream index of the audio track being muxed, if any. */
  audioStreamIndex: number | null;
  /** Absolute path to the HLS output directory */
  outputDir: string;
  /** Absolute path to the HLS media playlist */
  manifestPath: string;
  /** Reference count — how many clients are consuming this session */
  refs: number;
  /** When the last client disconnected */
  lastUnrefAt: number | null;
  /** The ffmpeg process */
  process: ChildProcess | null;
  /** Error message if state is 'error' or 'stalled' */
  error: string | null;
  /** Created timestamp */
  createdAt: number;
  /** ms from spawn to the first segment appearing on disk; null until it does */
  timeToFirstSegmentMs: number | null;
  /** When the current ffmpeg was spawned — the origin for the TTFS measurement. */
  spawnedAt: number;
  /** True once a hardware encoder failure has been retried in software. */
  usedSoftwareFallback: boolean;
};

const sessions = new Map<string, Session>();
const MAX_CONCURRENT_SESSIONS = 4;
const IDLE_TIMEOUT_MS = 120_000; // 2 minutes
const STARTUP_TIMEOUT_MS = 45_000; // time allowed for the first segment
/** No new output for this long while ffmpeg is alive means the source stalled. */
const OUTPUT_STALL_TIMEOUT_MS = 30_000;
export const SEGMENT_SECONDS = 4;

let idleTimer: ReturnType<typeof setInterval> | null = null;

// ── Binary resolution ──

/**
 * Resolve the bundled ffmpeg lazily. Resolving at module load means a pruned or
 * partial install crashes the entire server at import time, taking search,
 * automation and the library down with it — for a feature the user may never
 * touch. Playback alone should fail, and it should say what to run.
 *
 * Re-exported; see ./ff-binaries for why the advertised path cannot be trusted.
 */
export { resolveFfmpegPath } from "./ff-binaries";

// ── Keys and paths ──

/**
 * Which kind of input ffmpeg was given. Part of the session's identity because
 * a session is a *running ffmpeg bound to one input*, and the input can change
 * underneath the same (infoHash, filePath, audio, startSec) tuple: while the
 * torrent is downloading the source is a loopback `/api/stream` URL, and once
 * it completes the plan route switches to the local absolute path. Keying
 * without this reused the swarm-backed ffmpeg forever, so a finished download
 * kept paying for peer latency and the engine could never be parked.
 */
export type SessionSourceKind = "disk" | "swarm";

export function sessionSourceKind(sourceUrl: string): SessionSourceKind {
  return /^https?:\/\//i.test(sourceUrl) ? "swarm" : "disk";
}

function sessionKey(
  infoHash: string,
  filePath: string,
  audioStreamIndex: number | null,
  startSec: number,
  source: SessionSourceKind,
): string {
  return `${infoHash}/${filePath}#a${audioStreamIndex ?? "none"}@${startSec}~${source}`;
}

function newSessionId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function sessionsDir(): string {
  return path.join(process.cwd(), ".sessions");
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── ffmpeg argument construction ──

/**
 * Encoder-specific quality flags. `-crf` is a libx264/libx265 concept; AMF has
 * its own rate control, so emitting CRF for it is at best ignored and at worst
 * rejected. Keeping this in one place stops the two from being mixed.
 */
function videoEncoderArgs(encoder: string): string[] {
  if (encoder.endsWith("_amf")) {
    return ["-quality", "speed", "-rc", "vbr_latency", "-b:v", "6M", "-maxrate", "10M"];
  }
  if (encoder.endsWith("_nvenc")) {
    return ["-preset", "p1", "-rc", "vbr", "-cq", "26"];
  }
  if (encoder.endsWith("_qsv")) {
    return ["-preset", "veryfast", "-global_quality", "26"];
  }
  // libx264 / libx265 — favour latency over compression: this is a live view,
  // not an archive encode, and the owner's constraint is time-to-first-frame.
  return ["-preset", "veryfast", "-crf", "23"];
}

export type FfmpegArgsInput = {
  sourceUrl: string;
  plan: PlaybackPlan;
  /** Seconds into the source to start at. 0 = beginning. */
  startSec?: number;
  /** Force software encoding (used for the hardware-encoder fallback retry). */
  forceSoftware?: boolean;
};

/**
 * Build ffmpeg args for a session. Paths are deliberately relative — ffmpeg is
 * spawned with `cwd` set to the session directory (see the file header).
 */
export function buildFfmpegArgs(input: FfmpegArgsInput): string[] {
  const { sourceUrl, plan } = input;
  const startSec = Math.max(0, Math.floor(input.startSec ?? 0));
  const args: string[] = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-y"];

  const networkSource = /^https?:\/\//i.test(sourceUrl);

  // Network input options — bounded so a cold torrent does not hang ffmpeg
  // forever. These are protocol options, not generic input options: passing
  // them to a proven local file makes Windows FFmpeg reject the input with
  // "Option reconnect not found".
  if (networkSource) {
    args.push("-rw_timeout", "15000000"); // 15s read timeout, in microseconds
  }
  args.push("-analyzeduration", "5000000");
  args.push("-probesize", "10000000");

  // The source is a live torrent behind our own stream route, not a static
  // file, so a read can be cut short: the route bounds an open-ended
  // `bytes=N-` to a sustained delivery window, and a swarm can drop a peer
  // mid-response. Without these, ffmpeg treats the first short read as fatal.
  // Reconnecting re-issues a Range request from the current offset instead.
  // `-reconnect_at_eof` is deliberately NOT set: at a genuine EOF the session
  // is finished, and retrying there would stop it ever completing.
  if (networkSource) {
    args.push("-reconnect", "1");
    args.push("-reconnect_streamed", "1");
    args.push("-reconnect_on_network_error", "1");
    // Bounded backoff, so a source that is truly gone still reaches the stall
    // watchdog rather than retrying forever.
    args.push("-reconnect_delay_max", "5");
  }

  // Input seeking (before -i) is the fast form: ffmpeg jumps via byte-range
  // requests instead of decoding from zero. With stream copy the landing point
  // is the keyframe at or before startSec, so the caller owns the offset math.
  if (startSec > 0) args.push("-ss", String(startSec));

  args.push("-i", sourceUrl);

  // ── Explicit stream mapping ──
  const selectedAudio =
    plan.selectedAudioIndex === null
      ? null
      : plan.audio.find((a) => a.streamIndex === plan.selectedAudioIndex) ?? null;

  if (plan.video) args.push("-map", `0:${plan.video.streamIndex}`);
  if (selectedAudio) args.push("-map", `0:${selectedAudio.streamIndex}`);

  // Video
  if (plan.video) {
    if (plan.video.action === "copy") {
      args.push("-c:v", "copy");
      // ffmpeg's mp4 muxer stamps copied HEVC as `hev1`. Edge decodes both, but
      // `hvc1` is the tag Safari and MediaCapabilities agree on, and retagging a
      // copied stream costs nothing.
      if (plan.video.codec.toLowerCase() === "hevc") args.push("-tag:v", "hvc1");
    } else {
      const software = plan.video.targetCodec === "hevc" ? "libx265" : "libx264";
      const encoder = input.forceSoftware ? software : plan.video.hwAccel ?? software;
      args.push("-c:v", encoder);
      args.push(...videoEncoderArgs(encoder));
      // Segment boundaries have to fall on keyframes, otherwise the HLS muxer
      // emits segments far longer than -hls_time and seeking gets coarse.
      args.push("-g", "60", "-keyint_min", "60", "-sc_threshold", "0");
      args.push("-pix_fmt", "yuv420p");
    }
  } else {
    args.push("-vn");
  }

  // Audio
  if (selectedAudio) {
    if (selectedAudio.action === "copy") {
      args.push("-c:a", "copy");
    } else {
      const target = selectedAudio.targetCodec ?? "aac";
      args.push("-c:a", target);
      // Preserve channel count — NEVER downmix. A 5.1 Dolby track that arrives
      // as stereo is a silent regression the viewer only notices mid-film.
      args.push("-ac", String(selectedAudio.channels));
      const kbpsPerChannel = target === "eac3" ? 96 : 64;
      args.push("-b:a", `${kbpsPerChannel * selectedAudio.channels}k`);
      if (target === "aac" && selectedAudio.channels > 2) {
        // The native AAC encoder refuses >2 channels without this.
        args.push("-strict", "-2");
      }
    }
  } else {
    args.push("-an");
  }

  // Subtitles need their own HLS rendition; dropping them keeps the mux honest.
  args.push("-sn");

  args.push("-f", "hls");
  args.push("-hls_time", String(SEGMENT_SECONDS));
  args.push("-hls_list_size", "0"); // VOD playlist: keep every segment listed
  args.push("-hls_playlist_type", "event"); // grows while encoding, ENDLIST at the end
  args.push("-hls_segment_type", "fmp4");
  args.push("-hls_flags", "independent_segments+temp_file");
  args.push("-hls_segment_filename", "seg%05d.m4s");
  args.push("-hls_fmp4_init_filename", "init.mp4");
  args.push("playlist.m3u8");

  return args;
}

// ── Session lifecycle ──

export type GetOrCreateOptions = {
  /** Seconds into the source to start at. */
  startSec?: number;
};

export type GetOrCreateResult =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Get an existing session or create a new one.
 * Increments the reference count on return.
 */
export function getOrCreateSession(
  infoHash: string,
  filePath: string,
  plan: PlaybackPlan,
  sourceUrl: string,
  options: GetOrCreateOptions = {},
): GetOrCreateResult {
  const startSec = Math.max(0, Math.floor(options.startSec ?? 0));
  const source = sessionSourceKind(sourceUrl);
  const key = sessionKey(infoHash, filePath, plan.selectedAudioIndex, startSec, source);

  const existing = sessions.get(key);
  if (
    existing &&
    existing.state !== "stopped" &&
    existing.state !== "error" &&
    existing.state !== "stalled"
  ) {
    existing.refs += 1;
    existing.lastUnrefAt = null;
    return { ok: true, session: existing };
  }
  if (existing) {
    cleanupSession(existing);
    sessions.delete(key);
  }

  // Seeking to a new offset supersedes the old position for this file: reap the
  // other offsets rather than letting every scrub leak a live ffmpeg.
  for (const [otherKey, other] of sessions) {
    if (other.infoHash === infoHash && other.filePath === filePath && otherKey !== key) {
      cleanupSession(other);
      sessions.delete(otherKey);
    }
  }

  const activeCount = Array.from(sessions.values()).filter(
    (s) => s.state === "starting" || s.state === "running",
  ).length;
  if (activeCount >= MAX_CONCURRENT_SESSIONS) {
    return {
      ok: false,
      error: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`,
    };
  }

  let ffmpegPath: string;
  try {
    ffmpegPath = resolveFfmpegPath();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const id = newSessionId();
  const outputDir = path.join(sessionsDir(), id);
  ensureDir(outputDir);

  const session: Session = {
    id,
    infoHash,
    filePath,
    plan,
    state: "starting",
    startSec,
    source,
    audioStreamIndex: plan.selectedAudioIndex,
    outputDir,
    manifestPath: path.join(outputDir, "playlist.m3u8"),
    refs: 1,
    lastUnrefAt: null,
    process: null,
    error: null,
    createdAt: Date.now(),
    timeToFirstSegmentMs: null,
    spawnedAt: Date.now(),
    usedSoftwareFallback: false,
  };

  sessions.set(key, session);
  startIdleReaper();

  const spawned = spawnFfmpeg(session, ffmpegPath, sourceUrl, plan, startSec, false);
  if (!spawned.ok) {
    sessions.delete(key);
    cleanupSession(session);
    return { ok: false, error: spawned.error };
  }

  return { ok: true, session };
}

type SpawnResult = { ok: true } | { ok: false; error: string };

function spawnFfmpeg(
  session: Session,
  ffmpegPath: string,
  sourceUrl: string,
  plan: PlaybackPlan,
  startSec: number,
  forceSoftware: boolean,
): SpawnResult {
  const args = buildFfmpegArgs({ sourceUrl, plan, startSec, forceSoftware });
  const spawnedAt = Date.now();
  session.spawnedAt = spawnedAt;
  console.info(
    `[playback] session ${session.id} rung=${plan.rung} start=${startSec}s` +
      `${forceSoftware ? " (software fallback)" : ""}`,
  );

  let proc: ChildProcess;
  try {
    proc = spawn(ffmpegPath, args, {
      cwd: session.outputDir,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    session.state = "error";
    session.error = err instanceof Error ? err.message : String(err);
    return { ok: false, error: session.error };
  }

  session.process = proc;
  recordSessionPid(session, proc.pid ?? null);

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  proc.on("error", (err) => {
    if (session.state === "stopped") return;
    session.state = "error";
    session.error = err.message;
    session.process = null;
    console.warn(`[playback] session ${session.id} spawn error: ${err.message}`);
  });

  proc.on("exit", (code) => {
    if (session.state === "stopped") return; // intentional kill
    // The watchdog has already diagnosed this session and killed ffmpeg; the
    // resulting exit is a *consequence*, not new information. Overwriting the
    // diagnosis with "exited with code null" threw away the only message that
    // told the viewer what actually went wrong.
    if (session.state === "stalled") {
      session.process = null;
      return;
    }
    session.process = null;

    const producedOutput = countSegments(session.outputDir) > 0;

    // A hardware encoder that is not present on this machine fails immediately
    // and produces nothing. Retrying in software is the difference between
    // "playback is broken on every non-AMD box" and "playback is a bit slower".
    if (
      !producedOutput &&
      !forceSoftware &&
      plan.video?.action === "transcode" &&
      plan.video.hwAccel
    ) {
      session.usedSoftwareFallback = true;
      console.warn(
        `[playback] session ${session.id} hardware encoder ${plan.video.hwAccel} failed ` +
          `(code ${code}); retrying in software`,
      );
      spawnFfmpeg(session, ffmpegPath, sourceUrl, plan, startSec, true);
      return;
    }

    // `-rw_timeout` aborts the demux but ffmpeg still exits 0, so the exit code
    // alone cannot distinguish a finished file from a torrent that went quiet.
    const abortedRead =
      /Error during demuxing|Error number -138|Connection timed out|Immediate exit requested/i.test(
        stderr,
      );
    if (code === 0 && !abortedRead) {
      session.state = "stopped";
      return;
    }
    if (abortedRead) {
      session.state = "stalled";
      session.error = "The torrent stopped sending data while preparing this stream.";
      console.warn(`[playback] session ${session.id} source stalled: ${stderr.slice(-300)}`);
      return;
    }
    session.state = "error";
    session.error = `ffmpeg exited with code ${code}: ${stderr.slice(-500)}`;
    console.warn(`[playback] session ${session.id} failed: ${session.error}`);
  });

  watchSessionOutput(session, spawnedAt);
  return { ok: true };
}

/** How many .m4s segments exist in a session directory right now. */
function countSegments(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".m4s")).length;
  } catch {
    return 0;
  }
}

/**
 * Record the starting→running transition the first time output appears.
 *
 * Both the watchdog and `waitForSessionFile` observe this event, and whichever
 * sees it first must be the one that timestamps it — the watchdog polls on a
 * coarser interval, so leaving the measurement solely to it reported a
 * time-to-first-segment that was mostly its own tick granularity, or null when
 * a caller read the value between the segment landing and the next tick.
 */
function noteFirstSegment(session: Session) {
  if (session.timeToFirstSegmentMs !== null) return;
  session.timeToFirstSegmentMs = Date.now() - session.spawnedAt;
  if (session.state === "starting") session.state = "running";
  console.info(
    `[playback] session ${session.id} first segment in ${session.timeToFirstSegmentMs}ms`,
  );
}

/**
 * Single watcher covering both startup and mid-stream stalls.
 *
 * The stream route guards every read with a stall timeout because a swarm that
 * dries up otherwise parks forever; the same hazard applies here, one layer up.
 * Output that stops growing while ffmpeg is still alive is the only reliable
 * signal — ffmpeg's own exit code lies (see the file header).
 */
function watchSessionOutput(session: Session, spawnedAt: number) {
  let lastSegmentCount = 0;
  let lastProgressAt = Date.now();

  const timer = setInterval(() => {
    if (
      session.state === "stopped" ||
      session.state === "error" ||
      session.state === "stalled"
    ) {
      clearInterval(timer);
      return;
    }

    const segments = countSegments(session.outputDir);
    if (segments > lastSegmentCount) {
      lastSegmentCount = segments;
      lastProgressAt = Date.now();
      noteFirstSegment(session);
      return;
    }

    // ffmpeg finished writing everything it was going to; nothing left to watch.
    if (!session.process) {
      clearInterval(timer);
      return;
    }

    const idleFor = Date.now() - lastProgressAt;
    const limit = session.state === "starting" ? STARTUP_TIMEOUT_MS : OUTPUT_STALL_TIMEOUT_MS;
    if (idleFor > limit) {
      clearInterval(timer);
      session.state = "stalled";
      session.error =
        session.timeToFirstSegmentMs === null
          ? "Timed out waiting for the first segment — the torrent has no data yet."
          : "The stream stopped producing data — the torrent went quiet.";
      console.warn(`[playback] session ${session.id} watchdog: ${session.error}`);
      killProcess(session);
    }
  }, 500);
  timer.unref?.();
}

/** Decrement reference count. Session is cleaned up by the idle reaper. */
export function unrefSession(sessionId: string): void {
  const session = getSessionById(sessionId);
  if (!session) return;
  session.refs = Math.max(0, session.refs - 1);
  if (session.refs === 0) session.lastUnrefAt = Date.now();
}

/** Force-stop every session for a given file, whatever its offset. */
export function stopSession(infoHash: string, filePath: string): void {
  for (const [key, session] of sessions) {
    if (session.infoHash === infoHash && session.filePath === filePath) {
      cleanupSession(session);
      sessions.delete(key);
    }
  }
}

/** Get session by ID (for serving HLS segments). */
export function getSessionById(id: string): Session | null {
  for (const session of sessions.values()) {
    if (session.id === id) return session;
  }
  return null;
}

/**
 * Wait for a session file to appear, bounded. Segments are written by a live
 * ffmpeg, so "not there yet" is normal and 404 is the wrong answer.
 */
export async function waitForSessionFile(
  session: Session,
  absolutePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const isSegment = absolutePath.endsWith(".m4s") || absolutePath.endsWith(".ts");
  for (;;) {
    if (fs.existsSync(absolutePath)) {
      if (isSegment) noteFirstSegment(session);
      return true;
    }
    if (
      session.state === "error" ||
      session.state === "stalled" ||
      session.state === "stopped"
    ) {
      return fs.existsSync(absolutePath);
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function killProcess(session: Session) {
  const proc = session.process;
  session.process = null;
  if (!proc) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already dead */
  }
}

function cleanupSession(session: Session) {
  session.state = "stopped";
  killProcess(session);
  removeSessionDir(session.outputDir, session.id);
}

/**
 * Remove a session directory, tolerating Windows' post-kill handle lag.
 *
 * SIGKILL returns before the OS has released ffmpeg's open segment files, so a
 * synchronous rmSync immediately afterwards loses the race with EBUSY and
 * leaves the directory (and its segments) on disk until the next startup sweep.
 * Retrying on a short backoff turns that into a non-event; only a directory
 * that is still locked after the last attempt is worth warning about.
 */
function removeSessionDir(dir: string, sessionId: string, attempt = 0): void {
  const RETRY_DELAYS_MS = [50, 250, 1_000];
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(
        () => removeSessionDir(dir, sessionId, attempt + 1),
        RETRY_DELAYS_MS[attempt],
      ).unref();
      return;
    }
    console.warn(`[playback] failed to clean session ${sessionId}: ${err}`);
  }
}

/** Periodic reaper for idle sessions. */
function startIdleReaper() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      const idle =
        session.refs === 0 &&
        session.lastUnrefAt !== null &&
        now - session.lastUnrefAt > IDLE_TIMEOUT_MS;
      if (idle) {
        console.info(`[playback] reaping idle session ${session.id}`);
        cleanupSession(session);
        sessions.delete(key);
      }
    }
    if (sessions.size === 0 && idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }, 15_000);
  idleTimer.unref?.();
}

/** Stop all sessions — for graceful shutdown. */
export function stopAllSessions(): void {
  for (const [key, session] of sessions) {
    cleanupSession(session);
    sessions.delete(key);
  }
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** List active sessions — for debugging / monitoring. */
export function listSessions(): Array<{
  id: string;
  infoHash: string;
  filePath: string;
  rung: string;
  state: SessionState;
  refs: number;
  startSec: number;
  source: SessionSourceKind;
  timeToFirstSegmentMs: number | null;
}> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    infoHash: s.infoHash,
    filePath: s.filePath,
    rung: s.plan.rung,
    state: s.state,
    refs: s.refs,
    startSec: s.startSec,
    source: s.source,
    timeToFirstSegmentMs: s.timeToFirstSegmentMs,
  }));
}

// ── Orphan cleanup ──
//
// Windows does not kill a child when its parent dies, and `next dev` restarts by
// hard-killing the old process. Without this, every restart during a transcode
// leaves an ffmpeg pinning a core forever and a `.sessions/` dir growing without
// bound. Two halves: kill what we can still see (exit hooks), and on the next
// boot kill what we recorded but never got to (pid files).

const PID_FILE = "ffmpeg.pid";

/**
 * Non-session directories that live under `.sessions/` and must survive the
 * orphan sweep. Both are the same kind of gitignored playback scratch, and both
 * are expensive to rebuild: deleting `subtitles` silently re-runs a whole-file
 * demux for every track a viewer re-selects after a restart, and deleting `vod`
 * throws away a completed conversion of an entire film. `vod-runtime.ts` owns
 * its own eviction, which is bounded by size rather than by process lifetime.
 */
const RESERVED_SESSION_DIR_NAMES = new Set(["subtitles", "vod"]);

function recordSessionPid(session: Session, pid: number | null) {
  if (!pid) return;
  try {
    fs.writeFileSync(
      path.join(session.outputDir, PID_FILE),
      JSON.stringify({ pid, startedAt: Date.now() }),
      "utf8",
    );
  } catch {
    /* best effort — cleanup is a safety net, not a correctness requirement */
  }
}

function processIsOurFfmpeg(pid: number): Promise<boolean> {
  // A recorded pid may have been recycled by the OS since the crash, so the
  // image name is checked before anything is killed.
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("ps", ["-p", String(pid), "-o", "comm="], (err, stdout) => {
        resolve(!err && /ffmpeg/i.test(stdout));
      });
      return;
    }
    execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], (err, stdout) =>
      resolve(!err && /^"ffmpeg\.exe"/i.test(stdout.trim())),
    );
  });
}

/**
 * Remove `.sessions/` directories left by a previous process, killing any ffmpeg
 * still running from them. Safe to call repeatedly.
 */
export async function cleanupStaleSessionDirs(): Promise<{ dirs: number; killed: number }> {
  const root = sessionsDir();
  let dirs = 0;
  let killed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { dirs: 0, killed: 0 };
  }

  const live = new Set(Array.from(sessions.values()).map((s) => s.id));
  for (const entry of entries) {
    if (live.has(entry)) continue;
    if (RESERVED_SESSION_DIR_NAMES.has(entry)) continue;
    const dir = path.join(root, entry);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const pidFile = path.join(dir, PID_FILE);
    if (fs.existsSync(pidFile)) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid?: number };
        if (typeof pid === "number" && pid > 0 && (await processIsOurFfmpeg(pid))) {
          process.kill(pid, "SIGKILL");
          killed += 1;
          console.warn(`[playback] killed orphaned ffmpeg pid ${pid} from a previous run`);
        }
      } catch {
        /* pid gone or unreadable — nothing to kill */
      }
    }

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      dirs += 1;
    } catch {
      /* a still-open handle; the next boot will get it */
    }
  }
  if (dirs > 0) console.info(`[playback] cleaned ${dirs} stale session dir(s)`);
  return { dirs, killed };
}

let exitHooksInstalled = false;

/**
 * Install process-exit hooks that kill live ffmpeg children, and sweep stale
 * dirs from a previous run. Idempotent; called from the playback routes so it
 * runs once the feature is actually used.
 */
export function installSessionCleanup(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  const killAll = () => {
    for (const session of sessions.values()) {
      const proc = session.process;
      if (!proc?.pid) continue;
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(signal, () => {
      killAll();
      stopAllSessions();
      process.exit(0);
    });
  }

  void cleanupStaleSessionDirs();
}
