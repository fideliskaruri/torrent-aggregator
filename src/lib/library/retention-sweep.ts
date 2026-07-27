import prisma from "@/lib/prisma";
import { getClient } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import {
  DEFAULT_STREAM_CACHE_BUDGET_BYTES,
  STREAM_CACHE_GRACE_MS,
  STREAM_ORIGIN,
} from "@/lib/streaming/retention";
import {
  foregroundActive,
  foregroundHash,
} from "@/lib/prewarm/foreground";
import {
  RETENTION_POLICY_EPHEMERAL,
  type RetentionPolicy,
  isSafeToEvictEphemeral,
  retentionPolicyForOrigin,
} from "./retention-settings";

type Db = typeof prisma;

const MAX_SCAN = 500;
const DOWNLOADING_STATUSES = new Set(["downloading", "metadata", "queued"]);

export type RetentionSweepMode = "preview" | "delete";

export interface RetentionSweepCandidate {
  id: string;
  hash: string;
  name: string;
  origin: string;
  retentionPolicy: RetentionPolicy;
  sizeBytes: number;
  onDiskBytes: number;
  progress: number;
  status: string;
  lastUsedAt: Date;
  completedAt: Date;
  fullyWatched: boolean;
}

export interface RetentionSweepResult {
  mode: RetentionSweepMode;
  budgetBytes: number;
  usedBytes: number;
  targetBytes: number;
  reclaimedBytes: number;
  satisfied: boolean;
  scanned: number;
  wouldDelete: RetentionSweepCandidate[];
  deleted: RetentionSweepCandidate[];
  skipped: Array<{ hash: string; reason: string; name?: string }>;
}

export interface RetentionSweepOptions {
  userId: string;
  config: ClientConnectionConfig;
  mode?: RetentionSweepMode;
  budgetBytes?: number;
  now?: Date;
  graceMs?: number;
  protectHashes?: readonly string[];
  db?: Db;
  _deleteFn?: (
    config: ClientConnectionConfig,
    hash: string,
  ) => Promise<{ ok: boolean; message: string }>;
  _foreground?: {
    active: () => boolean;
    hash: () => string | null;
  };
  _beforeDeleteCheck?: (candidate: RetentionSweepCandidate) => Promise<void> | void;
}

function norm(hash: string | null | undefined): string | null {
  const h = String(hash ?? "").trim().toLowerCase();
  return h || null;
}

function onDiskBytes(row: { sizeBytes: bigint | number; progress: number }): number {
  const raw = typeof row.sizeBytes === "bigint" ? Number(row.sizeBytes) : row.sizeBytes;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const progress = Number.isFinite(row.progress)
    ? Math.min(1, Math.max(0, row.progress))
    : 0;
  return Math.round(raw * progress);
}

function isDownloading(row: { status: string; progress: number }): boolean {
  return DOWNLOADING_STATUSES.has(row.status.toLowerCase()) || row.progress < 1;
}

function compareCandidates(
  a: RetentionSweepCandidate,
  b: RetentionSweepCandidate,
): number {
  if (a.fullyWatched !== b.fullyWatched) return a.fullyWatched ? -1 : 1;
  const completed = a.completedAt.getTime() - b.completedAt.getTime();
  if (completed !== 0) return completed;
  const lastUsed = a.lastUsedAt.getTime() - b.lastUsedAt.getTime();
  if (lastUsed !== 0) return lastUsed;
  return b.onDiskBytes - a.onDiskBytes || a.hash.localeCompare(b.hash);
}

async function deleteViaClient(
  config: ClientConnectionConfig,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient(config.clientType);
  if (!client.deleteTorrent) {
    return { ok: false, message: "Client cannot delete torrents" };
  }
  return client.deleteTorrent(config, hash, true);
}

async function watchlistReferences(
  db: Db,
  userId: string,
  input: {
    progress: Array<{ watchListItemId: string | null; title: string }>;
    rowName: string;
  },
): Promise<"referenced" | "unreferenced" | "indeterminate"> {
  try {
    const ids = [
      ...new Set(
        input.progress
          .map((p) => p.watchListItemId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const titles = [
      ...new Set(
        [input.rowName, ...input.progress.map((p) => p.title)]
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0 && titles.length === 0) return "indeterminate";

    const count = await db.watchListItem.count({
      where: {
        userId,
        OR: [
          ...(ids.length ? [{ id: { in: ids } }] : []),
          ...(titles.length ? [{ title: { in: titles } }] : []),
        ],
      },
    });
    return count > 0 ? "referenced" : "unreferenced";
  } catch {
    return "indeterminate";
  }
}

async function stillSafeToDelete(
  db: Db,
  userId: string,
  hash: string,
  opts: {
    now: Date;
    graceMs: number;
    protectHashes: ReadonlySet<string>;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.protectHashes.has(hash)) return { ok: false, reason: "streaming" };

  const row = await db.engineTorrent.findFirst({
    where: { userId, hash },
    select: {
      origin: true,
      status: true,
      progress: true,
      name: true,
    },
  });
  if (!row) return { ok: false, reason: "missing-row" };

  // Destructive paths use the strict origin mapping, never resolveRetentionPolicy:
  // unknown origin must stay indeterminate, not fall through to the user's default.
  const policy = retentionPolicyForOrigin(row.origin);
  if (policy !== RETENTION_POLICY_EPHEMERAL) {
    return { ok: false, reason: policy ? "kept" : "indeterminate-retention" };
  }
  if (isDownloading(row)) return { ok: false, reason: "downloading" };

  const progress = await db.playbackProgress.findMany({
    where: { userId, infoHash: hash },
    select: {
      completedAt: true,
      watchListItemId: true,
      title: true,
    },
  });
  if (progress.length === 0) return { ok: false, reason: "indeterminate-progress" };

  const refs = await watchlistReferences(db, userId, {
    progress,
    rowName: row.name,
  });
  if (refs === "referenced") return { ok: false, reason: "watchlisted" };
  if (refs === "indeterminate") return { ok: false, reason: "indeterminate-reference" };

  if (progress.some((p) => !(p.completedAt instanceof Date))) {
    return { ok: false, reason: "partial" };
  }
  const completed = progress
    .map((p) => p.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!completed) return { ok: false, reason: "indeterminate-progress" };

  const safe = isSafeToEvictEphemeral({
    retentionPolicy: policy,
    hasProgressRow: true,
    completedAt: completed,
    referencedByWatchlist: false,
    now: opts.now,
    graceMs: opts.graceMs,
  });
  return safe ? { ok: true } : { ok: false, reason: "seeding-grace" };
}

export async function listRetentionSweepCandidates(
  opts: Omit<RetentionSweepOptions, "config" | "mode" | "_deleteFn" | "_beforeDeleteCheck">,
): Promise<{
  candidates: RetentionSweepCandidate[];
  skipped: Array<{ hash: string; reason: string; name?: string }>;
  usedBytes: number;
  scanned: number;
}> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? STREAM_CACHE_GRACE_MS;
  const protectedHashes = new Set(
    (opts.protectHashes ?? []).map((h) => norm(h)).filter((h): h is string => Boolean(h)),
  );
  const fgHash = norm((opts._foreground?.hash ?? foregroundHash)());
  if (fgHash) protectedHashes.add(fgHash);

  let rows: Awaited<ReturnType<typeof db.engineTorrent.findMany>>;
  try {
    rows = await db.engineTorrent.findMany({
      where: { userId: opts.userId, status: { not: "removed" } },
      orderBy: { lastUsedAt: "asc" },
      take: MAX_SCAN,
    });
  } catch {
    return {
      candidates: [],
      skipped: [{ hash: "*", reason: "indeterminate-engine-read" }],
      usedBytes: 0,
      scanned: 0,
    };
  }

  const usedBytes = rows.reduce((sum, row) => {
    const policy = retentionPolicyForOrigin(row.origin);
    return policy === RETENTION_POLICY_EPHEMERAL ? sum + onDiskBytes(row) : sum;
  }, 0);

  const skipped: Array<{ hash: string; reason: string; name?: string }> = [];
  const candidates: RetentionSweepCandidate[] = [];

  for (const row of rows) {
    const hash = norm(row.hash);
    if (!hash) {
      skipped.push({ hash: "*", reason: "indeterminate-hash", name: row.name });
      continue;
    }

    // Same strict check as the delete guard: unknown is not EPHEMERAL here.
    const policy = retentionPolicyForOrigin(row.origin);
    if (policy !== RETENTION_POLICY_EPHEMERAL) {
      skipped.push({ hash, reason: policy ? "kept" : "indeterminate-retention", name: row.name });
      continue;
    }
    if (protectedHashes.has(hash)) {
      skipped.push({ hash, reason: "streaming", name: row.name });
      continue;
    }
    if (isDownloading(row)) {
      skipped.push({ hash, reason: "downloading", name: row.name });
      continue;
    }

    let progress: Array<{
      completedAt: Date | null;
      watchListItemId: string | null;
      title: string;
    }>;
    try {
      progress = await db.playbackProgress.findMany({
        where: { userId: opts.userId, infoHash: hash },
        select: { completedAt: true, watchListItemId: true, title: true },
      });
    } catch {
      skipped.push({ hash, reason: "indeterminate-progress", name: row.name });
      continue;
    }
    if (progress.length === 0) {
      skipped.push({ hash, reason: "indeterminate-progress", name: row.name });
      continue;
    }

    const refs = await watchlistReferences(db, opts.userId, {
      progress,
      rowName: row.name,
    });
    if (refs === "referenced") {
      skipped.push({ hash, reason: "watchlisted", name: row.name });
      continue;
    }
    if (refs === "indeterminate") {
      skipped.push({ hash, reason: "indeterminate-reference", name: row.name });
      continue;
    }

    if (progress.some((p) => !(p.completedAt instanceof Date))) {
      skipped.push({ hash, reason: "partial", name: row.name });
      continue;
    }
    const completed = progress
      .map((p) => p.completedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!completed) {
      skipped.push({ hash, reason: "indeterminate-progress", name: row.name });
      continue;
    }
    if (
      !isSafeToEvictEphemeral({
        retentionPolicy: policy,
        hasProgressRow: true,
        completedAt: completed,
        referencedByWatchlist: false,
        now,
        graceMs,
      })
    ) {
      skipped.push({ hash, reason: "seeding-grace", name: row.name });
      continue;
    }

    candidates.push({
      id: row.id,
      hash,
      name: row.name,
      origin: row.origin,
      retentionPolicy: policy,
      sizeBytes: Number(row.sizeBytes),
      onDiskBytes: onDiskBytes(row),
      progress: row.progress,
      status: row.status,
      lastUsedAt: row.lastUsedAt,
      completedAt: completed,
      fullyWatched: true,
    });
  }

  candidates.sort(compareCandidates);
  return { candidates, skipped, usedBytes, scanned: rows.length };
}

export async function sweepRetentionCache(
  opts: RetentionSweepOptions,
): Promise<RetentionSweepResult> {
  const db = opts.db ?? prisma;
  const mode = opts.mode ?? "preview";
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? STREAM_CACHE_GRACE_MS;
  const budgetBytes = opts.budgetBytes ?? DEFAULT_STREAM_CACHE_BUDGET_BYTES;
  const protectedHashes = new Set(
    (opts.protectHashes ?? []).map((h) => norm(h)).filter((h): h is string => Boolean(h)),
  );
  const foreground = opts._foreground ?? {
    active: () => foregroundActive(),
    hash: () => foregroundHash(),
  };
  const fgHash = norm(foreground.hash());
  if (fgHash) protectedHashes.add(fgHash);

  const listed = await listRetentionSweepCandidates({
    userId: opts.userId,
    db,
    now,
    graceMs,
    protectHashes: [...protectedHashes],
    _foreground: foreground,
  });

  const result: RetentionSweepResult = {
    mode,
    budgetBytes,
    usedBytes: listed.usedBytes,
    targetBytes: Math.max(0, listed.usedBytes - budgetBytes),
    reclaimedBytes: 0,
    satisfied: listed.usedBytes <= budgetBytes,
    scanned: listed.scanned,
    wouldDelete: [],
    deleted: [],
    skipped: [...listed.skipped],
  };

  if (listed.usedBytes <= budgetBytes) return result;
  if (foreground.active() && !fgHash) {
    result.skipped.push({ hash: "*", reason: "streaming-indeterminate" });
    return result;
  }
  if (opts.config.clientType !== "builtin") {
    result.skipped.push({ hash: "*", reason: "non-builtin-client" });
    return result;
  }

  let remaining = listed.usedBytes;
  const remove = opts._deleteFn ?? deleteViaClient;
  for (const candidate of listed.candidates) {
    if (remaining <= budgetBytes) break;
    result.wouldDelete.push(candidate);
    result.reclaimedBytes += candidate.onDiskBytes;

    if (mode === "preview") {
      remaining -= candidate.onDiskBytes;
      continue;
    }

    await opts._beforeDeleteCheck?.(candidate);
    const liveForegroundHash = norm(foreground.hash());
    if (liveForegroundHash === candidate.hash) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: "streaming", name: candidate.name });
      continue;
    }
    if (foreground.active() && !liveForegroundHash) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({
        hash: candidate.hash,
        reason: "streaming-indeterminate",
        name: candidate.name,
      });
      continue;
    }

    const safe = await stillSafeToDelete(db, opts.userId, candidate.hash, {
      now,
      graceMs,
      protectHashes: protectedHashes,
    }).catch(() => ({ ok: false as const, reason: "indeterminate-delete-guard" }));
    if (!safe.ok) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: safe.reason, name: candidate.name });
      continue;
    }

    const finalForegroundHash = norm(foreground.hash());
    if (finalForegroundHash === candidate.hash) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: "streaming", name: candidate.name });
      continue;
    }
    if (foreground.active() && !finalForegroundHash) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({
        hash: candidate.hash,
        reason: "streaming-indeterminate",
        name: candidate.name,
      });
      continue;
    }

    try {
      const deleted = await remove(opts.config, candidate.hash);
      if (!deleted.ok) {
        result.reclaimedBytes -= candidate.onDiskBytes;
        result.skipped.push({
          hash: candidate.hash,
          reason: `client-refused: ${deleted.message}`,
          name: candidate.name,
        });
        continue;
      }
    } catch (err) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({
        hash: candidate.hash,
        reason: `client-error: ${err instanceof Error ? err.message : String(err)}`,
        name: candidate.name,
      });
      continue;
    }

    const row = await db.engineTorrent.deleteMany({
      where: {
        userId: opts.userId,
        hash: candidate.hash,
        origin: STREAM_ORIGIN,
        status: { not: "downloading" },
        progress: { gte: 1 },
      },
    });
    if (row.count === 0) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: "db-guard-refused", name: candidate.name });
      continue;
    }

    result.deleted.push(candidate);
    remaining -= candidate.onDiskBytes;
    resetDirectorySizeCache();
  }

  result.satisfied = remaining <= budgetBytes;
  if (mode === "preview") {
    result.satisfied = listed.usedBytes - result.reclaimedBytes <= budgetBytes;
  }
  return result;
}
