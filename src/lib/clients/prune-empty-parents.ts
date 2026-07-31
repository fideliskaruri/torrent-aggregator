/**
 * After deleting torrent files, remove empty parent folders up to (but not
 * including) the download root.
 *
 * Example:
 *   D:\Torrents\TV\Family Guy\Season 09\  (files removed)
 *   → remove Season 09 if empty
 *   → remove Family Guy if empty
 *   → stop at D:\Torrents\TV or D:\Torrents (base) — never delete the root
 */
import fs from "node:fs";
import path from "node:path";

export interface PruneEmptyParentsResult {
  removed: string[];
  stoppedAt: string | null;
  reason?: string;
}

/**
 * Remove empty directories BELOW a starting folder, deepest first.
 *
 * ## Why upward pruning was not enough
 *
 * `pruneEmptyParents` climbs from a torrent's `savePath` toward the download
 * root. But a multi-file torrent does not put its files *in* `savePath` — it
 * creates its own folder underneath, `savePath/<torrent name>/…`. After the
 * engine deletes the files that folder is left empty, one level **below** where
 * the upward walk starts. The walk then sees a non-empty `savePath` (it still
 * contains that empty folder) and stops immediately, removing nothing.
 *
 * Measured: `Games/Some Repack/data/` survived a delete that reported success —
 * *"the delete button doesn't even delete the folders"*. A flat single-file
 * torrent hid it, because there was no sub-folder to leave behind.
 *
 * ## Why this is safe
 *
 * It only ever calls `rmdir`, which refuses a directory containing anything at
 * all — so a single stray file anywhere in the subtree keeps that branch. It
 * cannot touch a live torrent either: WebTorrent preallocates every file the
 * moment metadata parses, so an in-progress download's folder is never empty.
 * Depth and visit count are bounded so a pathological tree cannot hang a delete.
 */
export function pruneEmptyDescendants(
  startPath: string | null | undefined,
  stopAt: string | null | undefined,
  opts?: { maxDepth?: number; maxVisits?: number },
): PruneEmptyParentsResult {
  const removed: string[] = [];
  const maxDepth = opts?.maxDepth ?? 8;
  const maxVisits = opts?.maxVisits ?? 2000;

  if (!startPath?.trim()) {
    return { removed, stoppedAt: null, reason: "no start path" };
  }
  if (!stopAt?.trim()) {
    return { removed, stoppedAt: null, reason: "no stop root (base download path)" };
  }

  const root = path.resolve(stopAt.trim());
  const start = path.resolve(startPath.trim());
  if (!isPathInsideOrEqual(start, root)) {
    return {
      removed,
      stoppedAt: root,
      reason: "start path outside download root — refuse to prune",
    };
  }

  let visits = 0;

  /** Post-order: children are considered before the directory that holds them. */
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || visits++ > maxVisits) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Never follow a link out of the tree — resolve and re-check containment.
      if (entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      if (!isPathInsideOrEqual(child, root)) continue;
      walk(child, depth + 1);
      try {
        // `rmdir` without `recursive` fails on anything non-empty. That refusal
        // IS the guarantee: this can never take content with it.
        fs.rmdirSync(child);
        removed.push(child);
      } catch {
        /* not empty, or vanished — either is correct */
      }
    }
  };

  walk(start, 0);
  return { removed, stoppedAt: start };
}

function isDirectoryEmpty(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * True when `dir` is `root` or a descendant of `root` (resolved, case-insensitive on win).
 */
export function isPathInsideOrEqual(dir: string, root: string): boolean {
  const a = path.resolve(dir);
  const b = path.resolve(root);
  const norm = (p: string) =>
    process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
  const al = norm(a);
  const bl = norm(b);
  if (al === bl) return true;
  const sep = process.platform === "win32" ? "\\" : path.sep;
  return al.startsWith(bl.endsWith(sep) ? bl : bl + sep);
}

/**
 * Start at `startPath` (file or directory). If a file, begin at its parent.
 * Walk upward removing empty directories until `stopAt` (download base) or a
 * non-empty directory. Never removes `stopAt` itself.
 */
export function pruneEmptyParents(
  startPath: string | null | undefined,
  stopAt: string | null | undefined,
  opts?: { maxLevels?: number },
): PruneEmptyParentsResult {
  const removed: string[] = [];
  const maxLevels = opts?.maxLevels ?? 12;

  if (!startPath?.trim()) {
    return { removed, stoppedAt: null, reason: "no start path" };
  }
  if (!stopAt?.trim()) {
    return { removed, stoppedAt: null, reason: "no stop root (base download path)" };
  }

  const root = path.resolve(stopAt.trim());
  let current = path.resolve(startPath.trim());

  // If start is a file (or vanished), use parent directory
  try {
    const st = fs.statSync(current);
    if (!st.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    // Path may already be gone after client delete — climb from parent
    current = path.dirname(current);
  }

  if (!isPathInsideOrEqual(current, root)) {
    return {
      removed,
      stoppedAt: root,
      reason: "start path outside download root — refuse to prune",
    };
  }

  for (let i = 0; i < maxLevels; i++) {
    if (!isPathInsideOrEqual(current, root)) break;

    // Never delete the download base itself
    const sameRoot =
      process.platform === "win32"
        ? current.toLowerCase() === root.toLowerCase()
        : current === root;
    if (sameRoot) {
      return { removed, stoppedAt: root };
    }

    // Parent must still be under root before we consider removing current
    const parent = path.dirname(current);
    if (!isPathInsideOrEqual(parent, root) && parent !== root) {
      // parent escaped root somehow
      break;
    }

    if (!fs.existsSync(current)) {
      current = parent;
      continue;
    }

    if (!isDirectoryEmpty(current)) {
      return { removed, stoppedAt: current };
    }

    try {
      fs.rmdirSync(current);
      removed.push(current);
    } catch (err) {
      return {
        removed,
        stoppedAt: current,
        reason:
          err instanceof Error
            ? `could not remove ${current}: ${err.message}`
            : "rmdir failed",
      };
    }

    current = parent;
  }

  return { removed, stoppedAt: current };
}
