/**
 * Automatic storage policy for TorrentFlow downloads.
 *
 * Always enforced (no manual "space check" required):
 * 1. Min free space on the download drive (default 500MB)
 * 2. Optional max budget under the download root (maxStorageBytes)
 *
 * Never grows past the user-set cap; never fills the disk past the free floor.
 */
import fs from "node:fs";
import path from "node:path";

/** Hard floor: refuse any send if free space below this. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB

/** Default cap when user has not set one (100 GB under download root). */
export const DEFAULT_MAX_STORAGE_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB

/** When torrent size unknown, reserve this much headroom against the budget. */
export const DEFAULT_INCOMING_RESERVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export type FreeSpaceResult =
  | { ok: true; freeBytes: number | null }
  | { ok: false; freeBytes: number | null; message: string };

export type StoragePolicyResult =
  | {
      ok: true;
      freeBytes: number | null;
      usedBytes: number;
      maxStorageBytes: number | null;
      remainingBudgetBytes: number | null;
    }
  | {
      ok: false;
      freeBytes: number | null;
      usedBytes: number;
      maxStorageBytes: number | null;
      remainingBudgetBytes: number | null;
      message: string;
    };

/**
 * Best-effort free space for a path (or its parent if missing).
 */
export async function getFreeSpace(dest: string): Promise<FreeSpaceResult> {
  try {
    const statfs = (
      fs.promises as typeof fs.promises & {
        statfs?: (p: string) => Promise<{
          bavail: number | bigint;
          bsize: number | bigint;
        }>;
      }
    ).statfs;

    if (typeof statfs !== "function") {
      return { ok: true, freeBytes: null };
    }

    let target = dest;
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      target = path.dirname(dest);
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch {
        /* best-effort */
      }
    }

    const stats = await statfs(target);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(free) || free < 0) {
      return { ok: true, freeBytes: null };
    }
    return { ok: true, freeBytes: free };
  } catch {
    return { ok: true, freeBytes: null };
  }
}

/**
 * Recursive directory size (bytes). Caps file walk for safety.
 */
export function getDirectorySizeBytes(
  root: string,
  opts?: { maxFiles?: number },
): number {
  const maxFiles = opts?.maxFiles ?? 200_000;
  let total = 0;
  let files = 0;

  function walk(dir: string) {
    if (files >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files >= maxFiles) return;
      const full = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const st = fs.statSync(full);
          total += st.size;
          files += 1;
        }
      } catch {
        /* skip inaccessible */
      }
    }
  }

  if (!root?.trim()) return 0;
  try {
    if (!fs.existsSync(root)) return 0;
    const st = fs.statSync(root);
    if (st.isFile()) return st.size;
    walk(root);
  } catch {
    return 0;
  }
  return total;
}

/** Refuse send if free space is known and below hard floor. */
export async function assertMinFreeSpace(
  dest: string,
  minBytes = MIN_FREE_BYTES,
): Promise<FreeSpaceResult> {
  const space = await getFreeSpace(dest);
  if (!space.ok) return space;
  if (space.freeBytes == null) return space;
  if (space.freeBytes < minBytes) {
    const freeMb = Math.floor(space.freeBytes / (1024 * 1024));
    const needMb = Math.ceil(minBytes / (1024 * 1024));
    return {
      ok: false,
      freeBytes: space.freeBytes,
      message: `Not enough free disk space (need ~${needMb}MB free, have ~${freeMb}MB)`,
    };
  }
  return space;
}

/**
 * Automatic storage policy — call before every send.
 *
 * @param root download base folder (budget is measured under this tree)
 * @param maxStorageBytes cap for that tree; null/0 = use DEFAULT_MAX_STORAGE_BYTES
 * @param incomingBytes expected size of this download (or reserve default)
 * @param minFreeBytes hard floor of free space on the volume
 * @param unlimited if true, only enforce min free space (no size cap)
 */
export async function assertStorageBudget(opts: {
  root: string;
  maxStorageBytes?: number | null;
  incomingBytes?: number | null;
  minFreeBytes?: number;
  /** When true, skip the max-budget check (only min free). */
  unlimited?: boolean;
}): Promise<StoragePolicyResult> {
  const root = opts.root?.trim() || process.cwd();
  const minFree = opts.minFreeBytes ?? MIN_FREE_BYTES;
  const incoming =
    opts.incomingBytes != null &&
    Number.isFinite(opts.incomingBytes) &&
    opts.incomingBytes > 0
      ? opts.incomingBytes
      : DEFAULT_INCOMING_RESERVE_BYTES;

  const space = await getFreeSpace(root);
  const freeBytes = space.ok ? space.freeBytes : null;
  const usedBytes = getDirectorySizeBytes(root);

  // 1) Absolute free-space floor
  if (freeBytes != null && freeBytes < minFree) {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes: null,
      remainingBudgetBytes: null,
      message: `Disk almost full — need ~${formatBytesShort(minFree)} free, have ~${formatBytesShort(freeBytes)}. Free space or change download folder.`,
    };
  }

  if (opts.unlimited) {
    return {
      ok: true,
      freeBytes,
      usedBytes,
      maxStorageBytes: null,
      remainingBudgetBytes: null,
    };
  }

  // 2) Soft default cap if user never configured one
  const maxRaw = opts.maxStorageBytes;
  const maxStorageBytes =
    maxRaw == null || maxRaw <= 0
      ? DEFAULT_MAX_STORAGE_BYTES
      : maxRaw;

  const remainingBudget = Math.max(0, maxStorageBytes - usedBytes);

  if (usedBytes + incoming > maxStorageBytes) {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes,
      remainingBudgetBytes: remainingBudget,
      message: `Storage cap reached — using ${formatBytesShort(usedBytes)} of ${formatBytesShort(maxStorageBytes)} under download folder. Raise the limit in Settings → Folders, or delete old downloads.`,
    };
  }

  // Also don't exceed free space with incoming estimate
  if (freeBytes != null && incoming > freeBytes - minFree) {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes,
      remainingBudgetBytes: remainingBudget,
      message: `Not enough free space for this download (~${formatBytesShort(incoming)} needed with safety margin; ${formatBytesShort(freeBytes)} free).`,
    };
  }

  return {
    ok: true,
    freeBytes,
    usedBytes,
    maxStorageBytes,
    remainingBudgetBytes: remainingBudget,
  };
}

/** Human-readable bytes. */
export function formatBytesShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n)} B`;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * 1e9);
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1e9) * 10) / 10;
}

/**
 * Rough catch-up estimate: episodes × avg size.
 */
export function estimateBackfillBytes(opts: {
  fromSeason: number;
  toSeason: number;
  episodesPerSeason?: number;
  avgEpisodeBytes?: number;
}): { seasons: number; episodes: number; estimatedBytes: number } {
  const from = Math.max(1, opts.fromSeason);
  const to = Math.max(from, opts.toSeason);
  const seasons = to - from + 1;
  const epPer = opts.episodesPerSeason ?? 22;
  const avg = opts.avgEpisodeBytes ?? 1.5e9;
  const episodes = seasons * epPer;
  return {
    seasons,
    episodes,
    estimatedBytes: Math.round(episodes * avg),
  };
}

export function canFitEstimate(
  freeBytes: number | null,
  estimatedBytes: number,
  usedBytes = 0,
  maxStorageBytes: number | null = DEFAULT_MAX_STORAGE_BYTES,
): { canFit: boolean; headroomBytes: number; message: string } {
  const budgetLeft =
    maxStorageBytes != null && maxStorageBytes > 0
      ? Math.max(0, maxStorageBytes - usedBytes)
      : null;

  if (freeBytes == null && budgetLeft == null) {
    return {
      canFit: true,
      headroomBytes: 0,
      message: "Storage limits unknown",
    };
  }

  const freeOk =
    freeBytes == null || freeBytes >= estimatedBytes + MIN_FREE_BYTES;
  const budgetOk =
    budgetLeft == null || budgetLeft >= estimatedBytes;
  const canFit = freeOk && budgetOk;

  return {
    canFit,
    headroomBytes: budgetLeft ?? freeBytes ?? 0,
    message: canFit
      ? `About ${formatBytesShort(estimatedBytes)}; cap OK` +
        (budgetLeft != null
          ? ` (${formatBytesShort(budgetLeft)} left of budget)`
          : "")
      : `About ${formatBytesShort(estimatedBytes)} would exceed storage policy` +
        (budgetLeft != null
          ? ` (only ${formatBytesShort(budgetLeft)} left under cap)`
          : "") +
        (freeBytes != null ? `; free ${formatBytesShort(freeBytes)}` : ""),
  };
}
