/**
 * LRU eviction of speculative downloads.
 *
 * THE RULE, AND IT HAS NO EXCEPTIONS
 * ----------------------------------
 * Only `EngineTorrent` rows with `origin === "prewarm"` may ever be deleted by
 * this module. Deleting something the user explicitly asked for is data loss
 * dressed up as cache management, and it is called out as a named risk in the
 * roadmap. The guard is applied three times on purpose — in the query, in the
 * loop immediately before the destructive call, and in the `deleteMany` that
 * removes the row — because each one alone is a single edit away from being
 * wrong, and the failure would be silent and permanent.
 *
 * WHAT ELSE IS OFF LIMITS
 * -----------------------
 * A pre-warm the user has *started watching* is no longer speculative, so any
 * torrent with a `PlaybackProgress` row is protected regardless of its origin.
 * The roadmap says the policy is for "pre-warmed content that was never
 * watched"; this is that sentence in code.
 *
 * Callers may also pass `protectHashes` for the torrent currently on screen.
 * Its `lastUsedAt` should already make it the most-recently-used row, but
 * "should already" is not a guarantee, and the cost of being wrong is the user
 * watching a video that vanishes underneath them.
 */
import prisma from "@/lib/prisma";
import { getClient } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { EVICTING_ORIGIN, PREWARM_ORIGIN } from "./types";
import type { EvictionCandidate, EvictionResult } from "./types";
import { newEvictLease, recoverStaleEvictionLeases } from "@/lib/streaming/evict-lease";

type Db = typeof prisma;

/** How many rows one eviction pass will consider. */
const MAX_SCAN = 200;

function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

/**
 * Bytes this row is actually holding on disk.
 *
 * A half-finished torrent has half its bytes. Counting the full size would let
 * the budget maths believe it had reclaimed space it never had — which is the
 * same class of bug as claiming something is ready before checking.
 */
export function onDiskBytes(row: {
  sizeBytes: bigint | number;
  progress: number;
}): number {
  const size = typeof row.sizeBytes === "bigint" ? Number(row.sizeBytes) : row.sizeBytes;
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.round(size * clampProgress(row.progress));
}

function toCandidate(row: {
  id: string;
  hash: string;
  name: string;
  origin: string;
  sizeBytes: bigint;
  progress: number;
  status: string;
  lastUsedAt: Date;
}): EvictionCandidate {
  return {
    id: row.id,
    hash: row.hash,
    name: row.name,
    origin: row.origin,
    sizeBytes: Number(row.sizeBytes),
    progress: row.progress,
    status: row.status,
    lastUsedAt: row.lastUsedAt,
  };
}

export interface ListEvictableOptions {
  db?: Db;
  /** Hashes that must not be touched (e.g. the torrent being watched now). */
  protectHashes?: readonly string[];
  limit?: number;
}

/**
 * Prewarm rows that are legitimately evictable, least-recently-used first.
 *
 * Uses the `[userId, origin, lastUsedAt]` index the schema added for exactly
 * this query.
 */
export async function listEvictablePrewarms(
  userId: string,
  opts: ListEvictableOptions = {},
): Promise<{
  candidates: EvictionCandidate[];
  skipped: Array<{ hash: string; reason: string }>;
}> {
  const db = opts.db ?? prisma;
  const protectedHashes = new Set(
    (opts.protectHashes ?? []).map((h) => h.toLowerCase()),
  );

  const rows = await db.engineTorrent.findMany({
    // Guard 1 of 3: the query itself never sees a user-origin row.
    where: { userId, origin: PREWARM_ORIGIN },
    orderBy: { lastUsedAt: "asc" },
    take: Math.max(1, opts.limit ?? MAX_SCAN),
  });

  const skipped: Array<{ hash: string; reason: string }> = [];
  const usable: EvictionCandidate[] = [];

  const watchedHashes = new Set<string>();
  if (rows.length > 0) {
    const progress = await db.playbackProgress.findMany({
      where: { userId, infoHash: { in: rows.map((r) => r.hash) } },
      select: { infoHash: true },
    });
    for (const p of progress) watchedHashes.add(p.infoHash.toLowerCase());
  }

  for (const row of rows) {
    const candidate = toCandidate(row);
    const hash = row.hash.toLowerCase();

    if (candidate.origin !== PREWARM_ORIGIN) {
      // Unreachable given the query above, which is the point: if a future
      // edit widens that `where`, this still holds.
      skipped.push({ hash, reason: "not-prewarm" });
      continue;
    }
    if (protectedHashes.has(hash)) {
      skipped.push({ hash, reason: "protected" });
      continue;
    }
    if (watchedHashes.has(hash)) {
      skipped.push({ hash, reason: "watched" });
      continue;
    }
    usable.push(candidate);
  }

  return { candidates: usable, skipped };
}

export interface EvictOptions {
  userId: string;
  /** Bytes we need back. Eviction stops as soon as this is met. */
  neededBytes: number;
  config: ClientConnectionConfig;
  protectHashes?: readonly string[];
  db?: Db;
  /** Test seam: performs the actual client-side removal. */
  _deleteFn?: (
    config: ClientConnectionConfig,
    hash: string,
  ) => Promise<{ ok: boolean; message: string }>;
  /**
   * Test seam: fires AFTER a candidate passes the pre-claim guards but BEFORE
   * the claim CAS — the exact window in which an explicit Download can promote
   * a `prewarm` row to `user`. Used to prove the claim lease refuses to delete
   * a just-promoted download's files.
   */
  _beforeClaim?: (candidate: EvictionCandidate) => Promise<void> | void;
  /**
   * Test seam: fires AFTER the claim CAS has leased the row (prewarm → evicting)
   * but BEFORE the re-check + unlink — the window in which an explicit Download
   * STEALS the lease (evicting → user). Used to prove the re-check aborts the
   * delete and keeps the files.
   */
  _afterClaim?: (candidate: EvictionCandidate) => Promise<void> | void;
}

async function deleteViaClient(
  config: ClientConnectionConfig,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient(config.clientType);
  if (!client.deleteTorrent) {
    return { ok: false, message: "Client cannot delete torrents" };
  }
  // Files too — the entire point is to reclaim the bytes.
  return client.deleteTorrent(config, hash, true);
}

/**
 * Free up to `neededBytes` by evicting unwatched pre-warms, LRU first.
 *
 * Never throws. Reports exactly what it removed and what it deliberately left
 * alone; `satisfied` is false when it could not free enough, and the caller is
 * expected to then do nothing rather than exceed the budget.
 */
export async function evictPrewarmsForBytes(
  opts: EvictOptions,
): Promise<EvictionResult> {
  const db = opts.db ?? prisma;
  const neededBytes = Math.max(0, Math.trunc(opts.neededBytes));
  const remove = opts._deleteFn ?? deleteViaClient;

  const result: EvictionResult = {
    evicted: [],
    freedBytes: 0,
    neededBytes,
    satisfied: neededBytes === 0,
    skipped: [],
  };

  if (neededBytes === 0) return result;

  // Reclaim any lease abandoned by a crash (issue D reviewer round 2) BEFORE
  // listing, so a stranded `evicting` row is restored to its recorded origin
  // (here, prewarm) instead of leaking its disk forever.
  await recoverStaleEvictionLeases({ userId: opts.userId, db }).catch(() => ({
    recovered: [],
  }));

  let listed: Awaited<ReturnType<typeof listEvictablePrewarms>>;
  try {
    listed = await listEvictablePrewarms(opts.userId, {
      db,
      protectHashes: opts.protectHashes,
    });
  } catch (err) {
    console.warn(
      "[prewarm] could not list evictable pre-warms:",
      err instanceof Error ? err.message : String(err),
    );
    return result;
  }

  result.skipped.push(...listed.skipped);

  for (const candidate of listed.candidates) {
    if (result.freedBytes >= neededBytes) break;

    // Guard 2 of 3. This is the line standing between a cache policy and
    // deleting a download the user asked for. It must never be removed.
    if (candidate.origin !== PREWARM_ORIGIN) {
      result.skipped.push({ hash: candidate.hash, reason: "not-prewarm" });
      continue;
    }

    const bytes = onDiskBytes(candidate);
    if (bytes <= 0) {
      // Removing it reclaims nothing and throws away work in progress.
      result.skipped.push({ hash: candidate.hash, reason: "frees-nothing" });
      continue;
    }

    // ── CLAIM THE ROW BEFORE TOUCHING ANY FILE (issue D) ────────────────────
    // Atomically lease prewarm → evicting and stamp a token. If an explicit
    // Download promoted this hash (prewarm → user) after it was listed, the guard
    // `origin = prewarm` no longer matches, the claim frees nothing, and we abort
    // WITH THE FILES STILL ON DISK. `evictLease: null` also stops us re-claiming a
    // row another sweep already leased. The old order (delete files, then guard
    // the row delete) could destroy a just-promoted download's bytes before the
    // row guard refused. Worst case now is an orphaned file (reclaimed by lease
    // recovery), never a lost download.
    await opts._beforeClaim?.(candidate);
    const leaseToken = newEvictLease();
    let claimed = 0;
    try {
      const claim = await db.engineTorrent.updateMany({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: PREWARM_ORIGIN,
          evictLease: null,
        },
        data: { origin: EVICTING_ORIGIN, evictLease: leaseToken, evictFrom: PREWARM_ORIGIN },
      });
      claimed = claim.count;
    } catch (err) {
      result.skipped.push({
        hash: candidate.hash,
        reason: `db-claim-error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (claimed === 0) {
      result.skipped.push({ hash: candidate.hash, reason: "db-guard-refused" });
      continue;
    }

    await opts._afterClaim?.(candidate);

    // RE-CHECK UNDER THE LEASE, immediately before unlink. A Download that
    // arrived after our claim STEALS the lease (evicting → user, clearing the
    // token). If our exact token no longer owns the row, the user won: abort with
    // the files intact.
    let stillOwn = false;
    try {
      const owned = await db.engineTorrent.findFirst({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: EVICTING_ORIGIN,
          evictLease: leaseToken,
        },
        select: { hash: true },
      });
      stillOwn = owned != null;
    } catch {
      stillOwn = false; // fail closed: never delete if we cannot prove we own it
    }
    if (!stillOwn) {
      result.skipped.push({ hash: candidate.hash, reason: "lease-stolen" });
      continue;
    }

    // The lease is exclusively ours (origin = evicting, token matches). Delete
    // the files.
    let deletedOk = false;
    try {
      const removed = await remove(opts.config, candidate.hash);
      deletedOk = removed.ok;
      if (!removed.ok) {
        result.skipped.push({
          hash: candidate.hash,
          reason: `client-refused: ${removed.message}`,
        });
      }
    } catch (err) {
      result.skipped.push({
        hash: candidate.hash,
        reason: `client-error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!deletedOk) {
      // Roll the lease back so the row returns to an evictable prewarm. Guarded on
      // OUR token so we never clobber a steal that landed in the meantime.
      try {
        await db.engineTorrent.updateMany({
          where: {
            userId: opts.userId,
            hash: candidate.hash,
            origin: EVICTING_ORIGIN,
            evictLease: leaseToken,
          },
          data: { origin: PREWARM_ORIGIN, evictLease: null, evictFrom: null },
        });
      } catch {
        /* best-effort */
      }
      continue;
    }

    try {
      // Defensive: ensure the leased row is gone. Guarded to our exact lease so
      // we only ever delete the row we ourselves claimed and still own.
      await db.engineTorrent.deleteMany({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: EVICTING_ORIGIN,
          evictLease: leaseToken,
        },
      });
    } catch (err) {
      result.skipped.push({
        hash: candidate.hash,
        reason: `db-error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    result.evicted.push(candidate);
    result.freedBytes += bytes;
  }

  result.satisfied = result.freedBytes >= neededBytes;
  return result;
}

/**
 * Record that playback touched a torrent.
 *
 * This is what `EngineTorrent.lastUsedAt` is for, and it is the mechanism that
 * stops the thing you are watching from being the least-recently-used row.
 * Never throws — a missed timestamp is not worth failing a progress ping over.
 */
export async function markPrewarmUsed(
  userId: string,
  infoHash: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<boolean> {
  const db = opts.db ?? prisma;
  const hash = infoHash.trim().toLowerCase();
  if (!hash) return false;
  try {
    const r = await db.engineTorrent.updateMany({
      where: { userId, hash },
      data: { lastUsedAt: opts.now ?? new Date() },
    });
    return r.count > 0;
  } catch {
    return false;
  }
}
