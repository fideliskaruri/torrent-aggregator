import prisma from "@/lib/prisma";
import { getClient } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { resetDirectorySizeCache } from "@/lib/library/disk-space";
import { resetDiskInventoryCache } from "@/lib/library/disk-inventory";
import {
  EVICTING_ORIGIN,
  STREAM_CACHE_GRACE_MS,
  STREAM_ORIGIN,
  streamCacheBudgetForStorageCap,
} from "@/lib/streaming/retention";
import {
  foregroundActive,
  foregroundHash,
} from "@/lib/prewarm/foreground";
import { newEvictLease, recoverStaleEvictionLeases } from "@/lib/streaming/evict-lease";
import {
  RETENTION_POLICY_EPHEMERAL,
  type RetentionPolicy,
  isSafeToEvictEphemeral,
  retentionPolicyForOrigin,
} from "./retention-settings";

type Db = typeof prisma;

const MAX_SCAN = 500;
const DOWNLOADING_STATUSES = new Set(["downloading", "metadata", "queued"]);

/**
 * How long a row must have been observed delivering nothing before "it is still
 * downloading" stops being a defensible claim. Below this age the answer is
 * `unknown`, never `stalled` — a torrent that started two minutes ago has not
 * had a chance yet.
 */
export const STALL_AFTER_MS = 2 * 60 * 60 * 1000;

/** Fraction of the file below which nothing meaningful has been delivered. */
export const STALL_PROGRESS_MAX = 0.01;

/**
 * Delivery rate below which the transfer is not delivering in any useful sense
 * (32 KB/s — two orders of magnitude under the slowest watchable bitrate).
 */
export const STALL_MIN_DELIVERY_BPS = 32 * 1024;

export interface StallThresholds {
  stallAfterMs?: number;
  stallProgressMax?: number;
  minDeliveryBps?: number;
}

/** What a transfer is doing, as far as the recorded facts can say. */
export type TransferState = "complete" | "progressing" | "stalled" | "unknown";

/** The measured facts a {@link classifyTransfer} verdict is derived from. */
export interface TransferFacts {
  /** 0–1 fraction of the torrent the engine reports as downloaded. */
  progress: number;
  /** Full length of the torrent, bytes (the allocation it is holding). */
  sizeBytes: number;
  /** How long this row has existed — the observation window, ms. */
  observedForMs: number | null;
  /** How long since playback last touched this row, ms. */
  idleForMs: number | null;
}

/**
 * Is this transfer dead weight, or is it working?
 *
 * Same discipline as `torrents/swarm-probe.ts`: **`unknown` is not `stalled`**.
 * A negative verdict is a claim, and a wrong one deletes a preallocated file
 * that was about to fill, so it requires evidence — never a bare timer:
 *
 *  1. **complete** — nothing to decide.
 *  2. **progressing** — the fraction shows meaningful delivery. We cannot prove
 *     a transfer that has delivered real bytes has since stopped, so it is
 *     never dead weight.
 *  3. **unknown** — the observation window is too short, the row was touched
 *     recently, or a timestamp is missing. Absence of evidence.
 *  4. **progressing** (again) — slow but real: bytes actually arrived at a rate
 *     above the floor. A big file at 0.5% over two hours is still moving.
 *  5. **stalled** — observed for hours, untouched for hours, and delivered
 *     effectively nothing the whole time. Only this earns reclamation.
 *
 * This is why the live install deadlocked: eight torrents sat at `progress: 0`
 * while `progress < 1` alone counted as "downloading", so every row was
 * untouchable, the cache could never be reclaimed, and every Play was refused.
 */
export function classifyTransfer(
  facts: TransferFacts,
  thresholds: StallThresholds = {},
): TransferState {
  const stallAfterMs = thresholds.stallAfterMs ?? STALL_AFTER_MS;
  const stallProgressMax = thresholds.stallProgressMax ?? STALL_PROGRESS_MAX;
  const minDeliveryBps = thresholds.minDeliveryBps ?? STALL_MIN_DELIVERY_BPS;

  const progress = Number.isFinite(facts.progress) ? facts.progress : 0;
  if (progress >= 1) return "complete";
  if (progress > stallProgressMax) return "progressing";

  const observed = facts.observedForMs;
  const idle = facts.idleForMs;
  if (observed == null || !Number.isFinite(observed)) return "unknown";
  if (idle == null || !Number.isFinite(idle)) return "unknown";
  if (observed < stallAfterMs) return "unknown";
  if (idle < stallAfterMs) return "unknown";

  const size = Number.isFinite(facts.sizeBytes) && facts.sizeBytes > 0 ? facts.sizeBytes : 0;
  const deliveredBps = (size * Math.max(0, progress)) / (observed / 1000);
  if (deliveredBps >= minDeliveryBps) return "progressing";

  return "stalled";
}

function transferFactsFor(
  row: {
    progress: number;
    sizeBytes: bigint | number;
    createdAt?: Date | null;
    lastUsedAt?: Date | null;
  },
  now: Date,
): TransferFacts {
  const size = typeof row.sizeBytes === "bigint" ? Number(row.sizeBytes) : row.sizeBytes;
  return {
    progress: row.progress,
    sizeBytes: size,
    observedForMs:
      row.createdAt instanceof Date ? now.getTime() - row.createdAt.getTime() : null,
    idleForMs:
      row.lastUsedAt instanceof Date ? now.getTime() - row.lastUsedAt.getTime() : null,
  };
}

export type RetentionSweepMode = "preview" | "delete";

/**
 * Why a row may be reclaimed.
 *
 * - `watched` — a finished stream the viewer completed and the grace elapsed.
 * - `stalled` — a preallocated file that has delivered nothing for hours. It
 *   holds its whole size on disk and contains nothing anybody can watch.
 */
export type RetentionSweepKind = "watched" | "stalled";

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
  kind: RetentionSweepKind;
  lastUsedAt: Date;
  /** Null for a `stalled` candidate — nothing was ever watched to completion. */
  completedAt: Date | null;
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
  /** Test seam: override the stall thresholds so a table can drive the rule. */
  stall?: StallThresholds;
  _deleteFn?: (
    config: ClientConnectionConfig,
    hash: string,
  ) => Promise<{ ok: boolean; message: string }>;
  _foreground?: {
    active: () => boolean;
    hash: () => string | null;
  };
  _beforeDeleteCheck?: (candidate: RetentionSweepCandidate) => Promise<void> | void;
  /**
   * Test seam: fires AFTER the safety read has passed but BEFORE the claim CAS,
   * i.e. inside the exact window in which an explicit Download can promote a
   * `stream` row to `user`. Used to prove the claim lease — not merely the
   * earlier safety read — refuses to delete a just-promoted download's files.
   */
  _beforeClaim?: (candidate: RetentionSweepCandidate) => Promise<void> | void;
  /**
   * Test seam: fires AFTER the claim CAS has leased the row (stream → evicting)
   * but BEFORE the re-check + unlink, i.e. inside the window in which an explicit
   * Download STEALS the lease (evicting → user). Used to prove the re-check under
   * the lease aborts the delete and keeps the files.
   */
  _afterClaim?: (candidate: RetentionSweepCandidate) => Promise<void> | void;
}

function norm(hash: string | null | undefined): string | null {
  const h = String(hash ?? "").trim().toLowerCase();
  return h || null;
}

/**
 * Bytes this row actually occupies on disk.
 *
 * **Allocated size, not progress-weighted size.** The engine creates each file
 * at its full length before the network has delivered it, so a torrent at 1%
 * already occupies (near) its whole size. Weighting by progress was measured
 * to under-report badly: the live install reported a 27.6 GB stream cache
 * against 41.6 GB actually on disk, and a single 1.9 GB release sitting at
 * 0.013% progress was holding 1,295 MB. That gap is why the cache ran ~28%
 * over its own budget with nothing being reclaimed.
 *
 * Over-counting is the safe direction for a budget: the worst case is
 * reclaiming a little earlier than strictly necessary, whereas under-counting
 * silently lets the cache grow past the cap the user set — which is the bug
 * this replaces. Deleting the row frees the whole allocation, so the same
 * figure is the right one to credit back when reclaiming.
 */
function onDiskBytes(row: { sizeBytes: bigint | number; progress: number }): number {
  const raw = typeof row.sizeBytes === "bigint" ? Number(row.sizeBytes) : row.sizeBytes;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw);
}

function isDownloading(row: { status: string; progress: number }): boolean {
  return DOWNLOADING_STATUSES.has(row.status.toLowerCase()) || row.progress < 1;
}

/**
 * The transfer gate: may this row be considered at all, and on which footing?
 *
 * `isDownloading` alone was the deadlock. It answered "yes, downloading" for
 * every row below 100%, which permanently protected files that were delivering
 * nothing. A *stalled* row is not actively downloading — it is an allocation
 * with no content — so it passes the gate as a `stalled` candidate, which the
 * later guards then judge on its own terms.
 */
function transferGate(
  row: {
    status: string;
    progress: number;
    sizeBytes: bigint | number;
    createdAt?: Date | null;
    lastUsedAt?: Date | null;
  },
  now: Date,
  thresholds: StallThresholds,
): { ok: true; kind: RetentionSweepKind } | { ok: false; reason: string } {
  const state = classifyTransfer(transferFactsFor(row, now), thresholds);
  if (state === "stalled") return { ok: true, kind: "stalled" };
  if (isDownloading(row)) return { ok: false, reason: "downloading" };
  return { ok: true, kind: "watched" };
}

/**
 * Delete order. A `stalled` allocation goes first: it holds its full size and
 * contains nothing the viewer could ever watch, so reclaiming it costs the user
 * strictly less than reclaiming a finished file they may want to rewatch.
 */
function compareCandidates(
  a: RetentionSweepCandidate,
  b: RetentionSweepCandidate,
): number {
  if (a.kind !== b.kind) return a.kind === "stalled" ? -1 : 1;
  if (a.fullyWatched !== b.fullyWatched) return a.fullyWatched ? -1 : 1;
  const completed =
    (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0);
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
    stall: StallThresholds;
  },
): Promise<{ ok: true; kind: RetentionSweepKind } | { ok: false; reason: string }> {
  if (opts.protectHashes.has(hash)) return { ok: false, reason: "streaming" };

  const row = await db.engineTorrent.findFirst({
    where: { userId, hash },
    select: {
      origin: true,
      status: true,
      progress: true,
      name: true,
      sizeBytes: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  if (!row) return { ok: false, reason: "missing-row" };

  // Destructive paths use the strict origin mapping, never resolveRetentionPolicy:
  // unknown origin must stay indeterminate, not fall through to the user's default.
  const policy = retentionPolicyForOrigin(row.origin);
  if (policy !== RETENTION_POLICY_EPHEMERAL) {
    return { ok: false, reason: policy ? "kept" : "indeterminate-retention" };
  }
  const gate = transferGate(row, opts.now, opts.stall);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const progress = await db.playbackProgress.findMany({
    where: { userId, infoHash: hash },
    select: {
      completedAt: true,
      watchListItemId: true,
      title: true,
    },
  });
  // A stalled allocation the viewer never opened has no playback row, and that
  // absence is the *reason* it is reclaimable, not a reason to bail out.
  if (progress.length === 0 && gate.kind !== "stalled") {
    return { ok: false, reason: "indeterminate-progress" };
  }

  const refs = await watchlistReferences(db, userId, {
    progress,
    rowName: row.name,
  });
  if (refs === "referenced") return { ok: false, reason: "watchlisted" };
  if (refs === "indeterminate") return { ok: false, reason: "indeterminate-reference" };

  // An unfinished watch position is an intention to come back, whatever the
  // transfer is doing. This is what keeps "Resume at 24:28" safe.
  if (progress.some((p) => !(p.completedAt instanceof Date))) {
    return { ok: false, reason: "partial" };
  }
  const completed = progress
    .map((p) => p.completedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!completed) {
    return gate.kind === "stalled"
      ? { ok: true, kind: gate.kind }
      : { ok: false, reason: "indeterminate-progress" };
  }

  const safe = isSafeToEvictEphemeral({
    retentionPolicy: policy,
    hasProgressRow: true,
    completedAt: completed,
    referencedByWatchlist: false,
    now: opts.now,
    graceMs: opts.graceMs,
  });
  return safe ? { ok: true, kind: gate.kind } : { ok: false, reason: "seeding-grace" };
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
  const stall = opts.stall ?? {};
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
    const gate = transferGate(row, now, stall);
    if (!gate.ok) {
      skipped.push({ hash, reason: gate.reason, name: row.name });
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
    // No playback row is fatal for a "watched" reclaim (we cannot show the
    // viewer finished with it) and expected for a "stalled" one (there was
    // never anything to play).
    if (progress.length === 0 && gate.kind !== "stalled") {
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
    if (!completed && gate.kind !== "stalled") {
      skipped.push({ hash, reason: "indeterminate-progress", name: row.name });
      continue;
    }
    if (
      completed &&
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
      kind: gate.kind,
      lastUsedAt: row.lastUsedAt,
      completedAt: completed ?? null,
      fullyWatched: completed != null,
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
  const stall = opts.stall ?? {};
  // `0` is a legitimate target ("reclaim everything reclaimable"), so only an
  // absent/invalid value falls back to the configured stream-cache budget.
  const configuredBudget =
    opts.budgetBytes != null &&
    Number.isFinite(opts.budgetBytes) &&
    opts.budgetBytes >= 0
      ? opts.budgetBytes
      : streamCacheBudgetForStorageCap(opts.config.maxStorageBytes);
  if (configuredBudget == null) {
    return {
      mode,
      budgetBytes: 0,
      usedBytes: 0,
      targetBytes: 0,
      reclaimedBytes: 0,
      satisfied: false,
      scanned: 0,
      wouldDelete: [],
      deleted: [],
      skipped: [{ hash: "*", reason: "unconfigured-storage-cap" }],
    };
  }
  const budgetBytes = configuredBudget;
  const protectedHashes = new Set(
    (opts.protectHashes ?? []).map((h) => norm(h)).filter((h): h is string => Boolean(h)),
  );
  const foreground = opts._foreground ?? {
    active: () => foregroundActive(),
    hash: () => foregroundHash(),
  };
  const fgHash = norm(foreground.hash());
  if (fgHash) protectedHashes.add(fgHash);

  // Reclaim any lease abandoned by a crash (issue D reviewer round 2) BEFORE
  // listing, so a stranded `evicting` row is restored to its recorded origin
  // rather than leaking its disk forever.
  await recoverStaleEvictionLeases({ userId: opts.userId, db, now }).catch(() => ({
    recovered: [],
  }));

  const listed = await listRetentionSweepCandidates({
    userId: opts.userId,
    db,
    now,
    graceMs,
    stall,
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
      stall,
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

    // ── CLAIM THE ROW BEFORE TOUCHING ANY FILE (issue D) ────────────────────
    // Atomically lease stream → evicting under the exact guard that used to gate
    // the row delete, stamping a token. If an explicit Download promoted this
    // hash (stream → user) between the safety read above and now, the guard no
    // longer matches, the claim frees nothing, and we abort WITH THE FILES STILL
    // ON DISK. `evictLease: null` also stops us re-claiming a row another sweep
    // already leased. The old order (delete files, then guard the row delete)
    // could destroy a just-promoted download's bytes before the row guard
    // refused — the exact check-then-delete race that previously lost real media.
    // Worst case now is an orphaned file (reclaimed by lease recovery), never a
    // lost download.
    await opts._beforeClaim?.(candidate);
    const leaseToken = newEvictLease(now);
    // The claim guard mirrors the reason this row is reclaimable. A `watched`
    // row must still be complete and not downloading. A `stalled` row is
    // claimed on the fact that made it dead weight — it has delivered
    // (effectively) nothing — so the guard pins its progress instead: if bytes
    // started arriving between listing and now, the claim frees nothing and we
    // abort with the file intact. `origin: STREAM_ORIGIN` remains the guard
    // that lets an explicit Download beat the sweep in either case.
    const stallProgressMax = stall.stallProgressMax ?? STALL_PROGRESS_MAX;
    const transferGuardWhere =
      safe.kind === "stalled"
        ? { progress: { lte: stallProgressMax } }
        : { status: { not: "downloading" }, progress: { gte: 1 } };
    let claimed = 0;
    try {
      const claim = await db.engineTorrent.updateMany({
        where: {
          userId: opts.userId,
          hash: candidate.hash,
          origin: STREAM_ORIGIN,
          evictLease: null,
          ...transferGuardWhere,
        },
        data: { origin: EVICTING_ORIGIN, evictLease: leaseToken, evictFrom: STREAM_ORIGIN },
      });
      claimed = claim.count;
    } catch (err) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({
        hash: candidate.hash,
        reason: `db-claim-error: ${err instanceof Error ? err.message : String(err)}`,
        name: candidate.name,
      });
      continue;
    }
    if (claimed === 0) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: "db-guard-refused", name: candidate.name });
      continue;
    }

    await opts._afterClaim?.(candidate);

    // RE-CHECK UNDER THE LEASE, immediately before unlink. A Download that
    // arrived after our claim STEALS the lease (evicting → user, clearing the
    // token). If our exact token no longer owns the row, the user won: abort with
    // the files intact. This makes an explicit Download beat a speculative sweep.
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
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({ hash: candidate.hash, reason: "lease-stolen", name: candidate.name });
      continue;
    }

    // The lease is exclusively ours (origin = evicting, token matches). Delete
    // the files.
    let deletedOk = false;
    try {
      const deleted = await remove(opts.config, candidate.hash);
      deletedOk = deleted.ok;
      if (!deleted.ok) {
        result.reclaimedBytes -= candidate.onDiskBytes;
        result.skipped.push({
          hash: candidate.hash,
          reason: `client-refused: ${deleted.message}`,
          name: candidate.name,
        });
      }
    } catch (err) {
      result.reclaimedBytes -= candidate.onDiskBytes;
      result.skipped.push({
        hash: candidate.hash,
        reason: `client-error: ${err instanceof Error ? err.message : String(err)}`,
        name: candidate.name,
      });
    }

    if (!deletedOk) {
      // Roll the lease back so the row returns to an evictable stream. Guarded on
      // OUR token so we never clobber a steal that landed in the meantime.
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
        /* best-effort */
      }
      continue;
    }

    const row = await db.engineTorrent.deleteMany({
      where: {
        userId: opts.userId,
        hash: candidate.hash,
        origin: EVICTING_ORIGIN,
        evictLease: leaseToken,
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
    // Files just left the tree, so the memoised inventory now over-reports.
    resetDiskInventoryCache();
  }

  result.satisfied = remaining <= budgetBytes;
  if (mode === "preview") {
    result.satisfied = listed.usedBytes - result.reclaimedBytes <= budgetBytes;
  }
  return result;
}

/**
 * Reclaim (at least) `neededBytes` of stream cache, through the guarded sweep.
 *
 * The sweep is budget-shaped: it frees until the cache fits a target. A caller
 * that needs *room for one more file* does not have a target, it has a deficit
 * — so this converts one into the other by measuring the cache first and
 * setting the target that far below it.
 *
 * Deliberately a thin wrapper: every guard (kept origin, watchlist, unfinished
 * watch position, foreground stream, claim lease, re-check under lease) stays
 * exactly where it is. There is no second delete path.
 */
export async function reclaimForBytes(
  opts: Omit<RetentionSweepOptions, "budgetBytes"> & { neededBytes: number },
): Promise<RetentionSweepResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const needed =
    Number.isFinite(opts.neededBytes) && opts.neededBytes > 0 ? opts.neededBytes : 0;

  const listed = await listRetentionSweepCandidates({
    userId: opts.userId,
    db,
    now,
    graceMs: opts.graceMs,
    stall: opts.stall,
    protectHashes: opts.protectHashes,
    _foreground: opts._foreground,
  });

  return sweepRetentionCache({
    ...opts,
    now,
    db,
    budgetBytes: Math.max(0, listed.usedBytes - needed),
  });
}
