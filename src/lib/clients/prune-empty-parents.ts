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
