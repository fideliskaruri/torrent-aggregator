/**
 * Retention policy for torrents that exist because the user streamed them.
 *
 * "Watched" and "kept" are different states. A stream-only torrent may be
 * evicted like a cache entry; a user/download/watchlist torrent may not. The
 * destructive path fails closed by re-reading the row immediately before the
 * delete and requiring all local facts again: origin is stream-only, playback is
 * complete, the seeding grace has elapsed, no library row owns it, and it is not
 * the foreground hash.
 */
import prisma from "@/lib/prisma";
import { getClient } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { ExistingOriginLookup } from "@/lib/clients/add-purpose";
import { newEvictLease, recoverStaleEvictionLeases } from "./evict-lease";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { onDiskBytes } from "@/lib/prewarm/eviction";
import {
  EVICTING_ORIGIN,
  PREWARM_ORIGIN,
  STREAM_ORIGIN,
  USER_ORIGIN,
} from "@/lib/prewarm/types";
import { infoHashFromMagnet } from "@/lib/torrents/infohash";
import { foregroundHash } from "@/lib/prewarm/foreground";

type Db = typeof prisma;

export { STREAM_ORIGIN };
export const STREAM_CACHE_GRACE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_STREAM_CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024;

export { EVICTING_ORIGIN };

export type RetentionState = "kept" | "stream" | "prewarm" | "unknown";

export function streamingRetentionEnabled(
  env: { TORRENTFLOW_STREAM_CACHE?: string } = {
    TORRENTFLOW_STREAM_CACHE: process.env.TORRENTFLOW_STREAM_CACHE,
  },
): boolean {
  return env.TORRENTFLOW_STREAM_CACHE !== "off";
}

export function retentionStateForOrigin(origin: string | null | undefined): RetentionState {
  if (origin === STREAM_ORIGIN) return "stream";
  // A row mid-eviction is a stream being torn down — treat it as a stream for
  // every read surface so it stays hidden and shows no "% downloaded".
  if (origin === EVICTING_ORIGIN) return "stream";
  if (origin === PREWARM_ORIGIN) return "prewarm";
  if (origin === USER_ORIGIN) return "kept";
  return "unknown";
}

/**
 * The one classification rule every Play/browse/downloads surface must agree
 * on: only a *kept* download (or a legacy/external row we cannot classify) is a
 * "download". A `stream` is an ephemeral playback cache and a `prewarm` is
 * speculative background work the user never asked to keep — neither is a
 * download, so neither may appear in a downloads list, be counted in download
 * stats, or expose download progress.
 */
export function isDownloadRetention(
  state: RetentionState | null | undefined,
): boolean {
  return state !== "stream" && state !== "prewarm";
}

/**
 * Visible download progress for a live torrent, given its retention state.
 *
 * A stream/prewarm torrent only ever pulls the pieces the player needs, so its
 * whole-file progress is a mechanism detail that would read as "% downloaded"
 * on a Play surface — which the product forbids. This is the single seam that
 * decides whether a "%" may be shown, so every consumer (teaser, browse card,
 * title hero, ready-to-play) agrees rather than each re-deciding.
 *
 * Returns the raw fraction only for a download-retention row; `null` otherwise.
 */
export function visibleDownloadProgress(
  state: RetentionState | null | undefined,
  progress: number | null | undefined,
): number | null {
  if (!isDownloadRetention(state)) return null;
  return progress ?? null;
}

export function releaseInfoHash(input: {
  infoHash?: string | null;
  magnet?: string | null;
}): string | null {
  return (input.infoHash || infoHashFromMagnet(input.magnet ?? "") || "")
    .trim()
    .toLowerCase() || null;
}

export function shouldSendAsStreamOnly(input: {
  enabled?: boolean;
  clientType: string;
  sendTarget?: "primary" | "external";
  watchListItemId?: string | null;
  retention?: "stream" | "keep" | null;
  existingOrigin?: string | null;
}): boolean {
  if (input.enabled === false) return false;
  if (input.clientType !== "builtin") return false;
  if (input.sendTarget === "external") return false;
  if (input.retention === "keep") return false;
  if (input.watchListItemId) return false;
  if (
    input.existingOrigin === USER_ORIGIN ||
    input.existingOrigin === PREWARM_ORIGIN
  ) {
    return false;
  }
  return true;
}

/**
 * Read the origin already stored for a hash, distinguishing three outcomes:
 * `missing` (no row), `found` (with the origin), and `error` (the read threw).
 *
 * `error` is deliberately NOT collapsed into `missing`. A failed read is not
 * evidence that the row is absent, and must never be treated as permission to
 * reclassify or default a send. Callers fail CLOSED on `error`: they leave the
 * row untouched and choose the non-evictable outcome (see the send route and
 * {@link resolveEffectiveAdd}). This is the line that previously let a masked
 * read turn a genuine `user` download into an evictable stream (issue D).
 */
export async function existingRetentionOrigin(
  userId: string,
  hash: string | null,
  opts: { db?: Db } = {},
): Promise<ExistingOriginLookup> {
  if (!hash) return { status: "missing" };
  try {
    const row = await (opts.db ?? prisma).engineTorrent.findUnique({
      where: { userId_hash: { userId, hash } },
      select: { origin: true },
    });
    return row ? { status: "found", origin: row.origin } : { status: "missing" };
  } catch {
    return { status: "error" };
  }
}

/**
 * Label a row as a stream (an evictable playback cache).
 *
 * Guarded to `origin IN [stream, prewarm]` ONLY. It can promote a speculative
 * `prewarm` up to `stream` on Play (issue B), and is idempotent on an existing
 * `stream`, but it can NEVER touch a `user` (kept) row or a fresh/default one.
 * The previous `allowFreshDefaultOrigin` escape hatch — which let a failed
 * origin read (null) demote a genuine `user` download to an evictable stream —
 * is deliberately gone (issue D): classification now happens authoritatively at
 * add time, and this is only a monotonic, non-destructive verification.
 */
export async function markTorrentStreamOnly(
  userId: string,
  hash: string | null,
  opts: { db?: Db } = {},
): Promise<boolean> {
  if (!hash || !streamingRetentionEnabled()) return false;
  try {
    const r = await (opts.db ?? prisma).engineTorrent.updateMany({
      where: {
        userId,
        hash,
        origin: { in: [STREAM_ORIGIN, PREWARM_ORIGIN] },
      },
      data: { origin: STREAM_ORIGIN },
    });
    return r.count > 0;
  } catch {
    return false;
  }
}

/**
 * Promote a row to a kept `user` download.
 *
 * Guarded to `origin IN [stream, prewarm, evicting]` → `user`. Including
 * `prewarm` is issue B (an explicit Download of a speculative prewarm becomes a
 * real download instead of staying hidden/evictable). Including `evicting` is
 * issue D reviewer round 2: an explicit Download STEALS a row a sweep is
 * mid-evicting and clears the lease, so the sweep's re-check aborts before it
 * unlinks — the user's instruction beats the speculative sweep. `user` is never
 * a source, so this can never demote and is safe to call as a verification.
 */
export async function promoteTorrentToKept(
  userId: string,
  hash: string | null,
  opts: { db?: Db } = {},
): Promise<boolean> {
  if (!hash) return false;
  try {
    const r = await (opts.db ?? prisma).engineTorrent.updateMany({
      where: {
        userId,
        hash,
        origin: { in: [STREAM_ORIGIN, PREWARM_ORIGIN, EVICTING_ORIGIN] },
      },
      data: { origin: USER_ORIGIN, evictLease: null, evictFrom: null },
    });
    return r.count > 0;
  } catch {
    return false;
  }
}

export async function promoteLibraryStreamsToKept(
  userId: string,
  library: {
    watchListItemId: string;
    title: string;
    mediaType?: string | null;
  },
  opts: { db?: Db } = {},
): Promise<number> {
  const db = opts.db ?? prisma;
  try {
    const progress = await db.playbackProgress.findMany({
      where: {
        userId,
        OR: [
          { watchListItemId: library.watchListItemId },
          { title: { equals: library.title } },
        ],
      },
      select: { infoHash: true },
    });
    const hashes = [...new Set(progress.map((p) => p.infoHash.toLowerCase()))];
    if (hashes.length === 0) return 0;
    const r = await db.engineTorrent.updateMany({
      where: {
        userId,
        hash: { in: hashes },
        origin: { in: [STREAM_ORIGIN, EVICTING_ORIGIN] },
      },
      data: { origin: USER_ORIGIN, evictLease: null, evictFrom: null },
    });
    return r.count;
  } catch {
    return 0;
  }
}

export function streamCacheSortKey(candidate: {
  completedAt: Date;
  lastUsedAt: Date;
  sizeBytes: number;
  progress: number;
}): [number, number, number, number] {
  return [
    candidate.completedAt.getTime(),
    candidate.lastUsedAt.getTime(),
    -candidate.sizeBytes,
    -candidate.progress,
  ];
}

function compareStreamCandidates(
  a: StreamEvictionCandidate,
  b: StreamEvictionCandidate,
): number {
  const ak = streamCacheSortKey(a);
  const bk = streamCacheSortKey(b);
  for (let i = 0; i < ak.length; i += 1) {
    if (ak[i] !== bk[i]) return ak[i] - bk[i];
  }
  return a.hash.localeCompare(b.hash);
}

export interface StreamEvictionCandidate {
  id: string;
  hash: string;
  name: string;
  origin: string;
  sizeBytes: number;
  progress: number;
  status: string;
  lastUsedAt: Date;
  completedAt: Date;
}

export interface StreamEvictionResult {
  evicted: StreamEvictionCandidate[];
  freedBytes: number;
  budgetBytes: number;
  usedBytes: number;
  satisfied: boolean;
  skipped: Array<{ hash: string; reason: string }>;
}

export async function listEvictableStreams(
  userId: string,
  opts: {
    db?: Db;
    now?: Date;
    graceMs?: number;
    protectHashes?: readonly string[];
  } = {},
): Promise<{
  candidates: StreamEvictionCandidate[];
  skipped: Array<{ hash: string; reason: string }>;
  usedBytes: number;
}> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? STREAM_CACHE_GRACE_MS;
  const protectedHashes = new Set((opts.protectHashes ?? []).map((h) => h.toLowerCase()));
  const fg = foregroundHash();
  if (fg) protectedHashes.add(fg);

  const rows = await db.engineTorrent.findMany({
    where: { userId, origin: STREAM_ORIGIN },
    orderBy: { lastUsedAt: "asc" },
    take: 500,
  });
  const usedBytes = rows.reduce((sum, row) => sum + onDiskBytes(row), 0);
  if (rows.length === 0) return { candidates: [], skipped: [], usedBytes };

  const hashes = rows.map((r) => r.hash);
  const progress = await db.playbackProgress.findMany({
    where: { userId, infoHash: { in: hashes } },
    select: { infoHash: true, completedAt: true, watchListItemId: true },
  });
  const watchlistIds = [
    ...new Set(progress.map((p) => p.watchListItemId).filter((id): id is string => Boolean(id))),
  ];
  const liveWatchlistIds = watchlistIds.length
    ? new Set(
        (
          await db.watchListItem.findMany({
            where: { userId, id: { in: watchlistIds } },
            select: { id: true },
          })
        ).map((i) => i.id),
      )
    : new Set<string>();

  const progressByHash = new Map<string, typeof progress>();
  for (const p of progress) {
    const list = progressByHash.get(p.infoHash) ?? [];
    list.push(p);
    progressByHash.set(p.infoHash, list);
  }

  const skipped: Array<{ hash: string; reason: string }> = [];
  const candidates: StreamEvictionCandidate[] = [];
  for (const row of rows) {
    const hash = row.hash.toLowerCase();
    if (protectedHashes.has(hash)) {
      skipped.push({ hash, reason: "protected" });
      continue;
    }
    const related = progressByHash.get(hash);
    if (!related || related.length === 0) {
      skipped.push({ hash, reason: "indeterminate-progress" });
      continue;
    }
    if (related.some((p) => p.watchListItemId && liveWatchlistIds.has(p.watchListItemId))) {
      skipped.push({ hash, reason: "watchlisted" });
      continue;
    }
    if (related.some((p) => !(p.completedAt instanceof Date))) {
      skipped.push({ hash, reason: "partial" });
      continue;
    }
    const completed = related
      .map((p) => p.completedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!completed) {
      skipped.push({ hash, reason: "indeterminate-progress" });
      continue;
    }
    if (now.getTime() - completed.getTime() < graceMs) {
      skipped.push({ hash, reason: "seeding-grace" });
      continue;
    }
    candidates.push({
      id: row.id,
      hash,
      name: row.name,
      origin: row.origin,
      sizeBytes: Number(row.sizeBytes),
      progress: row.progress,
      status: row.status,
      lastUsedAt: row.lastUsedAt,
      completedAt: completed,
    });
  }

  candidates.sort(compareStreamCandidates);
  return { candidates, skipped, usedBytes };
}

async function deleteViaClient(
  config: ClientConnectionConfig,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient(config.clientType);
  if (!client.deleteTorrent) return { ok: false, message: "Client cannot delete torrents" };
  return client.deleteTorrent(config, hash, true);
}

async function stillSafeToDelete(
  db: Db,
  userId: string,
  hash: string,
  opts: { now: Date; graceMs: number; protectHashes: ReadonlySet<string> },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.protectHashes.has(hash)) return { ok: false, reason: "protected" };
  const row = await db.engineTorrent.findFirst({
    where: { userId, hash },
    select: { origin: true },
  });
  if (!row) return { ok: false, reason: "missing-row" };
  if (row.origin !== STREAM_ORIGIN) return { ok: false, reason: "not-stream" };

  const progress = await db.playbackProgress.findMany({
    where: { userId, infoHash: hash },
    select: { completedAt: true, watchListItemId: true },
  });
  if (progress.length === 0) return { ok: false, reason: "indeterminate-progress" };
  if (progress.some((p) => p.watchListItemId)) {
    const ids = progress.map((p) => p.watchListItemId).filter((id): id is string => Boolean(id));
    const owned = await db.watchListItem.count({ where: { userId, id: { in: ids } } });
    if (owned > 0) return { ok: false, reason: "watchlisted" };
  }
  if (progress.some((p) => !(p.completedAt instanceof Date))) {
    return { ok: false, reason: "partial" };
  }
  const completed = progress
    .map((p) => p.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!completed) return { ok: false, reason: "indeterminate-progress" };
  if (opts.now.getTime() - completed.getTime() < opts.graceMs) {
    return { ok: false, reason: "seeding-grace" };
  }
  return { ok: true };
}

export async function evictStreamCacheForBudget(opts: {
  userId: string;
  config: ClientConnectionConfig;
  budgetBytes?: number;
  protectHashes?: readonly string[];
  now?: Date;
  graceMs?: number;
  db?: Db;
  _deleteFn?: (
    config: ClientConnectionConfig,
    hash: string,
  ) => Promise<{ ok: boolean; message: string }>;
  _beforeDeleteCheck?: (candidate: StreamEvictionCandidate) => Promise<void> | void;
  /** Test seam: fired right after a row is CLAIMED (stream → evicting) and
   * BEFORE the re-check + unlink, to exercise a Download stealing the lease. */
  _afterClaim?: (candidate: StreamEvictionCandidate) => Promise<void> | void;
}): Promise<StreamEvictionResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? STREAM_CACHE_GRACE_MS;
  const budgetBytes = opts.budgetBytes ?? DEFAULT_STREAM_CACHE_BUDGET_BYTES;
  if (!streamingRetentionEnabled()) {
    return {
      evicted: [],
      freedBytes: 0,
      budgetBytes,
      usedBytes: 0,
      satisfied: true,
      skipped: [{ hash: "*", reason: "feature-off" }],
    };
  }
  const protectedHashes = new Set((opts.protectHashes ?? []).map((h) => h.toLowerCase()));
  const fg = foregroundHash();
  if (fg) protectedHashes.add(fg);

  // Reclaim any lease abandoned by a crash (issue D reviewer round 2) BEFORE
  // listing, so a stranded `evicting` row is restored to its recorded origin and
  // becomes a normal candidate again instead of leaking its disk forever.
  await recoverStaleEvictionLeases({ userId: opts.userId, db, now }).catch(() => ({
    recovered: [],
  }));

  const listed = await listEvictableStreams(opts.userId, {
    db,
    now,
    graceMs,
    protectHashes: [...protectedHashes],
  }).catch(() => ({ candidates: [], skipped: [], usedBytes: 0 }));

  const result: StreamEvictionResult = {
    evicted: [],
    freedBytes: 0,
    budgetBytes,
    usedBytes: listed.usedBytes,
    satisfied: listed.usedBytes <= budgetBytes,
    skipped: [...listed.skipped],
  };
  if (listed.usedBytes <= budgetBytes) return result;
  if (opts.config.clientType !== "builtin") {
    result.skipped.push({ hash: "*", reason: "non-builtin-client" });
    return result;
  }

  let remaining = listed.usedBytes;
  const remove = opts._deleteFn ?? deleteViaClient;
  for (const candidate of listed.candidates) {
    if (remaining <= budgetBytes) break;
    if (candidate.origin !== STREAM_ORIGIN) {
      result.skipped.push({ hash: candidate.hash, reason: "not-stream" });
      continue;
    }
    await opts._beforeDeleteCheck?.(candidate);

    const safe = await stillSafeToDelete(db, opts.userId, candidate.hash, {
      now,
      graceMs,
      protectHashes: protectedHashes,
    }).catch(() => ({ ok: false as const, reason: "indeterminate-delete-guard" }));
    if (!safe.ok) {
      result.skipped.push({ hash: candidate.hash, reason: safe.reason });
      continue;
    }

    // ── CLAIM THE ROW BEFORE TOUCHING ANY FILE ──────────────────────────────
    // Atomically move stream → evicting and stamp a lease token. This is the
    // serialization point: if an explicit Download promoted this hash
    // (stream → user) between the safety read above and here, the guard
    // `origin = stream` no longer matches, the claim frees nothing, and we abort
    // WITH THE FILES STILL ON DISK. `evictLease: null` in the guard also prevents
    // re-claiming a row another sweep already leased. The old order (delete
    // files, THEN guard the row delete) could destroy a just-promoted download's
    // bytes before the row guard refused — the precise shape that lost real
    // media. Worst case now is an orphaned file (a recoverable disk leak,
    // reclaimed by lease recovery), never a download with its bytes gone.
    const leaseToken = newEvictLease(now);
    let claimed = 0;
    try {
      const claim = await db.engineTorrent.updateMany({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: STREAM_ORIGIN,
          evictLease: null,
        },
        data: { origin: EVICTING_ORIGIN, evictLease: leaseToken, evictFrom: STREAM_ORIGIN },
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
      // Someone promoted or already evicted it. Files are untouched — safe.
      result.skipped.push({ hash: candidate.hash, reason: "db-guard-refused" });
      continue;
    }

    await opts._afterClaim?.(candidate);

    // RE-CHECK UNDER THE LEASE, immediately before unlink. A Download that
    // arrived after our claim STEALS the lease (evicting → user, clearing the
    // token). If our exact token no longer owns the row, the user won the race:
    // abort with the files intact. This is the enforcement point that makes an
    // explicit Download beat a speculative sweep (issue D reviewer round 2).
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
      stillOwn = false; // fail closed: if we cannot prove we own it, do not delete
    }
    if (!stillOwn) {
      result.skipped.push({ hash: candidate.hash, reason: "lease-stolen" });
      continue;
    }

    // The lease is exclusively ours (origin = evicting, token matches). Delete
    // the files. The client's own delete removes the leased row on success; on
    // any failure we roll the lease back to `stream` so the row is neither lost
    // nor stuck hidden — it simply becomes eligible again on a later sweep.
    let deletedOk = false;
    try {
      const deleted = await remove(opts.config, candidate.hash);
      deletedOk = deleted.ok;
      if (!deleted.ok) {
        result.skipped.push({
          hash: candidate.hash,
          reason: `client-refused: ${deleted.message}`,
        });
      }
    } catch (err) {
      result.skipped.push({
        hash: candidate.hash,
        reason: `client-error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!deletedOk) {
      // Roll the lease back so the row returns to an evictable stream instead of
      // being stranded in `evicting`. Guarded on OUR token so we never clobber a
      // steal that landed in the meantime.
      try {
        await db.engineTorrent.updateMany({
          where: {
            userId: opts.userId,
            hash: candidate.hash,
            origin: EVICTING_ORIGIN,
            evictLease: leaseToken,
          },
          data: { origin: STREAM_ORIGIN, evictLease: null, evictFrom: null },
        });
      } catch {
        /* best-effort: a stranded evicting row reads as a hidden stream, not a download */
      }
      continue;
    }

    // Defensive: ensure the leased row is gone even if the client did not remove
    // it (e.g. a delete path that keeps rows). Guarded to our exact lease so we
    // only ever delete the row we ourselves claimed and still own.
    try {
      await db.engineTorrent.deleteMany({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: EVICTING_ORIGIN,
          evictLease: leaseToken,
        },
      });
    } catch {
      /* best-effort */
    }

    result.evicted.push(candidate);
    const bytes = onDiskBytes(candidate);
    result.freedBytes += bytes;
    remaining -= bytes;
    resetDirectorySizeCache();
  }

  result.satisfied = remaining <= budgetBytes;
  return result;
}
