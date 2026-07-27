/**
 * Foreground priority — a pre-warm must never compete with playback.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MAX_CONCURRENT_PREWARMS` only limits how many speculative fetches *start*.
 * It does nothing about the case that actually hurts: a pre-warm is already
 * running, and the user then presses play. WebTorrent shares bandwidth and peer
 * slots across every torrent it holds, so the pre-warm keeps taking its share
 * and the user sees a stutter in the scene they are watching. A stutter reads
 * as "this app is broken", not as "a prefetch is running".
 *
 * WebTorrent has no per-torrent bandwidth priority. It does not need one: it
 * has `pause()`/`resume()` and per-file `deselect()`/`select()`, and "stop
 * asking for pieces entirely" is a stronger guarantee than any weighting.
 *
 * WHICH SEAM, AND WHY THIS ONE
 * ----------------------------
 * The truly honest signal is the stream route (`src/app/api/stream/**`) — it is
 * literally the bytes going to the player. That route is owned by another agent
 * and is being edited concurrently, so this module does not touch it. Instead:
 *
 *   1. PRIMARY — engine byte movement. This module reads the engine singleton
 *      (`globalThis.__tfBuiltinEngine`) directly and treats *any non-pre-warm
 *      torrent that is currently moving bytes* as foreground. That is direct
 *      evidence that the swarm is being worked for something the user asked
 *      for, it needs nothing from anybody else's file, and it cannot break
 *      playback because it only ever reads counters and attaches a listener.
 *
 *   2. BEACON — `markForegroundActive(infoHash)`. An explicit, one-line hook
 *      for whoever owns the stream route:
 *
 *          import { markForegroundActive } from "@/lib/prewarm/foreground";
 *          markForegroundActive(infoHash);   // on each range request
 *
 *      Until that call exists, (1) carries the feature on its own. This is
 *      stated plainly rather than left as a hook nobody calls.
 *
 * A playback-progress row is deliberately NOT the primary signal. It is a
 * weaker proxy — it keeps ticking while the player is paused — and today
 * nothing in the app posts to `/api/progress` at all, so a feature built on it
 * would never once fire in production while appearing to work in tests.
 *
 * THE FLAG CANNOT LEAK
 * --------------------
 * "Foreground is active" is never a boolean that something must remember to
 * clear. It is a **timestamp**, and `foregroundActive()` is
 * `now - lastSeen < FOREGROUND_IDLE_MS`. If the stream route dies mid-request,
 * crashes, or is killed, nothing refreshes the timestamp and it expires on its
 * own. There is no cleanup path to forget, so there is no way to end up with
 * pre-warming silently disabled forever — the failure mode of a leaked boolean.
 *
 * `resumePrewarms()` is likewise idempotent and safe to call when nothing is
 * suspended.
 */
import prisma from "@/lib/prisma";
import { PREWARM_ORIGIN } from "./types";

/**
 * How long after the last observed foreground byte we keep pre-warms parked.
 *
 * Long enough to ride out the gap between two range requests while the player
 * chews through its buffer; short enough that closing the tab gets prefetching
 * back within a few seconds.
 */
export const FOREGROUND_IDLE_MS = 20_000;

/** Below this, a torrent is idle rather than streaming. */
export const FOREGROUND_MIN_SPEED_BPS = 1024;

type WtFileLike = {
  select?: () => void;
  deselect?: () => void;
};

type WtTorrentLike = {
  infoHash: string;
  paused?: boolean;
  downloadSpeed?: number;
  done?: boolean;
  files?: Array<WtFileLike>;
  pause?: () => void;
  resume?: () => void;
  on?: (ev: string, fn: (...args: unknown[]) => void) => void;
  listenerCount?: (ev: string) => number;
};

type EngineLike = {
  client?: { torrents?: Array<WtTorrentLike> } | null;
};

type ForegroundState = {
  /** Last moment a foreground torrent was seen moving bytes. */
  lastSeenAt: number;
  /** infoHash of whatever was last seen in the foreground, for reporting. */
  lastHash: string | null;
  /** Hashes this module paused, so it only ever resumes its own work. */
  suspended: Set<string>;
};

const g = globalThis as unknown as {
  __tfPrewarmForeground?: ForegroundState;
  __tfBuiltinEngine?: EngineLike;
};

function state(): ForegroundState {
  if (!g.__tfPrewarmForeground) {
    g.__tfPrewarmForeground = { lastSeenAt: 0, lastHash: null, suspended: new Set() };
  }
  return g.__tfPrewarmForeground;
}

/** Torrents the in-process engine currently holds, or `[]` if there is no engine. */
function engineTorrents(): Array<WtTorrentLike> {
  const torrents = g.__tfBuiltinEngine?.client?.torrents;
  return Array.isArray(torrents) ? torrents : [];
}

function norm(hash: string): string {
  return hash.trim().toLowerCase();
}

/**
 * Records that bytes are being served to the player for `infoHash`.
 *
 * Safe to call on every range request — it is a single clock read and two
 * assignments. Exported for whoever owns the stream route; see the module
 * header.
 */
export function markForegroundActive(infoHash?: string | null): void {
  const s = state();
  s.lastSeenAt = Date.now();
  if (infoHash) s.lastHash = norm(infoHash);
}

/** Milliseconds since the last observed foreground byte. `Infinity` if never. */
export function foregroundIdleMs(now = Date.now()): number {
  const s = state();
  return s.lastSeenAt === 0 ? Infinity : now - s.lastSeenAt;
}

/** True while the user is being served bytes, or was within the grace period. */
export function foregroundActive(now = Date.now()): boolean {
  return foregroundIdleMs(now) < FOREGROUND_IDLE_MS;
}

/** The torrent last seen in the foreground, for diagnostics. */
export function foregroundHash(): string | null {
  return state().lastHash;
}

/**
 * Hashes the engine holds that are pre-warms.
 *
 * Read from the database rather than guessed: `origin` is the only authority on
 * whether a torrent was speculative, and getting this wrong in the other
 * direction would pause something the user asked for.
 */
async function prewarmHashes(
  userId: string,
  db: typeof prisma,
): Promise<Set<string>> {
  const rows = await db.engineTorrent.findMany({
    where: { userId, origin: PREWARM_ORIGIN },
    select: { hash: true },
  });
  return new Set(rows.map((r) => norm(r.hash)));
}

/**
 * Samples the engine for foreground activity and records it.
 *
 * A torrent counts as foreground when it is moving bytes and is **not** a
 * pre-warm. Returns the hash that was observed, or `null`.
 */
export function observeForeground(prewarms: ReadonlySet<string>): string | null {
  let seen: string | null = null;
  for (const t of engineTorrents()) {
    const hash = norm(String(t.infoHash ?? ""));
    if (!hash || prewarms.has(hash)) continue;
    const speed = Number(t.downloadSpeed ?? 0);
    if (Number.isFinite(speed) && speed >= FOREGROUND_MIN_SPEED_BPS) {
      seen = hash;
      break;
    }
  }
  if (seen) markForegroundActive(seen);
  return seen;
}

/**
 * Attaches a `download` listener to every non-pre-warm torrent.
 *
 * Sampling `downloadSpeed` alone would only notice the foreground on the next
 * sync; the event fires on the first piece, which is what "suspend on first
 * foreground byte" actually requires. Adding a listener cannot affect the
 * bytes, and `listenerCount` keeps a hot-reloaded module from stacking them.
 */
function watchForeground(prewarms: ReadonlySet<string>): void {
  for (const t of engineTorrents()) {
    const hash = norm(String(t.infoHash ?? ""));
    if (!hash || prewarms.has(hash)) continue;
    if (typeof t.on !== "function") continue;
    try {
      if ((t.listenerCount?.("download") ?? 0) > 0) continue;
      t.on("download", () => markForegroundActive(hash));
    } catch {
      // A listener is an optimisation. Sampling still covers us.
    }
  }
}

export interface SuspensionResult {
  /** True while the user is being served bytes. */
  foreground: boolean;
  /** Hashes paused by this call. */
  suspended: string[];
  /** Hashes resumed by this call. */
  resumed: string[];
  /** Hashes currently parked by this module. */
  parked: string[];
  /** The foreground torrent, when one was observed. */
  foregroundHash: string | null;
}

/**
 * Stops a pre-warm from asking for any more pieces.
 *
 * `deselect()` first so no new piece requests are queued, then `pause()` to
 * stop the wires. Doing only one of the two leaves the torrent still competing:
 * a paused torrent keeps its selections, and a deselected torrent keeps its
 * peers.
 */
function suspendTorrent(t: WtTorrentLike): boolean {
  let acted = false;
  for (const f of t.files ?? []) {
    try {
      f.deselect?.();
      acted = true;
    } catch {
      // Best effort — pause below is the part that matters.
    }
  }
  try {
    if (!t.paused) {
      t.pause?.();
      acted = true;
    }
  } catch {
    return acted;
  }
  return acted;
}

function resumeTorrent(t: WtTorrentLike): boolean {
  let acted = false;
  try {
    if (t.paused) {
      t.resume?.();
      acted = true;
    }
  } catch {
    return acted;
  }
  for (const f of t.files ?? []) {
    try {
      f.select?.();
      acted = true;
    } catch {
      // Best effort.
    }
  }
  return acted;
}

export interface SyncOptions {
  userId: string;
  db?: typeof prisma;
  now?: number;
  /** Test seam: forces the foreground verdict instead of sampling the engine. */
  _foregroundActive?: boolean;
}

/**
 * Brings pre-warm torrents into line with what the user is doing.
 *
 * Foreground active  → every pre-warm is paused and deselected.
 * Foreground idle    → every pre-warm *this module paused* is resumed.
 *
 * Never throws: this runs from a progress ping on the playback hot path, and a
 * pre-warm is a background nicety that may never take anything down with it.
 */
export async function syncPrewarmSuspension(
  opts: SyncOptions,
): Promise<SuspensionResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();
  const s = state();
  const empty: SuspensionResult = {
    foreground: false,
    suspended: [],
    resumed: [],
    parked: [...s.suspended],
    foregroundHash: s.lastHash,
  };

  let prewarms: Set<string>;
  try {
    prewarms = await prewarmHashes(opts.userId, db);
  } catch (err) {
    console.warn(
      "[prewarm] could not read pre-warm origins; leaving torrents alone:",
      err instanceof Error ? err.message : String(err),
    );
    return empty;
  }

  if (opts._foregroundActive === undefined) {
    watchForeground(prewarms);
    observeForeground(prewarms);
  }

  const active =
    opts._foregroundActive === undefined
      ? foregroundActive(now)
      : opts._foregroundActive;

  const suspended: string[] = [];
  const resumed: string[] = [];

  for (const t of engineTorrents()) {
    const hash = norm(String(t.infoHash ?? ""));
    if (!hash) continue;

    // The load-bearing line. Only a speculative torrent may ever be touched;
    // pausing a download the user asked for is the same class of harm as
    // evicting one. `origin` is the authority, never a guess from the name.
    if (!prewarms.has(hash)) continue;

    if (active) {
      if (suspendTorrent(t)) {
        s.suspended.add(hash);
        suspended.push(hash);
      }
    } else if (s.suspended.has(hash)) {
      // Only ever un-pause what *we* paused. A torrent the user paused by hand
      // must stay paused.
      if (resumeTorrent(t)) resumed.push(hash);
      s.suspended.delete(hash);
    }
  }

  return {
    foreground: active,
    suspended,
    resumed,
    parked: [...s.suspended],
    foregroundHash: s.lastHash,
  };
}

/** Test seam: clears the in-process foreground bookkeeping. */
export function resetForegroundState(): void {
  g.__tfPrewarmForeground = { lastSeenAt: 0, lastHash: null, suspended: new Set() };
}

/** Diagnostics for `GET /api/prewarm`. */
export function foregroundSnapshot(now = Date.now()): {
  active: boolean;
  idleMs: number | null;
  hash: string | null;
  parked: string[];
  graceMs: number;
} {
  const s = state();
  const idle = foregroundIdleMs(now);
  return {
    active: foregroundActive(now),
    idleMs: Number.isFinite(idle) ? idle : null,
    hash: s.lastHash,
    parked: [...s.suspended],
    graceMs: FOREGROUND_IDLE_MS,
  };
}
