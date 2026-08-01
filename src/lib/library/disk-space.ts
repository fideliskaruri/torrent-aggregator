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
import fsp from "node:fs/promises";
import path from "node:path";
import { formatBytesShort, type StorageLimitKind } from "./storage-format";

/** How long a measured directory size stays valid. */
export const DIR_SIZE_TTL_MS = 30_000;

export interface DirectorySizeMeasurement {
  bytes: number;
  status: "complete" | "partial" | "unavailable";
  filesScanned: number;
}

const dirSizeCache = new Map<
  string,
  { measurement: DirectorySizeMeasurement; at: number }
>();
const dirSizeInFlight = new Map<string, Promise<DirectorySizeMeasurement>>();

/** Hard floor: refuse any send if free space below this. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Legacy explicit test/configuration preset. It is never selected implicitly;
 * an absent user setting is unconfigured, not 100 GB.
 */
export const DEFAULT_MAX_STORAGE_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB

export const STORAGE_SETUP_REQUIRED_MESSAGE =
  "Downloads need setup first — choose a download folder and set a storage cap in Settings → Downloads.";

/**
 * What a viewer is told when the cap refuses a download, and what they can do.
 *
 * Both halves of the ORIGINAL copy were wrong. It pointed at a **Settings →
 * Folders** tab that does not exist (the tabs are Connection / Downloads /
 * Categories), and it told the user to "delete old downloads" at a moment when
 * the Client page listed zero live transfers while ~37 GB sat under the
 * download folder — advice with no control behind it.
 *
 * The rewrite fixed the advice and left a different lie in place. It reported
 * only *usage*, so a 1 GB cap on an EMPTY folder produced:
 *
 *     "Storage cap reached — using 0 B of 1.0 GB"
 *
 * Measured verbatim against the running server. Nothing is stored, nothing is
 * "reached", and the owner is told their empty library is full — the same
 * complaint they had already raised once ("says full but i have no downloads").
 *
 * The missing fact is the incoming release. A refusal is
 * `used + incoming > cap`, and when the release size is unknown the app
 * reserves {@link DEFAULT_INCOMING_RESERVE_BYTES} against the budget. That
 * reserve is usually the whole reason a nearly-empty folder refuses a download,
 * and it was never mentioned. So the message now states all three numbers, and
 * names the reserve as an assumption when that is what it is.
 */
export function storageCapMessage(
  usedBytes: number,
  maxStorageBytes: number,
  incomingBytes?: number | null,
  /** True when `incomingBytes` is the default reserve, not a measured size. */
  incomingEstimated?: boolean,
): string {
  const used = formatBytesShort(usedBytes);
  const cap = formatBytesShort(maxStorageBytes);
  const free = formatBytesShort(Math.max(0, maxStorageBytes - usedBytes));
  const advice =
    `Raise the cap in Settings → Downloads, or free space there with ` +
    `"Delete reclaimable stream-only files".`;

  if (incomingBytes == null || !Number.isFinite(incomingBytes) || incomingBytes <= 0) {
    // No size to speak of: the old shape is honest here, since usage really is
    // the only fact involved.
    return `Storage cap reached — using ${used} of ${cap} under the download folder. ${advice}`;
  }

  const needs = formatBytesShort(incomingBytes);
  if (incomingEstimated) {
    // Naming the assumption matters: without it the arithmetic looks broken,
    // and the owner cannot tell that supplying a real size might fix it.
    return (
      `This release does not report its size, so TorrentFlow sets aside ${needs} for it — ` +
      `more than the ${free} left under your ${cap} cap (${used} in use). ${advice}`
    );
  }
  return (
    `This needs about ${needs}, but only ${free} is left under your ${cap} cap ` +
    `(${used} in use). ${advice}`
  );
}

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
      /**
       * Bytes the policy counted for the incoming release, and whether that was
       * measured or assumed.
       *
       * A refusal is `used + incoming > cap`, so a caller that only knows
       * `usedBytes` cannot explain itself. Measured live with a 1 MB cap on an
       * empty folder, the confirmation dialog read *"You are using 0 B of
       * 1 MB"* — arithmetic that looks broken, because the 2 GB the app had
       * reserved for a release of unknown size was the entire reason and was
       * never mentioned. The server message was fixed for exactly this; the
       * dialog has its own copy and needs the same facts to say the same thing.
       */
      incomingBytes: number;
      /** True when `incomingBytes` is the default reserve, not a real size. */
      incomingEstimated: boolean;
      /**
       * WHICH limit refused, so callers never have to read the prose to find out.
       *
       * This distinction is the whole reason the cap can be overridden safely:
       *
       *  - `cap` — the owner's own budget for how much media to keep. It is a
       *    guardrail about their preference. Overriding it costs disk space they
       *    chose to reserve; nothing breaks.
       *  - `reserve` — the app's 500 MB comfort margin on the volume. The item
       *    *does* fit; it would just leave the drive tighter than this app likes.
       *    That is still an opinion the app invented, so it is the owner's call.
       *  - `wont-fit` — arithmetic, not opinion: the release needs more bytes
       *    than the volume physically has free. No amount of consent creates
       *    disk, so this is the one true hard stop.
       *  - `setup` — no download folder / no cap configured yet. There is nothing
       *    to override; the answer is to finish setup.
       *  - `inventory` — the bounded folder scan was incomplete or unreadable.
       *    Overriding it would turn a lower-bound byte count into a false total.
       *
       * `reserve` and `wont-fit` were once a single `free-space` kind, which made
       * the app refuse a download that fit perfectly well merely because it
       * disliked the leftovers. Splitting them is what lets the product keep one
       * genuine hard stop while every self-imposed limit stays negotiable.
       *
       * Without this field a consumer would have to regex the message to decide
       * whether to offer "download anyway", and a copy edit would silently turn a
       * hard stop into an overridable prompt.
       */
      limit: StorageLimitKind;
    };

/** @see StoragePolicyResult */
export type { StorageLimitKind };

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
 *
 * Synchronous — only for tests and CLI scripts. Server request paths must use
 * {@link getDirectorySizeBytesAsync}, which does not block the event loop.
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

/**
 * Async recursive directory size (bytes).
 *
 * The sync version walks up to 200k files while holding the only thread Node
 * has, which freezes every other request for the duration. A download library
 * is exactly the kind of tree that gets big, and this runs before every send.
 *
 * Results are memoised per root for {@link DIR_SIZE_TTL_MS}: an automation run
 * sends many torrents back to back, and re-walking the same tree for each one
 * costs far more than the accuracy it buys. Sizes only grow as downloads land,
 * and the incoming-size reserve already covers in-flight growth.
 */
export async function getDirectorySizeBytesAsync(
  root: string,
  opts?: { maxFiles?: number; ttlMs?: number },
): Promise<number> {
  return (await measureDirectorySize(root, opts)).bytes;
}

/**
 * Bounded async measurement with explicit completeness. Callers making storage
 * decisions must use this rather than treating a partial byte count as truth.
 */
export async function measureDirectorySize(
  root: string,
  opts?: { maxFiles?: number; ttlMs?: number },
): Promise<DirectorySizeMeasurement> {
  if (!root?.trim()) {
    return { bytes: 0, status: "unavailable", filesScanned: 0 };
  }

  const maxFiles = opts?.maxFiles ?? 200_000;
  const ttlMs = opts?.ttlMs ?? DIR_SIZE_TTL_MS;
  const key = path.resolve(root);
  const now = Date.now();

  const hit = dirSizeCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.measurement;

  // Collapse concurrent walks of the same tree into one.
  const inFlight = dirSizeInFlight.get(key);
  if (inFlight) return inFlight;

  const job = (async () => {
    let total = 0;
    let files = 0;
    let partial = false;
    const stack = [key];

    try {
      const rootStat = await fsp.stat(key);
      if (rootStat.isFile()) {
        return { bytes: rootStat.size, status: "complete" as const, filesScanned: 1 };
      }
    } catch {
      return { bytes: 0, status: "unavailable" as const, filesScanned: 0 };
    }

    while (stack.length > 0 && files < maxFiles) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        partial = true;
        continue;
      }
      for (const ent of entries) {
        if (files >= maxFiles) break;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile()) {
          try {
            total += (await fsp.stat(full)).size;
            files += 1;
          } catch {
            partial = true;
          }
        }
      }
    }
    // Reaching the safety cap cannot prove that the current directory had no
    // remaining entries, so conservatively treat the measurement as a lower bound.
    if (files >= maxFiles) partial = true;
    return {
      bytes: total,
      status: partial ? ("partial" as const) : ("complete" as const),
      filesScanned: files,
    };
  })();

  dirSizeInFlight.set(key, job);
  try {
    const measurement = await job;
    dirSizeCache.set(key, { measurement, at: Date.now() });
    return measurement;
  } catch {
    return { bytes: 0, status: "unavailable", filesScanned: 0 };
  } finally {
    dirSizeInFlight.delete(key);
  }
}

/** Drop memoised directory sizes (call after deleting downloads, and in tests). */
export function resetDirectorySizeCache(): void {
  dirSizeCache.clear();
  dirSizeInFlight.clear();
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
 * Tell apart the two very different things the free-space check catches.
 *
 * The old code called both "free-space" and refused both outright, which meant
 * a 700 MB episode on a drive with 900 MB free was rejected with no way
 * forward — not because it did not fit, but because it would leave less than
 * the 500 MB this app decided to keep spare. The owner's objection was exactly
 * this: *"it should not be non-negotiable.. maybe i want to download that..
 * unless my storage is full that is when it shouldn't continue"*.
 *
 * So the question is only ever: does it fit at all?
 *
 *   - `incoming > freeBytes` — it does not. That is arithmetic. Consent cannot
 *     manufacture disk, and a torrent that runs the volume to zero mid-write can
 *     corrupt in-flight files, so this stays a hard refusal.
 *   - otherwise — it fits, and the objection is purely to the leftover margin.
 *     That is the app's own preference, so the owner gets to overrule it.
 *
 * Callers that never look at `limit` still read correctly: both messages lead
 * with the same two numbers.
 */
function freeSpaceRefusal(
  incoming: number,
  freeBytes: number,
  minFree: number,
): { message: string; limit: StorageLimitKind } {
  if (incoming > freeBytes) {
    return {
      message:
        `Not enough space on the drive — this needs about ${formatBytesShort(incoming)} ` +
        `and only ${formatBytesShort(freeBytes)} is free. ` +
        `Free up space or choose a download folder on another drive.`,
      limit: "wont-fit",
    };
  }
  return {
    message:
      `This needs about ${formatBytesShort(incoming)} and would leave under ` +
      `${formatBytesShort(minFree)} free on the drive, which is the safety margin ` +
      `this app keeps. It does fit — you can continue anyway, free up space, or ` +
      `choose another download folder.`,
    limit: "reserve",
  };
}

/**
 * Automatic storage policy — call before every send.
 *
 * @param root download base folder (budget is measured under this tree)
 * @param maxStorageBytes cap for that tree; null/0 = setup is incomplete
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
  /**
   * Test seams. The reserve/wont-fit boundary is arithmetic on two numbers, and
   * it decides whether the owner is offered a choice or a wall — worth pinning
   * exactly, which needs a volume that reports what the test says rather than
   * whatever the machine running CI happens to have free.
   */
  _getFreeSpace?: (root: string) => Promise<FreeSpaceResult>;
  _getDirectorySize?: (
    root: string,
  ) => Promise<number | DirectorySizeMeasurement>;
}): Promise<StoragePolicyResult> {
  const maxRaw = opts.maxStorageBytes;
  const incomingKnownEarly =
    opts.incomingBytes != null &&
    Number.isFinite(opts.incomingBytes) &&
    opts.incomingBytes > 0;
  if (maxRaw == null || !Number.isFinite(maxRaw) || maxRaw <= 0) {
    return {
      ok: false,
      freeBytes: null,
      usedBytes: 0,
      maxStorageBytes: null,
      remainingBudgetBytes: null,
      message: STORAGE_SETUP_REQUIRED_MESSAGE,
      limit: "setup",
      incomingBytes: incomingKnownEarly
        ? (opts.incomingBytes as number)
        : DEFAULT_INCOMING_RESERVE_BYTES,
      incomingEstimated: !incomingKnownEarly,
    };
  }

  const root = opts.root?.trim() || process.cwd();
  const minFree = opts.minFreeBytes ?? MIN_FREE_BYTES;
  const incomingKnown =
    opts.incomingBytes != null &&
    Number.isFinite(opts.incomingBytes) &&
    opts.incomingBytes > 0;
  const incoming = incomingKnown
    ? (opts.incomingBytes as number)
    : DEFAULT_INCOMING_RESERVE_BYTES;

  const space = await (opts._getFreeSpace ?? getFreeSpace)(root);
  const freeBytes = space.ok ? space.freeBytes : null;
  const measured = await (opts._getDirectorySize ?? measureDirectorySize)(root);
  const measurement: DirectorySizeMeasurement =
    typeof measured === "number"
      ? { bytes: measured, status: "complete", filesScanned: 0 }
      : measured;
  const usedBytes = measurement.bytes;
  if (measurement.status !== "complete") {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes: maxRaw,
      remainingBudgetBytes: null,
      message:
        measurement.status === "unavailable"
          ? "Storage usage is unavailable because the download folder could not be read. Check the folder and permissions before downloading."
          : `Storage usage is incomplete after scanning ${measurement.filesScanned} files. TorrentFlow will not undercount the library; narrow or repair the download folder and try again.`,
      incomingBytes: incoming,
      incomingEstimated: !incomingKnown,
      limit: "inventory",
    };
  }

  // 1) The app's free-space comfort margin.
  //
  // Note this fires on the state of the volume *before* adding anything, so it
  // can refuse a 50 MB episode on a drive with 400 MB free — a case where the
  // file fits with room to spare. That is a preference about headroom, not a
  // physical limit, so it is classified by whether the item actually fits.
  if (freeBytes != null && freeBytes < minFree) {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes: null,
      remainingBudgetBytes: null,
      ...freeSpaceRefusal(incoming, freeBytes, minFree),
      incomingBytes: incoming,
      incomingEstimated: !incomingKnown,
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

  // 2) Explicit user cap
  const maxStorageBytes = maxRaw;

  const remainingBudget = Math.max(0, maxStorageBytes - usedBytes);

  if (usedBytes + incoming > maxStorageBytes) {
    return {
      ok: false,
      freeBytes,
      usedBytes,
      maxStorageBytes,
      remainingBudgetBytes: remainingBudget,
      message: storageCapMessage(usedBytes, maxStorageBytes, incoming, !incomingKnown),
      incomingBytes: incoming,
      incomingEstimated: !incomingKnown,
      // The owner's own budget — a guardrail they may knowingly override.
      limit: "cap",
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
      ...freeSpaceRefusal(incoming, freeBytes, minFree),
      incomingBytes: incoming,
      incomingEstimated: !incomingKnown,
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

/** Human-readable bytes. Defined in `storage-format.ts` so client code can use it. */
export { formatBytesShort };

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
  maxStorageBytes: number | null = null,
): { canFit: boolean; headroomBytes: number; message: string } {
  if (maxStorageBytes == null || maxStorageBytes <= 0) {
    return {
      canFit: false,
      headroomBytes: 0,
      message: STORAGE_SETUP_REQUIRED_MESSAGE,
    };
  }
  const budgetLeft =
    Math.max(0, maxStorageBytes - usedBytes);

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
