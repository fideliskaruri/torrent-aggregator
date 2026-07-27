/**
 * Runtime for the complete-file playback strategies.
 *
 * `vod.ts` holds the decisions and the arithmetic; this holds the disk, the
 * processes and the lifetimes. Two strategies live here:
 *
 *   - **whole-file** — one ffmpeg pass over a completed file producing a
 *     finished VOD playlist plus a single `data.m4s`. Runs in the background;
 *     until it finishes the caller keeps using the existing session path, so a
 *     viewer never waits on it.
 *   - **vod-segments** — the playlist is written immediately from the cached
 *     probe duration with no encode at all, and each segment is produced by a
 *     short-lived ffmpeg the first time it is asked for.
 *
 * ## Why entries are persisted to disk
 *
 * `next dev` restarts on every edit and the process memory goes with it. A
 * conversion that took ninety seconds must not be thrown away because a
 * component re-rendered, so each entry writes a `meta.json` and a `ready.json`
 * marker, and an entry is rebuilt from those on demand. That also makes the id
 * in the URL meaningful across restarts, which the session path's ids are not.
 *
 * ## Why the cache lives under `.sessions/`
 *
 * It is the same class of gitignored playback scratch, it is covered by the
 * same startup sweep, and keeping it there means there is exactly one directory
 * to reason about when something has to be deleted by hand. `session.ts`
 * reserves the name so its orphan sweep does not delete it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveFfmpegPath, resolveFfprobePath } from "./ff-binaries";
import type { PlaybackPlan } from "./decide";
import { sessionsDir } from "./session";
import {
  buildKeyframeProbeArgs,
  buildVodPlaylist,
  buildVodSegmentArgs,
  buildWholeFileHlsArgs,
  fixedGridSegments,
  keyframeAlignedSegments,
  parseKeyframeTimes,
  splitFragmentedMp4,
  VOD_SEGMENT_SECONDS,
  WHOLE_FILE_DATA,
  WHOLE_FILE_PLAYLIST,
  type VodSegment,
  type VodStrategy,
} from "./vod";

/** Directory name under `.sessions/`. Reserved by the session orphan sweep. */
export const VOD_DIR_NAME = "vod";

/** How much converted media may sit on disk before the oldest is evicted. */
const CACHE_BUDGET_BYTES = 40 * 1024 * 1024 * 1024;

/** Whole-file conversions are disk-bound; more than one at a time is slower. */
const MAX_CONCURRENT_CONVERSIONS = 1;

/** A scrub asks for several segments at once; a few in parallel, not all. */
const MAX_CONCURRENT_SEGMENTS = 3;

/** A single 4-second segment that takes this long has failed, not stalled. */
const SEGMENT_TIMEOUT_MS = 60_000;

const META_FILE = "meta.json";
const READY_FILE = "ready.json";
const INIT_FILE = "init.mp4";
const KEYFRAMES_FILE = "keyframes.json";

/**
 * A keyframe index read is bounded: a container with a broken index can make
 * ffprobe walk every packet of a 20 GB file. Past this the fixed grid is used.
 */
const KEYFRAME_PROBE_TIMEOUT_MS = 180_000;

export type VodEntryStatus = "preparing" | "ready" | "error";

export type VodEntry = {
  id: string;
  strategy: Exclude<VodStrategy, "session">;
  infoHash: string;
  filePath: string;
  audioStreamIndex: number | null;
  /** Absolute path of the completed source on local disk. */
  sourcePath: string;
  duration: number;
  plan: PlaybackPlan;
  dir: string;
  /** Only populated for `vod-segments`. */
  segments: VodSegment[];
  status: VodEntryStatus;
  error: string | null;
  createdAt: number;
  readyAt: number | null;
  lastUsedAt: number;
};

type PersistedMeta = Omit<VodEntry, "dir" | "status" | "error" | "readyAt" | "lastUsedAt">;

const entries = new Map<string, VodEntry>();
const liveProcesses = new Set<ChildProcess>();
const segmentJobs = new Map<string, Promise<SegmentResult>>();
const keyframeProbes = new Set<string>();
let runningConversions = 0;
let runningSegments = 0;
let exitHooksInstalled = false;

export function vodCacheDir(): string {
  return path.join(sessionsDir(), VOD_DIR_NAME);
}

/**
 * Stable id for a (file, audio track, plan shape) triple.
 *
 * The audio index is part of the key because switching language produces
 * genuinely different media — and the rung is in there because a client whose
 * codec support differs needs a different conversion of the same file.
 */
export function vodId(input: {
  infoHash: string;
  filePath: string;
  audioStreamIndex: number | null;
  rung: string;
}): string {
  const material = `${input.infoHash}|${input.filePath}|a${input.audioStreamIndex ?? "none"}|${input.rung}`;
  return crypto.createHash("sha1").update(material).digest("hex").slice(0, 20);
}

// ── Process lifetime ──

/**
 * Windows does not kill children when the parent dies, so a `next dev` restart
 * mid-conversion would otherwise leave an ffmpeg copying a 20 GB file forever.
 */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const stop = () => stopAllVodJobs();
  process.once("exit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("beforeExit", stop);
}

export function stopAllVodJobs(): void {
  for (const proc of liveProcesses) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  liveProcesses.clear();
}

// ── Persistence ──

function metaPath(dir: string): string {
  return path.join(dir, META_FILE);
}

function writeMeta(entry: VodEntry): void {
  const meta: PersistedMeta = {
    id: entry.id,
    strategy: entry.strategy,
    infoHash: entry.infoHash,
    filePath: entry.filePath,
    audioStreamIndex: entry.audioStreamIndex,
    sourcePath: entry.sourcePath,
    duration: entry.duration,
    plan: entry.plan,
    segments: entry.segments,
    createdAt: entry.createdAt,
  };
  try {
    fs.writeFileSync(metaPath(entry.dir), JSON.stringify(meta), "utf8");
  } catch (err) {
    console.warn(`[vod] could not persist ${entry.id}: ${err}`);
  }
}

function readMeta(dir: string): PersistedMeta | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metaPath(dir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const meta = parsed as Partial<PersistedMeta>;
    if (
      typeof meta.id !== "string" ||
      typeof meta.sourcePath !== "string" ||
      typeof meta.duration !== "number" ||
      !meta.plan ||
      (meta.strategy !== "whole-file" && meta.strategy !== "vod-segments")
    ) {
      return null;
    }
    return {
      id: meta.id,
      strategy: meta.strategy,
      infoHash: typeof meta.infoHash === "string" ? meta.infoHash : "",
      filePath: typeof meta.filePath === "string" ? meta.filePath : "",
      audioStreamIndex:
        typeof meta.audioStreamIndex === "number" ? meta.audioStreamIndex : null,
      sourcePath: meta.sourcePath,
      duration: meta.duration,
      plan: meta.plan,
      segments: Array.isArray(meta.segments) ? meta.segments : [],
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function markReady(entry: VodEntry): void {
  entry.status = "ready";
  entry.readyAt = Date.now();
  try {
    fs.writeFileSync(
      path.join(entry.dir, READY_FILE),
      JSON.stringify({ readyAt: entry.readyAt }),
      "utf8",
    );
  } catch {
    /* the marker is an optimisation; the entry is usable either way */
  }
}

function isReadyOnDisk(dir: string): boolean {
  return fs.existsSync(path.join(dir, READY_FILE));
}

// ── Keyframe index ──

function keyframesPath(dir: string): string {
  return path.join(dir, KEYFRAMES_FILE);
}

/**
 * The cached keyframe index for this source, if it has already been read.
 *
 * Reading it costs a full pass over the container's packet index, so it is
 * written once and reused across `next dev` restarts — the positions of a
 * completed file's keyframes cannot change.
 */
export function readKeyframeIndex(dir: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(keyframesPath(dir), "utf8"));
    if (!Array.isArray(parsed)) return null;
    const times = parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    return times.length > 0 ? times : null;
  } catch {
    return null;
  }
}

function writeKeyframeIndex(dir: string, times: number[]): void {
  try {
    fs.writeFileSync(keyframesPath(dir), JSON.stringify(times), "utf8");
  } catch (err) {
    console.warn(`[vod] could not cache keyframe index: ${err}`);
  }
}

/**
 * Fix this entry's segment boundaries and publish its playlist.
 *
 * `keyframeAlignedSegments` puts every boundary on a real source keyframe, so
 * the `-ss` that produces a segment lands exactly where the playlist says it
 * does. Without that, ffmpeg's input seek on Matroska snaps to the keyframe
 * *before* the requested time (measured: `-ss 12` → first packet at 10.000),
 * and every segment would carry a GOP of media the playlist never accounted
 * for. An empty index means the probe failed, and the even grid is the honest
 * fallback: this strategy only ever re-encodes, and a re-encode forces a
 * keyframe onto each boundary itself.
 */
function applySegments(entry: VodEntry, keyframeTimes: number[] | null): void {
  entry.segments =
    keyframeTimes && keyframeTimes.length > 0
      ? keyframeAlignedSegments(keyframeTimes, entry.duration)
      : fixedGridSegments(entry.duration);
  writeMeta(entry);
  writePlaylist(entry);
  markReady(entry);
}

/**
 * Read the source's keyframe positions in the background, then publish.
 *
 * The entry stays `preparing` until this finishes, which is deliberate: the
 * plan route keeps the viewer on the session path while it runs, so nobody
 * waits on a spinner, and the next plan request picks up the finished VOD
 * playlist.
 */
function startKeyframeProbe(entry: VodEntry): void {
  if (keyframeProbes.has(entry.id)) return;

  let ffprobePath: string;
  try {
    ffprobePath = resolveFfprobePath();
  } catch (err) {
    console.warn(`[vod] no ffprobe (${err}); falling back to the fixed grid`);
    applySegments(entry, null);
    return;
  }

  keyframeProbes.add(entry.id);
  const startedAt = Date.now();
  let proc: ChildProcess;
  try {
    proc = spawn(ffprobePath, buildKeyframeProbeArgs(entry.sourcePath), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    keyframeProbes.delete(entry.id);
    console.warn(`[vod] keyframe probe could not start (${err}); using the fixed grid`);
    applySegments(entry, null);
    return;
  }

  liveProcesses.add(proc);
  let csv = "";
  let settled = false;
  proc.stdout?.on("data", (chunk: Buffer) => {
    csv += chunk.toString();
  });
  proc.stderr?.on("data", () => {
    /* ffprobe chatters about unknown packets; the exit code is the verdict */
  });

  const finish = (times: number[] | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    liveProcesses.delete(proc);
    keyframeProbes.delete(entry.id);
    if (times && times.length > 0) writeKeyframeIndex(entry.dir, times);
    applySegments(entry, times);
    console.info(
      `[vod] ${entry.id} keyframe index: ${times?.length ?? 0} keys in ${Date.now() - startedAt}ms` +
        ` → ${entry.segments.length} segments`,
    );
  };

  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    finish(null);
  }, KEYFRAME_PROBE_TIMEOUT_MS);
  timer.unref?.();

  proc.on("error", () => finish(null));
  proc.on("close", (code) => finish(code === 0 ? parseKeyframeTimes(csv) : null));
}

// ── Entry lifecycle ──

export type PrepareInput = {
  strategy: Exclude<VodStrategy, "session">;
  infoHash: string;
  filePath: string;
  audioStreamIndex: number | null;
  sourcePath: string;
  duration: number;
  plan: PlaybackPlan;
};

/**
 * Get or create the entry for a file, starting whatever work it needs.
 *
 * Idempotent and cheap to call on every plan request: a ready entry is returned
 * as-is, a running conversion is not restarted, and an interrupted one is
 * picked up again.
 */
export function prepareVod(input: PrepareInput): VodEntry {
  installExitHooks();
  const id = vodId({
    infoHash: input.infoHash,
    filePath: input.filePath,
    audioStreamIndex: input.audioStreamIndex,
    rung: input.plan.rung,
  });

  const existing = entries.get(id);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (existing.status === "error") restart(existing);
    return existing;
  }

  // A previous process may have finished (or half-finished) this exact
  // conversion. Rebuilding from `meta.json` keeps the keyframe index and the
  // segment boundaries that were already paid for, instead of throwing them
  // away because `next dev` restarted.
  const rebuilt = getVodEntry(id);
  if (rebuilt) return rebuilt;

  const dir = path.join(vodCacheDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  const entry: VodEntry = {
    id,
    strategy: input.strategy,
    infoHash: input.infoHash,
    filePath: input.filePath,
    audioStreamIndex: input.audioStreamIndex,
    sourcePath: input.sourcePath,
    duration: input.duration,
    plan: input.plan,
    dir,
    // Boundaries are not arithmetic until the source's keyframes are known;
    // `restart` fills them in.
    segments: [],
    status: "preparing",
    error: null,
    createdAt: Date.now(),
    readyAt: null,
    lastUsedAt: Date.now(),
  };
  entries.set(id, entry);
  writeMeta(entry);

  restart(entry);
  evictOverBudget();
  return entry;
}

function restart(entry: VodEntry): void {
  entry.error = null;
  entry.status = "preparing";
  if (entry.strategy === "whole-file") {
    startWholeFileConversion(entry);
    return;
  }
  // vod-segments needs no encode up front: the playlist is arithmetic and the
  // segments are made when they are asked for. It does need to know where the
  // source's keyframes are, because a boundary that is not one cannot be cut
  // to accurately — so read the index once, cache it, and publish after it.
  const cached = readKeyframeIndex(entry.dir);
  if (cached) {
    applySegments(entry, cached);
    return;
  }
  startKeyframeProbe(entry);
}

/** Look an entry up, rebuilding it from disk when the process has restarted. */
export function getVodEntry(id: string): VodEntry | null {
  if (!/^[a-f0-9]{8,40}$/.test(id)) return null;
  const live = entries.get(id);
  if (live) {
    live.lastUsedAt = Date.now();
    return live;
  }

  const dir = path.join(vodCacheDir(), id);
  const meta = readMeta(dir);
  if (!meta) return null;

  const entry: VodEntry = {
    ...meta,
    dir,
    status: isReadyOnDisk(dir) && playlistIsCompleteIn(dir) ? "ready" : "preparing",
    error: null,
    readyAt: null,
    lastUsedAt: Date.now(),
  };
  entries.set(id, entry);

  // A conversion interrupted by a restart left a partial playlist behind; the
  // honest answer is to run it again rather than serve a truncated film.
  if (entry.strategy === "whole-file" && entry.status !== "ready") restart(entry);
  // A segment entry is only usable if its boundaries survived — an entry
  // persisted before its keyframe probe finished has none, and serving its
  // playlist would 404 every segment.
  if (
    entry.strategy === "vod-segments" &&
    (entry.status !== "ready" || entry.segments.length === 0)
  ) {
    restart(entry);
  }
  return entry;
}

export function playlistPath(entry: VodEntry): string {
  return path.join(entry.dir, WHOLE_FILE_PLAYLIST);
}

function playlistIsCompleteIn(dir: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, WHOLE_FILE_PLAYLIST), "utf8").includes("#EXT-X-ENDLIST");
  } catch {
    return false;
  }
}

function playlistIsComplete(entry: VodEntry): boolean {
  return playlistIsCompleteIn(entry.dir);
}

function writePlaylist(entry: VodEntry): void {
  const text = buildVodPlaylist(entry.segments, {
    initUri: INIT_FILE,
    segmentUri: (index) => segmentName(index),
  });
  fs.writeFileSync(playlistPath(entry), text, "utf8");
}

export function segmentName(index: number): string {
  return `seg${String(index).padStart(5, "0")}.m4s`;
}

export function parseSegmentIndex(filename: string): number | null {
  const match = /^seg(\d{5})\.m4s$/.exec(filename);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

// ── Whole-file conversion ──

const conversionQueue: VodEntry[] = [];

function startWholeFileConversion(entry: VodEntry): void {
  if (conversionQueue.includes(entry)) return;
  conversionQueue.push(entry);
  pumpConversions();
}

function pumpConversions(): void {
  while (runningConversions < MAX_CONCURRENT_CONVERSIONS && conversionQueue.length > 0) {
    const entry = conversionQueue.shift();
    if (!entry) return;
    runConversion(entry);
  }
}

function runConversion(entry: VodEntry): void {
  let ffmpegPath: string;
  try {
    ffmpegPath = resolveFfmpegPath();
  } catch (err) {
    entry.status = "error";
    entry.error = err instanceof Error ? err.message : String(err);
    return;
  }

  runningConversions += 1;
  const args = buildWholeFileHlsArgs({ sourcePath: entry.sourcePath, plan: entry.plan });
  const startedAt = Date.now();
  console.info(`[vod] converting ${entry.id} (${entry.plan.rung}) ${entry.filePath}`);

  let proc: ChildProcess;
  try {
    proc = spawn(ffmpegPath, args, {
      cwd: entry.dir,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    runningConversions -= 1;
    entry.status = "error";
    entry.error = err instanceof Error ? err.message : String(err);
    pumpConversions();
    return;
  }

  liveProcesses.add(proc);
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  const finish = (ok: boolean, message: string) => {
    liveProcesses.delete(proc);
    runningConversions -= 1;
    if (ok && playlistIsComplete(entry) && fs.existsSync(path.join(entry.dir, WHOLE_FILE_DATA))) {
      markReady(entry);
      console.info(`[vod] ${entry.id} ready in ${Date.now() - startedAt}ms`);
    } else {
      entry.status = "error";
      entry.error = message || "conversion produced no playable output";
      console.warn(`[vod] ${entry.id} failed: ${entry.error}`);
    }
    pumpConversions();
  };

  proc.on("error", (err) => finish(false, err.message));
  proc.on("exit", (code) =>
    finish(code === 0, code === 0 ? "" : `ffmpeg exited ${code}: ${stderr.slice(-400)}`),
  );
}

// ── On-demand segments ──

export type SegmentResult =
  | { ok: true; absolutePath: string }
  | { ok: false; status: number; message: string };

/**
 * Produce (or return from cache) one segment, plus the shared init segment.
 *
 * The first segment produced also yields `init.mp4`: every segment is made with
 * identical codec arguments, so its `ftyp`+`moov` prefix is the same in all of
 * them and can serve as the single `#EXT-X-MAP` for the whole playlist.
 */
export async function ensureSegment(entry: VodEntry, index: number): Promise<SegmentResult> {
  const segment = entry.segments[index];
  if (!segment) {
    return { ok: false, status: 404, message: `segment ${index} is not in this playlist` };
  }
  const target = path.join(entry.dir, segmentName(index));
  if (fs.existsSync(target)) {
    entry.lastUsedAt = Date.now();
    return { ok: true, absolutePath: target };
  }

  const jobKey = `${entry.id}:${index}`;
  const running = segmentJobs.get(jobKey);
  if (running) return running;

  const job = withSegmentSlot(() => produceSegment(entry, segment, target)).finally(() => {
    segmentJobs.delete(jobKey);
  });
  segmentJobs.set(jobKey, job);
  return job;
}

export async function ensureInit(entry: VodEntry): Promise<SegmentResult> {
  const target = path.join(entry.dir, INIT_FILE);
  if (fs.existsSync(target)) return { ok: true, absolutePath: target };
  // The init is a by-product of producing a segment; segment 0 always exists.
  const produced = await ensureSegment(entry, 0);
  if (!produced.ok) return produced;
  return fs.existsSync(target)
    ? { ok: true, absolutePath: target }
    : { ok: false, status: 500, message: "segment produced no initialisation data" };
}

async function withSegmentSlot(run: () => Promise<SegmentResult>): Promise<SegmentResult> {
  while (runningSegments >= MAX_CONCURRENT_SEGMENTS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  runningSegments += 1;
  try {
    return await run();
  } finally {
    runningSegments -= 1;
  }
}

function produceSegment(
  entry: VodEntry,
  segment: VodSegment,
  target: string,
): Promise<SegmentResult> {
  return new Promise((resolve) => {
    let ffmpegPath: string;
    try {
      ffmpegPath = resolveFfmpegPath();
    } catch (err) {
      resolve({ ok: false, status: 500, message: err instanceof Error ? err.message : String(err) });
      return;
    }

    const args = buildVodSegmentArgs({
      sourcePath: entry.sourcePath,
      plan: entry.plan,
      segment,
      segmentSeconds: VOD_SEGMENT_SECONDS,
    });
    // ffmpeg writes the fragment to stdout so a killed run cannot leave a
    // half-written segment in the cache that later requests would trust.
    const proc = spawn(ffmpegPath, [...args, "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    liveProcesses.add(proc);

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      liveProcesses.delete(proc);
      resolve({ ok: false, status: 504, message: `segment ${segment.index} timed out` });
    }, SEGMENT_TIMEOUT_MS);
    timer.unref?.();

    const done = (result: SegmentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveProcesses.delete(proc);
      resolve(result);
    };

    proc.on("error", (err) => done({ ok: false, status: 500, message: err.message }));
    proc.on("close", (code) => {
      if (code !== 0) {
        done({
          ok: false,
          status: 500,
          message: `ffmpeg exited ${code}: ${stderr.slice(-300)}`,
        });
        return;
      }
      const split = splitFragmentedMp4(Buffer.concat(chunks));
      if (!split) {
        done({ ok: false, status: 500, message: "ffmpeg produced no fMP4 fragment" });
        return;
      }
      try {
        const initTarget = path.join(entry.dir, INIT_FILE);
        if (!fs.existsSync(initTarget)) fs.writeFileSync(initTarget, split.init);
        // Write-then-rename: a reader must never see a partial segment.
        const temp = `${target}.part`;
        fs.writeFileSync(temp, split.media);
        fs.renameSync(temp, target);
      } catch (err) {
        done({
          ok: false,
          status: 500,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      entry.lastUsedAt = Date.now();
      done({ ok: true, absolutePath: target });
    });
  });
}

// ── Eviction ──

function dirSize(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      total += stat.isDirectory() ? dirSize(path.join(dir, name)) : stat.size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

/**
 * Drop the least recently used conversions until the cache fits its budget.
 *
 * A whole-file conversion is roughly the size of the source, so an unbounded
 * cache would quietly fill the disk the torrents are downloading to.
 */
export function evictOverBudget(budget: number = CACHE_BUDGET_BYTES): number {
  const root = vodCacheDir();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }

  const candidates = names
    .map((name) => {
      const dir = path.join(root, name);
      const entry = entries.get(name);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        return null;
      }
      return { name, dir, size: dirSize(dir), used: entry?.lastUsedAt ?? mtime };
    })
    .filter((c): c is { name: string; dir: string; size: number; used: number } => c !== null);

  let total = candidates.reduce((sum, c) => sum + c.size, 0);
  if (total <= budget) return 0;

  candidates.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const candidate of candidates) {
    if (total <= budget) break;
    const entry = entries.get(candidate.name);
    if (entry?.status === "preparing") continue; // never delete work in flight
    try {
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      entries.delete(candidate.name);
      total -= candidate.size;
      removed += 1;
      console.info(`[vod] evicted ${candidate.name} (${candidate.size} bytes)`);
    } catch {
      /* locked on Windows; the next sweep will get it */
    }
  }
  return removed;
}

/** Forget everything in memory — for tests and shutdown. */
export function resetVodRuntime(): void {
  stopAllVodJobs();
  entries.clear();
  segmentJobs.clear();
  keyframeProbes.clear();
  conversionQueue.length = 0;
  runningConversions = 0;
  runningSegments = 0;
}

/** Snapshot for diagnostics. */
export function listVodEntries(): Array<{
  id: string;
  strategy: string;
  status: VodEntryStatus;
  rung: string;
  filePath: string;
}> {
  return Array.from(entries.values()).map((entry) => ({
    id: entry.id,
    strategy: entry.strategy,
    status: entry.status,
    rung: entry.plan.rung,
    filePath: entry.filePath,
  }));
}
