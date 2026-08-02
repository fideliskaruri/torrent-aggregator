/**
 * Physically remove a deleted release's files — and only its own files.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Delete + files" on the Downloads page promised to remove the download from
 * disk and did not. The built-in engine's `deleteTorrent` only reliably deleted
 * bytes when a *live* WebTorrent handle was still in memory
 * (`destroy({ destroyStore: true })`). For a rehydrated row with no live handle
 * — the ordinary case after a restart, and the exact shape of the seeded
 * `.e2e-instant-play` fixtures — it deleted the database row and then merely
 * pruned *empty* parent folders. The release folder was not empty (it still held
 * the media file plus sidecar junk), so nothing was pruned and every byte
 * survived while the row, and the UI row, vanished.
 *
 * And even the live path left litter behind: WebTorrent's store destroy removes
 * the files the torrent wrote, not the `.torrentflow` marker folder, the
 * `Featurettes` extras, the "Torrent Downloaded From ….txt" tracker spam, or a
 * half-written `.part`.
 *
 * THE RULE
 * --------
 * Delete exactly what this torrent owns, proven from its *recorded* absolute
 * file paths (`EngineTorrent.verifiedFilesJson`), never from a path a client
 * merely claims. Then, when the torrent created its own folder for that release,
 * remove that whole folder — junk included — but only after proving:
 *
 *   1. the folder is strictly *inside* the download root (never the root, never
 *      an ancestor of it);
 *   2. the folder is inside-or-equal the torrent's own recorded save path
 *      (never a directory above it);
 *   3. no *other* torrent still holds anything inside that folder — otherwise it
 *      is a shared category/show directory and only this release's own files may
 *      go.
 *
 * That is what keeps a shared `…/TV/` root, or a `Rick and Morty/` folder that
 * two episodes share, safe: the folder is removed only when it is demonstrably
 * this one release's own container.
 *
 * PURE + INJECTABLE FS
 * --------------------
 * `planReleaseRemoval` is pure so the containment rule can be checked as a
 * table. `executeReleaseRemoval` takes an injectable {@link RemovalFs}, mirroring
 * `add-allocation.ts`, so the unlink/rmtree behaviour is testable without a disk
 * and provable against a real one from a probe script.
 */
import fs from "node:fs";
import path from "node:path";

import { isPathInsideOrEqual } from "./prune-empty-parents";

export interface ReleaseRemovalRequest {
  /** Absolute file paths recorded as belonging to this torrent. */
  ownedFiles: readonly string[];
  /** The torrent's recorded save directory (its leaf save path). */
  savePath?: string | null;
  /** Download root. Nothing at or above this is ever removed. */
  baseRoot?: string | null;
  /**
   * Absolute paths (files, or save directories) still owned by OTHER torrents.
   * If any of these lives inside the candidate folder, the folder is shared and
   * is not removed — only this release's own files are.
   */
  otherPaths?: readonly string[];
}

export interface ReleaseRemovalPlan {
  /** Absolute file paths to unlink. Each proven strictly inside `baseRoot`. */
  files: string[];
  /** The torrent's own folder, safe to remove recursively — or null. */
  folder: string | null;
  /** Owned paths refused for being outside `baseRoot`. Never touched. */
  refusedOutside: string[];
  /** Why {@link folder} is null, when it is. Diagnostic only. */
  folderReason: string | null;
}

/** Injectable filesystem seam so the rule can be tested without a disk. */
export interface RemovalFs {
  /** File size in bytes, or null when the path is absent or not a file. */
  statSize: (file: string) => number | null;
  /** Remove a single file. Best-effort; may throw, callers catch. */
  removeFile: (file: string) => void;
  /** Recursively remove a directory and everything under it. */
  removeTree: (dir: string) => void;
}

export interface ReleaseRemovalResult {
  removed: string[];
  freedBytes: number;
  folderRemoved: string | null;
}

function norm(p: string): string {
  return process.platform === "win32"
    ? path.resolve(p).replace(/\//g, "\\").toLowerCase()
    : path.resolve(p);
}

/** True when `child` is inside `root`, but not `root` itself. */
export function isStrictlyInside(child: string, root: string): boolean {
  return isPathInsideOrEqual(child, root) && norm(child) !== norm(root);
}

/**
 * The deepest directory that contains every one of `files`.
 *
 * For a single file this is its parent. For a multi-file torrent it is the
 * folder the torrent created for the release — which is exactly the thing we
 * want to remove when it is the torrent's own. Case-insensitive on Windows, but
 * the original casing of the first path is preserved in the result.
 */
export function commonAncestorDir(files: readonly string[]): string | null {
  const dirs = files
    .map((f) => f?.trim())
    .filter((f): f is string => Boolean(f))
    .map((f) => path.dirname(path.resolve(f)));
  if (dirs.length === 0) return null;

  const split = (p: string) => p.split(/[\\/]+/);
  const cmp = (a: string, b: string) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;

  let prefix = split(dirs[0]);
  for (const dir of dirs.slice(1)) {
    const parts = split(dir);
    let i = 0;
    while (i < prefix.length && i < parts.length && cmp(prefix[i], parts[i])) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return null;
  }
  const joined = prefix.join(path.sep);
  // A bare drive letter ("C:") joins to "C:"; resolve normalises it to a root
  // path, which strict-inside checks will then correctly reject.
  return path.resolve(joined);
}

/**
 * Decide what deleting this release is allowed to remove from disk.
 *
 * Total and conservative: every refusal costs at most a leftover empty folder,
 * every wrong permission costs the user files. When in doubt, only the recorded
 * files go and the folder is left for the empty-parent prune to reconsider.
 */
export function planReleaseRemoval(
  req: ReleaseRemovalRequest,
): ReleaseRemovalPlan {
  const baseRoot = req.baseRoot?.trim() || null;
  const savePath = req.savePath?.trim() || null;

  const files: string[] = [];
  const refusedOutside: string[] = [];
  const seen = new Set<string>();

  for (const raw of req.ownedFiles) {
    const p = raw?.trim();
    if (!p) continue;
    const resolved = path.resolve(p);
    const key = norm(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    // No base root means we cannot prove containment, so we may not delete.
    if (!baseRoot || !isStrictlyInside(resolved, baseRoot)) {
      refusedOutside.push(resolved);
      continue;
    }
    files.push(resolved);
  }

  const plan: ReleaseRemovalPlan = {
    files,
    folder: null,
    refusedOutside,
    folderReason: null,
  };

  if (!baseRoot) {
    plan.folderReason = "no download root to bound the delete";
    return plan;
  }
  if (files.length === 0) {
    // Nothing recorded that we could prove owns a folder. Leave the folder to
    // the empty-parent prune rather than guessing at a directory to remove.
    plan.folderReason = "no recorded files to prove folder ownership";
    return plan;
  }

  const candidate = commonAncestorDir(files);
  if (!candidate) {
    plan.folderReason = "files share no common folder";
    return plan;
  }
  if (!isStrictlyInside(candidate, baseRoot)) {
    plan.folderReason = "folder is the download root or above it";
    return plan;
  }
  if (savePath && !isPathInsideOrEqual(candidate, savePath)) {
    plan.folderReason = "folder is above the recorded save path";
    return plan;
  }

  const others = (req.otherPaths ?? [])
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  for (const other of others) {
    if (isPathInsideOrEqual(other, candidate)) {
      plan.folderReason = "folder is shared with another download";
      return plan;
    }
  }

  plan.folder = candidate;
  return plan;
}

/**
 * Carry out a {@link ReleaseRemovalPlan}. Never throws.
 *
 * Files first (so a locked media file is still attempted before its folder),
 * then, if the plan proved a folder is this release's own, the whole folder —
 * which is what takes `Featurettes`, `.torrentflow`, the "Torrent Downloaded
 * From …" text file and any `.part` with it. A file that cannot be removed is
 * simply not counted as freed; cleanup on a delete path must not become a throw.
 */
export function executeReleaseRemoval(
  plan: ReleaseRemovalPlan,
  io: RemovalFs = realRemovalFs,
): ReleaseRemovalResult {
  const removed: string[] = [];
  let freedBytes = 0;

  for (const file of plan.files) {
    try {
      const size = io.statSize(file);
      io.removeFile(file);
      if (typeof size === "number" && size > 0) freedBytes += size;
      removed.push(file);
    } catch {
      /* locked or already gone — not freed, not fatal */
    }
    // A sibling half-written chunk file is this file's own and never anyone's
    // media, so it is safe to remove even outside a proven-own folder.
    for (const suffix of [".part", ".!qB"]) {
      try {
        io.removeFile(`${file}${suffix}`);
      } catch {
        /* absent or locked */
      }
    }
  }

  let folderRemoved: string | null = null;
  if (plan.folder) {
    try {
      io.removeTree(plan.folder);
      folderRemoved = plan.folder;
    } catch {
      /* best-effort: an empty-parent prune runs afterwards regardless */
    }
  }

  return { removed, freedBytes, folderRemoved };
}

export const realRemovalFs: RemovalFs = {
  statSize: (file) => {
    const s = fs.statSync(file, { throwIfNoEntry: false });
    return s && s.isFile() ? s.size : null;
  },
  removeFile: (file) => {
    fs.rmSync(file, { force: true });
  },
  removeTree: (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  },
};
