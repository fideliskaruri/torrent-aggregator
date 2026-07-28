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
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { onDiskBytes } from "@/lib/prewarm/eviction";
import { PREWARM_ORIGIN, STREAM_ORIGIN, USER_ORIGIN } from "@/lib/prewarm/types";
import { infoHashFromMagnet } from "@/lib/torrents/infohash";
import { foregroundHash } from "@/lib/prewarm/foreground";

type Db = typeof prisma;

export { STREAM_ORIGIN };
export const STREAM_CACHE_GRACE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_STREAM_CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024;

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

export async function existingRetentionOrigin(
  userId: string,
  hash: string | null,
  opts: { db?: Db } = {},
): Promise<string | null> {
  if (!hash) return null;
  try {
    const row = await (opts.db ?? prisma).engineTorrent.findUnique({
      where: { userId_hash: { userId, hash } },
      select: { origin: true },
    });
    return row?.origin ?? null;
  } catch {
    return null;
  }
}

export async function markTorrentStreamOnly(
  userId: string,
  hash: string | null,
  opts: { db?: Db; allowFreshDefaultOrigin?: boolean } = {},
): Promise<boolean> {
  if (!hash || !streamingRetentionEnabled()) return false;
  try {
    const r = await (opts.db ?? prisma).engineTorrent.updateMany({
      where: {
        userId,
        hash,
        origin: opts.allowFreshDefaultOrigin
          ? { not: PREWARM_ORIGIN }
          : { notIn: [USER_ORIGIN, PREWARM_ORIGIN] },
      },
      data: { origin: STREAM_ORIGIN },
    });
    return r.count > 0;
  } catch {
    return false;
  }
}

export async function promoteTorrentToKept(
  userId: string,
  hash: string | null,
  opts: { db?: Db } = {},
): Promise<boolean> {
  if (!hash) return false;
  try {
    const r = await (opts.db ?? prisma).engineTorrent.updateMany({
      where: { userId, hash, origin: STREAM_ORIGIN },
      data: { origin: USER_ORIGIN },
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
      where: { userId, hash: { in: hashes }, origin: STREAM_ORIGIN },
      data: { origin: USER_ORIGIN },
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

    try {
      const deleted = await remove(opts.config, candidate.hash);
      if (!deleted.ok) {
        result.skipped.push({
          hash: candidate.hash,
          reason: `client-refused: ${deleted.message}`,
        });
        continue;
      }
    } catch (err) {
      result.skipped.push({
        hash: candidate.hash,
        reason: `client-error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const row = await db.engineTorrent.deleteMany({
      where: { userId: opts.userId, hash: candidate.hash, origin: STREAM_ORIGIN },
    });
    if (row.count === 0) {
      result.skipped.push({ hash: candidate.hash, reason: "db-guard-refused" });
      continue;
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
