/**
 * Eviction lease primitives (issue D, reviewer round 2).
 *
 * A destructive sweep claims a cache row atomically by moving its origin to
 * `evicting` and stamping a lease token. Two failure modes are closed here:
 *
 *   1. STEAL — an explicit user add (Download/Play) promotes the row out of
 *      `evicting` and clears the lease. The sweep RE-CHECKS the token
 *      immediately before it unlinks; a stolen lease aborts the delete with the
 *      files intact. The user's instruction beats the speculative sweep.
 *
 *   2. ABANDONMENT — a crash between claim and delete would strand the row in
 *      `evicting` forever (nothing promotes it, nothing evicts it). A lease
 *      older than {@link EVICT_LEASE_STALE_MS} is recovered to the EXACT origin
 *      recorded at claim time. Recovery only ever touches rows the code itself
 *      moved to `evicting` — a state no historical row has ever held — so it can
 *      never reclassify or "backfill" a pre-existing row.
 */
import prisma from "@/lib/prisma";
import { EVICTING_ORIGIN, PREWARM_ORIGIN, STREAM_ORIGIN } from "@/lib/prewarm/types";
import { randomUUID } from "node:crypto";

type Db = typeof prisma;

/**
 * How long a lease may sit in `evicting` before it is presumed abandoned. Real
 * evictions complete in well under a second (the file delete is an unlink); a
 * lease older than this can only be a crash, so recovery cannot race a live
 * eviction.
 */
export const EVICT_LEASE_STALE_MS = 10 * 60 * 1000;

/** Mint a lease token. The millisecond prefix carries the claim time for
 * staleness; the uuid suffix makes the token unique so a re-claim (ABA) cannot
 * be mistaken for the same lease. */
export function newEvictLease(now: Date = new Date()): string {
  return `${now.getTime()}:${randomUUID()}`;
}

/** Parse the claim time out of a lease token, or null if it is unparseable. */
export function leaseClaimedAtMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const ms = Number(token.split(":")[0]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Return abandoned `evicting` rows to their recorded prior origin.
 *
 * Fails closed in every ambiguous case: a token we cannot parse, or a lease that
 * is not yet stale, is left alone. Restoration targets the recorded `evictFrom`
 * and NEVER `user` — a recovered row is always an evictable cache state, so
 * recovery can only ever make a row equally or LESS deletion-eligible than the
 * sweep already judged it, never more protected than the user asked for.
 */
export async function recoverStaleEvictionLeases(opts: {
  userId: string;
  db?: Db;
  now?: Date;
  maxAgeMs?: number;
}): Promise<{ recovered: Array<{ hash: string; restoredTo: string }> }> {
  const db = opts.db ?? prisma;
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAgeMs = opts.maxAgeMs ?? EVICT_LEASE_STALE_MS;
  const recovered: Array<{ hash: string; restoredTo: string }> = [];
  let rows: Array<{ hash: string; evictLease: string | null; evictFrom: string | null }>;
  try {
    rows = await db.engineTorrent.findMany({
      where: { userId: opts.userId, origin: EVICTING_ORIGIN },
      select: { hash: true, evictLease: true, evictFrom: true },
    });
  } catch {
    return { recovered };
  }
  for (const row of rows) {
    const claimedAt = leaseClaimedAtMs(row.evictLease);
    // Fail closed: if we cannot prove the lease is stale, do not touch it.
    if (claimedAt == null) continue;
    if (nowMs - claimedAt < maxAgeMs) continue;
    // Restore the EXACT recorded origin; default to `stream` (the more-evictable
    // cache state) only if it was somehow unrecorded — never to `user`.
    const restoreTo =
      row.evictFrom === PREWARM_ORIGIN ? PREWARM_ORIGIN : STREAM_ORIGIN;
    try {
      const r = await db.engineTorrent.updateMany({
        // Token-guarded: only recover the exact lease we just read, so a lease
        // re-created between the read and here is not clobbered.
        where: {
          userId: opts.userId,
          hash: row.hash,
          origin: EVICTING_ORIGIN,
          evictLease: row.evictLease,
        },
        data: { origin: restoreTo, evictLease: null, evictFrom: null },
      });
      if (r.count > 0) recovered.push({ hash: row.hash, restoredTo: restoreTo });
    } catch {
      /* best-effort: a stranded evicting row still reads as a hidden stream */
    }
  }
  return { recovered };
}
