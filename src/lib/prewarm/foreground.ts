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
 * WebTorrent has no per-torrent bandwidth priority. The current pre-warm mode
 * therefore keeps speculative torrents connected but deselected: trackers,
 * handshakes and unchokes stay warm for "Next", while no content is requested
 * until playback actually selects a file.
 *
 * WHICH SEAM, AND WHY THIS ONE
 * ----------------------------
 * The truly honest signal is the stream route (`src/app/api/stream/**`) and the
 * playback routes that serve HLS/VOD/subtitle bodies — they are literally the
 * bytes going to the player. That hook is intentionally tiny:
 *
 *   1. PRIMARY — `markForegroundActive(infoHash)`. A one-line beacon from the
 *      byte-serving route:
 *
 *          import { markForegroundActive } from "@/lib/prewarm/foreground";
 *          markForegroundActive(infoHash);   // on each served media request
 *
 *      This catches the two cases counters cannot: a fully downloaded file that
 *      moves zero torrent bytes while ffmpeg remuxes it, and a starving stream
 *      whose averaged speed is below the threshold precisely because it needs
 *      the speculative downloads to get out of the way.
 *
 *   2. BACKSTOP — engine byte movement. This module reads the engine singleton
 *      (`globalThis.__tfBuiltinEngine`) directly and treats *any non-pre-warm
 *      torrent that is currently moving bytes* as foreground. That is direct
 *      evidence that the swarm is being worked for something the user asked
 *      for, it needs nothing from anybody else's file, and it cannot break
 *      playback because it only ever reads counters and attaches a listener.
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
 * Clearing the parked marker is likewise idempotent and safe to do when
 * nothing is parked.
 */
import prisma from "@/lib/prisma";
import { PREWARM_ORIGIN, STREAM_ORIGIN } from "./types";

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
  downloadSpeed?: number;
  done?: boolean;
  files?: Array<WtFileLike>;
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
  /** Hashes this module deselected while foreground playback was active. */
  suspended: Set<string>;
  /**
   * Per-hash "bytes were served to the *player* for this torrent" timestamps.
   *
   * This is the honest playback signal, distinct from the global byte-movement
   * backstop: only the byte-serving routes (`markForegroundActive`) write it,
   * never `observeForeground`/`watchForeground`. A stream that is merely still
   * downloading its own selected pieces must NOT count as watched, or a closed
   * stream would keep itself "foreground" and never stop.
   */
  seen: Map<string, number>;
};

const g = globalThis as unknown as {
  __tfPrewarmForeground?: ForegroundState;
  __tfPrewarmForegroundAborters?: Set<AbortController>;
  __tfBuiltinEngine?: EngineLike;
};

function state(): ForegroundState {
  if (!g.__tfPrewarmForeground) {
    g.__tfPrewarmForeground = {
      lastSeenAt: 0,
      lastHash: null,
      suspended: new Set(),
      seen: new Map(),
    };
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
 * Refresh the GLOBAL foreground clock only — not the per-hash playback map.
 *
 * The byte-movement backstop (`observeForeground`/`watchForeground`) uses this:
 * "some non-pre-warm torrent is moving bytes" is enough to keep pre-warms out
 * of the way, but it is NOT proof the user is watching that specific torrent, so
 * it must never mark a torrent as watched for the stream-park decision.
 */
function touchGlobal(infoHash?: string | null, now = Date.now()): void {
  const s = state();
  s.lastSeenAt = now;
  if (infoHash) s.lastHash = norm(infoHash);
  for (const controller of g.__tfPrewarmForegroundAborters ?? []) {
    controller.abort();
  }
  g.__tfPrewarmForegroundAborters?.clear();
}

/**
 * Signal the instant foreground work starts. Speculative callers dispose the
 * registration when they finish so an idle pass leaves no listener behind.
 */
export function foregroundCancellationSignal(): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (foregroundActive()) {
    controller.abort();
  } else {
    const aborters =
      g.__tfPrewarmForegroundAborters ??
      (g.__tfPrewarmForegroundAborters = new Set());
    aborters.add(controller);
  }
  return {
    signal: controller.signal,
    dispose: () => g.__tfPrewarmForegroundAborters?.delete(controller),
  };
}

/**
 * Records that bytes are being served to the player for `infoHash`.
 *
 * Safe to call on every range request — it is a clock read and a few
 * assignments. Exported for whoever owns the byte-serving routes; see the module
 * header. Unlike the backstop, this is real playback, so it stamps both the
 * global clock and the per-hash "watched" map the stream-park decision reads.
 */
export function markForegroundActive(infoHash?: string | null): void {
  const now = Date.now();
  touchGlobal(infoHash, now);
  if (infoHash) state().seen.set(norm(infoHash), now);
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
 * Hashes the engine holds that exist only because the user pressed Play.
 *
 * Same authority as {@link prewarmHashes}: `origin` is the only thing that says
 * a torrent is a stream cache rather than a download the user asked to keep.
 * Getting this wrong would park (stop downloading) a torrent the user is
 * actually saving, so it is read from the database, never guessed.
 */
async function streamHashes(
  userId: string,
  db: typeof prisma,
): Promise<Set<string>> {
  const rows = await db.engineTorrent.findMany({
    where: { userId, origin: STREAM_ORIGIN },
    select: { hash: true },
  });
  return new Set(rows.map((r) => norm(r.hash)));
}

/**
 * Loads the built-in engine's stream-park function lazily.
 *
 * A static import would close a cycle (`builtin-engine` already imports
 * `foregroundActive` from this module); a dynamic import breaks it and is only
 * paid when there is actually a stream to park.
 */
async function loadEnginePark(): Promise<(infoHash: string) => boolean> {
  const mod = await import("@/lib/clients/builtin-engine");
  return mod.parkBuiltinStreamTorrent;
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
  if (seen) touchGlobal(seen);
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
      t.on("download", () => touchGlobal(hash));
    } catch {
      // A listener is an optimisation. Sampling still covers us.
    }
  }
}

export interface SuspensionResult {
  /** True while the user is being served bytes. */
  foreground: boolean;
  /** Hashes deselected by this call. */
  suspended: string[];
  /** Kept for diagnostics compatibility; connection-only prewarms do not resume. */
  resumed: string[];
  /** Hashes currently parked by this module. */
  parked: string[];
  /** The foreground torrent, when one was observed. */
  foregroundHash: string | null;
}

/**
 * Stops a pre-warm from asking for pieces while keeping its peers warm.
 */
function suspendTorrent(t: WtTorrentLike): boolean {
  let acted = false;
  for (const f of t.files ?? []) {
    try {
      f.deselect?.();
      acted = true;
    } catch {
      // Best effort — another file may still be deselected.
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
  /**
   * Test seam: park a stream-only torrent by hash, returning whether it acted.
   * Defaults to the built-in engine's `parkBuiltinStreamTorrent`.
   */
  _parkStream?: (infoHash: string) => boolean;
}

/**
 * Brings pre-warm torrents into line with what the user is doing.
 *
 * Foreground active  → every pre-warm is deselected but left connected.
 * Foreground idle    → clear our parked marker; do not re-select pieces.
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
      if (!s.suspended.has(hash) && suspendTorrent(t)) {
        s.suspended.add(hash);
        suspended.push(hash);
      }
    } else if (s.suspended.has(hash)) {
      // Connection-only prewarms were never paused, and idle must not re-select
      // files. The eventual stream request selects the exact pieces the user
      // actually asked for.
      s.suspended.delete(hash);
    }
  }

  // Stream-only torrents are a cache of what is on screen. A stream is left
  // alone only while it is genuinely *being watched* — i.e. a byte-serving
  // route stamped its per-hash playback clock within the grace window. This is
  // deliberately NOT the global foreground flag: a stream that is merely still
  // downloading its own selected pieces would keep that flag (and itself) alive
  // forever, and a concurrent kept download must never protect an unrelated
  // stream. The moment a stream stops being watched — the player closed, its
  // beacon released it, or its playback simply went idle — it stops pulling
  // pieces into the user's storage. A later Play re-selects and resumes from
  // disk.
  let streams: Set<string>;
  try {
    streams = await streamHashes(opts.userId, db);
  } catch {
    // A stream cache that keeps pulling is a nuisance, never a data-loss risk,
    // so a failed lookup here must not abort the pre-warm reconcile above.
    streams = new Set();
  }

  if (streams.size > 0) {
    const watchedRecently = (hash: string): boolean => {
      const at = s.seen.get(hash);
      return at !== undefined && now - at < FOREGROUND_IDLE_MS;
    };
    const toPark: string[] = [];
    for (const t of engineTorrents()) {
      const hash = norm(String(t.infoHash ?? ""));
      if (!hash || !streams.has(hash)) continue;
      if (watchedRecently(hash)) {
        // On screen right now: drop any parked marker so it can be parked
        // afresh once it is closed again.
        s.suspended.delete(hash);
        continue;
      }
      if (!s.suspended.has(hash)) toPark.push(hash);
    }
    if (toPark.length > 0) {
      let park: (infoHash: string) => boolean;
      try {
        park = opts._parkStream ?? (await loadEnginePark());
      } catch {
        park = () => false;
      }
      for (const hash of toPark) {
        try {
          if (park(hash)) {
            s.suspended.add(hash);
            suspended.push(hash);
          }
        } catch {
          // One torrent that refuses to park must not strand the others.
        }
      }
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
  g.__tfPrewarmForeground = {
    lastSeenAt: 0,
    lastHash: null,
    suspended: new Set(),
    seen: new Map(),
  };
}

/**
 * Marks the end of foreground playback for `infoHash` (the player closed).
 *
 * Drops the per-hash "watched" stamp so the next `syncPrewarmSuspension` parks
 * this stream even if it is still moving bytes of its own selected pieces — the
 * whole point is to stop that. If the closing hash is also the global
 * foreground, expire that clock too so pre-warming can resume. A call with no
 * hash clears everything (the page went away).
 */
export function releaseForeground(infoHash?: string | null): void {
  const s = state();
  if (!infoHash) {
    s.lastSeenAt = 0;
    s.seen.clear();
    return;
  }
  const h = norm(infoHash);
  s.seen.delete(h);
  if (s.lastHash === h) s.lastSeenAt = 0;
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
