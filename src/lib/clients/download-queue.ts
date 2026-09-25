/**
 * Chronological queue for kept (non-stream) downloads.
 *
 * Every kept add used to go straight into WebTorrent. Each live torrent costs
 * its peer connections plus a per-torrent piece cache — measured at 80-90 MB
 * with a real swarm — so a 13-episode season took the server past 1.3 GB. The
 * cure is to keep only a few transfers live and hold the rest as rows that are
 * not in WebTorrent at all (a paused torrent still owns its wires and cache, so
 * pausing is not a substitute for never adding).
 *
 * Order is the one the owner asked for: within a series by (season, episode)
 * ascending, across different works by enqueue time. A single sortable
 * `queueKey` carries the episode position; the work's earliest enqueue time
 * anchors the whole group, so a season grabbed first finishes before a season
 * grabbed later even when its episodes were enqueued out of order.
 *
 * This module is pure so the ordering and cap rules are testable without a
 * WebTorrent client or a database.
 */

/** EngineTorrent.status for a kept download that is not in WebTorrent yet. */
export const QUEUED_STATUS = "queued";

/** Active kept downloads allowed at once when nothing overrides it. */
export const DEFAULT_MAX_ACTIVE_DOWNLOADS = 2;

/** Only kept downloads are queued — streams and prewarm are never blocked. */
export const QUEUEABLE_ORIGIN = "user";

export type QueueRow = {
  hash: string;
  status: string;
  origin: string;
  workId?: string | null;
  /** Sortable episode position, or null for anything without one (films). */
  queueKey?: string | null;
  createdAt: Date;
  /** Set when the owner forced this item past the cap. */
  forcedAt?: Date | null;
  sizeBytes?: number | bigint | null;
};

/**
 * Cap on concurrently transferring kept downloads.
 *
 * Read per call rather than frozen at import so a probe (or a test) can set
 * `TORRENTFLOW_MAX_ACTIVE_DOWNLOADS` and have the engine honour it.
 */
export function maxActiveDownloads(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TORRENTFLOW_MAX_ACTIVE_DOWNLOADS?.trim();
  if (!raw) return DEFAULT_MAX_ACTIVE_DOWNLOADS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ACTIVE_DOWNLOADS;
  return Math.max(1, Math.trunc(parsed));
}

/** Zero-padded so a plain string compare orders S2E10 after S2E9. */
export function queueKeyForEpisode(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null || episode == null) return null;
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0 || e < 0) return null;
  const pad = (n: number) => String(Math.trunc(n)).padStart(5, "0");
  return `s${pad(s)}e${pad(e)}`;
}

export function isQueued(row: Pick<QueueRow, "status">): boolean {
  return String(row.status).toLowerCase() === QUEUED_STATUS;
}

export function isForced(row: Pick<QueueRow, "forcedAt">): boolean {
  return row.forcedAt != null;
}

/** A kept download currently occupying a transfer slot. */
export function isActiveKept(row: QueueRow): boolean {
  return (
    row.origin === QUEUEABLE_ORIGIN &&
    String(row.status).toLowerCase() === "downloading"
  );
}

export function activeKeptCount(rows: readonly QueueRow[]): number {
  return rows.filter(isActiveKept).length;
}

function groupKeyOf(row: QueueRow): string {
  return row.workId?.trim() ? `work:${row.workId.trim()}` : `hash:${row.hash}`;
}

function time(value: Date): number {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Total order over queued rows: work group by earliest enqueue, then episode
 * position inside the group. Rows without a `queueKey` (films, one-offs) sort
 * after the numbered ones in their group so a season is never interleaved.
 */
export function orderQueue(rows: readonly QueueRow[]): QueueRow[] {
  const queued = rows.filter(isQueued);
  const anchors = new Map<string, number>();
  for (const row of queued) {
    const key = groupKeyOf(row);
    const at = time(row.createdAt);
    const current = anchors.get(key);
    if (current == null || at < current) anchors.set(key, at);
  }
  return [...queued].sort((a, b) => {
    const ga = groupKeyOf(a);
    const gb = groupKeyOf(b);
    if (ga !== gb) {
      const diff = (anchors.get(ga) ?? 0) - (anchors.get(gb) ?? 0);
      if (diff !== 0) return diff;
      return ga.localeCompare(gb);
    }
    const ka = a.queueKey?.trim() || "";
    const kb = b.queueKey?.trim() || "";
    if (ka !== kb) {
      if (!ka) return 1;
      if (!kb) return -1;
      return ka.localeCompare(kb);
    }
    return time(a.createdAt) - time(b.createdAt) || a.hash.localeCompare(b.hash);
  });
}

/** 1-based queue position per hash, for the UI. */
export function queuePositions(
  rows: readonly QueueRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  orderQueue(rows).forEach((row, index) => {
    out.set(row.hash.toLowerCase(), index + 1);
  });
  return out;
}

/**
 * Hashes that should start now: the head of the queue, enough to refill the
 * free slots. Forced rows are never here — they are promoted on demand and do
 * not wait for a slot.
 */
export function promotionCandidates(
  rows: readonly QueueRow[],
  cap: number,
): string[] {
  const free = Math.max(0, cap - activeKeptCount(rows));
  if (free === 0) return [];
  return orderQueue(rows)
    .slice(0, free)
    .map((row) => row.hash);
}

/**
 * Whether a fresh kept add has to wait. Forced adds never do, and neither does
 * anything that is not a kept download.
 */
export function shouldQueueNewDownload(opts: {
  rows: readonly QueueRow[];
  cap: number;
  origin: string;
  forced?: boolean;
  /** Admitted adds whose rows are not written yet. */
  pending?: number;
}): boolean {
  if (opts.forced) return false;
  if (opts.origin !== QUEUEABLE_ORIGIN) return false;
  return activeKeptCount(opts.rows) + (opts.pending ?? 0) >= opts.cap;
}

export type RehydratePlan = {
  /** Rows to re-add to WebTorrent now. */
  active: string[];
  /** Rows that must be demoted to `queued` before the client sees them. */
  demote: string[];
};

/**
 * Startup plan.
 *
 * A database written before this queue existed (or by a crash mid-season) can
 * hold a dozen rows all marked `downloading`. Re-adding them all is exactly the
 * RAM blow-up the queue exists to prevent, so the cap is applied here too:
 * forced rows always start, the earliest remaining rows fill what is left, and
 * everything else is persisted as queued.
 */
export function planRehydrate(
  rows: readonly QueueRow[],
  cap: number,
): RehydratePlan {
  const kept = rows.filter(
    (row) =>
      row.origin === QUEUEABLE_ORIGIN &&
      ["downloading", QUEUED_STATUS].includes(String(row.status).toLowerCase()),
  );
  const forced = kept.filter(isForced);
  const rest = kept.filter((row) => !isForced(row));
  // Order the whole remainder by the queue rule, whatever status it carries,
  // so "which of these twelve starts first" has the same answer at startup as
  // it does while running.
  const ordered = orderQueue(
    rest.map((row) => ({ ...row, status: QUEUED_STATUS })),
  );
  const free = Math.max(0, cap - forced.length);
  const active = [
    ...forced.map((row) => row.hash),
    ...ordered.slice(0, free).map((row) => row.hash),
  ];
  const activeSet = new Set(active);
  return {
    active,
    demote: kept
      .filter((row) => !activeSet.has(row.hash))
      .map((row) => row.hash),
  };
}

/** Bytes queued rows will claim once they start, for the storage gate. */
export function queuedReservedBytes(rows: readonly QueueRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (!isQueued(row)) continue;
    const size = Number(row.sizeBytes ?? 0);
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/**
 * Per-user admission control for the cap.
 *
 * The gate reads the active count from the database, but a fresh add only
 * writes its row once swarm metadata resolves — seconds to minutes later. Four
 * season workers checking the gate in that window would all see a free slot.
 * So admission is serialized per user (a promise-chain mutex) and a started
 * add holds an in-memory reservation, counted by the gate, from the moment it
 * is admitted until its row is persisted as `downloading` or the add fails.
 */
export function createAdmissionControl() {
  const tails = new Map<string, Promise<void>>();
  const reservations = new Map<string, Set<string>>();

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = prev.then(() => held);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      unlock();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  function reserve(key: string, hash: string): void {
    const set = reservations.get(key) ?? new Set<string>();
    set.add(hash.toLowerCase());
    reservations.set(key, set);
  }

  function release(key: string, hash: string): void {
    const set = reservations.get(key);
    if (!set) return;
    set.delete(hash.toLowerCase());
    if (set.size === 0) reservations.delete(key);
  }

  /** Reserved slots not already visible as an active row. */
  function pendingCount(key: string, rows: readonly QueueRow[]): number {
    const set = reservations.get(key);
    if (!set || set.size === 0) return 0;
    const active = new Set(
      rows.filter(isActiveKept).map((row) => row.hash.toLowerCase()),
    );
    let n = 0;
    for (const hash of set) if (!active.has(hash)) n++;
    return n;
  }

  return { withLock, reserve, release, pendingCount };
}

export type AdmissionControl = ReturnType<typeof createAdmissionControl>;

/**
 * Run `pass` for a key with at most one pass in flight. A call that arrives
 * while a pass is running marks the key dirty and shares the running promise;
 * the runner then does another pass, looping until no call arrived during the
 * last one — so a promotion request is never dropped.
 */
export function createCoalescingRunner<T>(
  pass: (key: string) => Promise<T[]>,
  onError: (err: unknown) => void = () => {},
) {
  const running = new Map<string, Promise<T[]>>();
  const dirty = new Set<string>();
  return (key: string): Promise<T[]> => {
    const current = running.get(key);
    if (current) {
      dirty.add(key);
      return current;
    }
    const run = (async () => {
      // Yield first so `running` is set before `pass` can re-enter the runner.
      await Promise.resolve();
      const out: T[] = [];
      try {
        do {
          dirty.delete(key);
          try {
            out.push(...(await pass(key)));
          } catch (err) {
            onError(err);
          }
        } while (dirty.has(key));
      } finally {
        running.delete(key);
      }
      return out;
    })();
    running.set(key, run);
    return run;
  };
}

/**
 * Whether resuming a paused live torrent must park it in the queue instead.
 * The resumed row itself is not counted as active (it is paused).
 */
export function shouldParkOnResume(opts: {
  rows: readonly QueueRow[];
  cap: number;
  pending?: number;
  hash: string;
}): boolean {
  const h = opts.hash.toLowerCase();
  const others = opts.rows.filter((row) => row.hash.toLowerCase() !== h);
  return activeKeptCount(others) + (opts.pending ?? 0) >= opts.cap;
}
