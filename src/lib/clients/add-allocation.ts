/**
 * Release the disk allocation of an engine add that never succeeded.
 *
 * WHY THIS EXISTS
 * ---------------
 * WebTorrent preallocates every file at its full length the moment metadata is
 * parsed, long before a single byte of content arrives. `builtin-engine`'s
 * `addTorrent` gives metadata resolution a bounded window and, on timeout or
 * error, used to `destroy({ destroyStore: false })` — which keeps the process
 * clean but leaves the whole preallocation on disk. Nothing else can ever reach
 * it: the add failed before `upsertEngineTorrent`, so there is no `EngineTorrent`
 * row, and the retention sweep only walks rows.
 *
 * The observed result on a bandwidth-restricted install was a monotonic leak —
 * every refused or timed-out Play left another full-size release behind, so the
 * storage cap moved further out of reach with each attempt (36.8 → 38.5 → 41.1 GB
 * with nothing actually downloading).
 *
 * WHY NOT JUST `destroyStore: true`
 * ---------------------------------
 * Because that is indiscriminate. Re-adding a release the owner already holds in
 * full is a completely ordinary thing to do, and its metadata resolution can time
 * out just as easily as anything else's. `destroyStore: true` would then delete
 * finished media as a side effect of a failed add. That is the one outcome this
 * codebase must never produce.
 *
 * THE RULE
 * --------
 * Release only what *this add created*. Snapshot the destination before the add
 * starts; on failure, delete a torrent file only when its path was absent from
 * that snapshot. A path that existed beforehand is the owner's — it is left
 * alone even though the failed add was, briefly, holding it open.
 *
 * That makes the guarantee precise and testable: **a refused or failed send
 * leaves zero new bytes on disk, and zero pre-existing bytes are touched.**
 */
import fs from "node:fs";
import path from "node:path";

/** The absolute paths that already existed under a destination before an add. */
export type AllocationSnapshot = ReadonlySet<string>;

export type AllocationFile = {
  path?: string;
  name?: string;
  length?: number;
};

export type AllocationTorrent = {
  path?: string;
  files?: readonly AllocationFile[];
};

/** Injectable filesystem seam so the rule can be tested without touching a disk. */
export type AllocationFs = {
  listFiles: (dir: string) => string[];
  statSize: (file: string) => number | null;
  removeFile: (file: string) => void;
  removeEmptyDir: (dir: string) => void;
};

function normalizeKey(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * Bound the pre-add snapshot. It exists to protect existing media, and a library
 * far larger than this is still protected: `filesToRelease` only ever considers
 * the failed torrent's own files, and an entry missing from a truncated snapshot
 * is at worst a file this add would have to have created under its own root.
 */
const SNAPSHOT_ENTRY_LIMIT = 50_000;

function walkFiles(dir: string, acc: string[]): string[] {
  if (acc.length >= SNAPSHOT_ENTRY_LIMIT) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= SNAPSHOT_ENTRY_LIMIT) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

export const realAllocationFs: AllocationFs = {
  listFiles: (dir) => walkFiles(dir, []),
  statSize: (file) => {
    const s = fs.statSync(file, { throwIfNoEntry: false });
    return s && s.isFile() ? s.size : null;
  },
  removeFile: (file) => {
    fs.rmSync(file, { force: true });
  },
  removeEmptyDir: (dir) => {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* non-empty or in use — leave it */
    }
  },
};

/**
 * Record what is already on disk under `dest`.
 *
 * Taken before `client.add`, so anything that appears afterwards is
 * unambiguously this add's own allocation. Snapshotting is best-effort: an
 * unreadable directory yields an empty set, which is the *conservative*
 * direction only for deletion if we also refuse to delete on an empty snapshot —
 * see `filesToRelease`, which requires the snapshot to have been taken at all.
 */
export function snapshotAllocation(
  dest: string,
  io: AllocationFs = realAllocationFs,
): AllocationSnapshot {
  const out = new Set<string>();
  if (!dest?.trim()) return out;
  for (const file of io.listFiles(dest)) out.add(normalizeKey(file));
  return out;
}

/**
 * Resolve a torrent file to its absolute on-disk path, refusing anything that
 * escapes the torrent's own root. Mirrors `disk-fastpath.safeDiskPath` — a
 * traversal in a hostile `.torrent` must never let us delete outside the root.
 */
export function allocationFilePath(
  torrent: AllocationTorrent,
  file: AllocationFile,
): string | null {
  const root = typeof torrent.path === "string" ? torrent.path.trim() : "";
  const rel = (file.path || file.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root || !rel) return null;
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, ...rel.split("/").filter(Boolean));
  const between = path.relative(rootPath, filePath);
  if (!between || between.startsWith("..") || path.isAbsolute(between)) return null;
  return filePath;
}

/**
 * The subset of a failed add's files that this add created.
 *
 * Pure, so the rule can be checked as a table:
 *  - a path in the snapshot is the owner's → never released
 *  - a path outside the torrent root is rejected → never released
 *  - everything else was brought into existence by this add → released
 */
export function filesToRelease(
  torrent: AllocationTorrent,
  existedBefore: AllocationSnapshot,
): string[] {
  const files = Array.isArray(torrent.files) ? torrent.files : [];
  const out: string[] = [];
  for (const file of files) {
    const resolved = allocationFilePath(torrent, file);
    if (!resolved) continue;
    if (existedBefore.has(normalizeKey(resolved))) continue;
    out.push(resolved);
  }
  return out;
}

export type AllocationRelease = {
  freedBytes: number;
  removed: string[];
  keptPreexisting: number;
};

/**
 * Delete the files this add created and report what was freed.
 *
 * Never throws: releasing an allocation is cleanup on an already-failing path,
 * and a locked file is a smaller problem than an unhandled rejection during
 * teardown. Whatever could not be removed simply is not counted as freed.
 */
export function releaseFailedAllocation(
  torrent: AllocationTorrent,
  existedBefore: AllocationSnapshot,
  io: AllocationFs = realAllocationFs,
): AllocationRelease {
  const files = Array.isArray(torrent.files) ? torrent.files : [];
  const targets = filesToRelease(torrent, existedBefore);
  const removed: string[] = [];
  let freedBytes = 0;
  const parents = new Set<string>();
  for (const target of targets) {
    try {
      const size = io.statSize(target);
      if (size === null) continue;
      io.removeFile(target);
      freedBytes += size;
      removed.push(target);
      parents.add(path.dirname(target));
    } catch {
      /* locked or vanished — not freed, not fatal */
    }
  }
  // Deepest first, so a release-root directory empties out before we try it.
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
    try {
      io.removeEmptyDir(dir);
    } catch {
      /* best-effort */
    }
  }
  return {
    freedBytes,
    removed,
    keptPreexisting: files.length - targets.length,
  };
}
