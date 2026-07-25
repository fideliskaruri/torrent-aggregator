/**
 * On-disk half of the content layout fix — see `content-layout.ts`.
 *
 * Two things put files one or more levels too deep:
 *   1. Torrents added before the path rewrite existed, whose bytes are still
 *      sitting under a release folder.
 *   2. Packs that wrap their release name more than once.
 *
 * Both are repaired by lifting folder contents up into the save path. This
 * must run while nothing holds a file handle — before the torrent is added.
 *
 * The rules for *which* folder may be lifted are not defined here: they live
 * in `content-layout-policy.ts` and are shared with the planner. If the two
 * disagreed, a torrent would be added expecting one layout while its own
 * resume data sat in another, and every byte would be fetched twice.
 *
 * A lift is all-or-nothing. Moving what fits and stranding the rest produces
 * exactly that split-brain: half the files at the destination, half still
 * nested, and a planner that then declines to flatten because of the
 * collision it can see.
 */
import fs from "node:fs";
import path from "node:path";

import {
  destinationKeys,
  destinationNamesSeason,
  isInside,
  isSameRelease,
  mayDropFolder,
  seasonFolderRename,
} from "./content-layout-policy";

/** Normalize for comparing a torrent name against a folder name. */
export function normalizeReleaseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Removes `dir` and any empty directories inside it, bottom up. Files and the
 * folders holding them are left exactly where they are.
 */
function removeEmptyDirs(dir: string): void {
  try {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory()) removeEmptyDirs(path.join(dir, child.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* best-effort: a leftover folder is harmless */
  }
}

export type FlattenResult =
  | { flattened: true; from: string; moved: number }
  | { flattened: false; reason: string };

type Move = { src: string; dst: string };

/**
 * Works out every file move a lift would perform, or fails.
 *
 * Fails on anything that would need a judgement call mid-move: a symlink or
 * junction (which could redirect writes outside the library), a file where a
 * directory should go, or a destination name that already exists at all.
 *
 * "Exists at all" is deliberately blunt. Comparing sizes, or sampling the ends
 * of two large files, cannot prove they hold the same bytes — two
 * preallocated files, or two containers sharing a header and tail padding,
 * match on both and differ in the middle. Deleting the source on that evidence
 * destroys the only copy of the difference. A redundant copy left on disk
 * costs space; a wrong delete costs data, so this never deletes.
 */
function planLift(
  from: string,
  to: string,
  root: string,
  moves: Move[],
): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  for (const child of entries) {
    const src = path.join(from, child.name);
    const dst = path.join(to, child.name);

    if (child.isSymbolicLink()) return `symlink: ${child.name}`;
    if (!isInside(root, dst)) return `escapes the destination: ${child.name}`;

    let existing: fs.Stats | null = null;
    try {
      const l = fs.lstatSync(dst);
      if (l.isSymbolicLink()) return `symlink in the way: ${child.name}`;
      existing = l;
    } catch (err) {
      // Only a genuinely absent path is safe to move onto. ENOTDIR means a
      // file is sitting where one of our parent folders should be.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") return `cannot inspect ${child.name}: ${code}`;
      existing = null;
    }

    if (!existing) {
      if (child.isDirectory()) {
        // A whole absent directory would be moved with one rename, which would
        // carry any nested symlink along unchecked. Walk it first.
        const err = planLift(src, dst, root, moves);
        if (err) return err;
        continue;
      }
      moves.push({ src, dst });
      continue;
    }

    if (child.isDirectory()) {
      if (!existing.isDirectory()) return `file blocks folder: ${child.name}`;
      const err = planLift(src, dst, root, moves);
      if (err) return err;
      continue;
    }

    if (existing.isDirectory()) return `folder blocks file: ${child.name}`;
    return `already taken: ${child.name}`;
  }

  return null;
}

/**
 * Moves the contents of one wrapper folder under `dest` up into `dest`, then
 * removes the empty folder.
 *
 * The folder must be named after the torrent. There is deliberately no
 * "there is only one child folder, so lift it" fallback: `Director's Cut`,
 * `English Dub` and `Remastered` are all single children that carry meaning,
 * and a torrent re-added after manual organisation would lose them. Without a
 * name match we do not know what we are looking at, so we leave it.
 *
 * Safe to call repeatedly — a no-op once the layout is flat.
 */
export function liftWrapperFolder(
  dest: string,
  torrentName?: string | null,
  options?: { depth?: number; ancestors?: readonly string[] },
): FlattenResult {
  const root = dest?.trim();
  if (!root) return { flattened: false, reason: "empty dest" };

  let entries: fs.Dirent[];
  try {
    const st = fs.lstatSync(root);
    if (st.isSymbolicLink()) return { flattened: false, reason: "dest is a link" };
    if (!st.isDirectory()) return { flattened: false, reason: "dest missing" };
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return {
      flattened: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink());
  if (dirs.length === 0) return { flattened: false, reason: "no subfolder" };

  const key = torrentName?.trim() ? normalizeReleaseKey(torrentName) : null;
  const byName = key
    ? dirs.find((d) => normalizeReleaseKey(d.name) === key)
    : undefined;
  const deeper = options?.depth ? options.depth > 0 : false;

  // Past the container root the folder is identified by being the same release
  // as the one just lifted, which `mayDropFolder` checks below.
  const target = byName ?? (deeper && dirs.length === 1 ? dirs[0] : undefined);
  if (!target) {
    return { flattened: false, reason: "no folder matches the torrent name" };
  }

  const depth = options?.depth ?? 0;
  const ancestors = options?.ancestors ?? [];
  // The same decision the planner makes, from the same function.
  if (!mayDropFolder(target.name, depth, destinationKeys(root), ancestors)) {
    return { flattened: false, reason: `not a container: ${target.name}` };
  }

  const from = path.join(root, target.name);
  const moves: Move[] = [];
  const problem = planLift(from, root, root, moves);
  if (problem) return { flattened: false, reason: problem };
  if (moves.length === 0) return { flattened: false, reason: "nothing to move" };

  let moved = 0;
  try {
    for (const m of moves) {
      fs.mkdirSync(path.dirname(m.dst), { recursive: true });
      fs.renameSync(m.src, m.dst);
      moved += 1;
    }
    removeEmptyDirs(from);
  } catch (err) {
    return {
      flattened: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (moved === 0) return { flattened: false, reason: "nothing moved" };
  return { flattened: true, from, moved };
}

/**
 * Renames release folders directly under `dest` to the season they name,
 * matching what the planner now does for freshly added torrents.
 *
 * This is the migration half: bytes already on disk under
 * `Solo Leveling S01 …-EMBER/` have to move to `Season 01/` or the planner
 * will point the store at a path that has nothing in it and fetch the whole
 * pack again. Like the lift, it runs before the torrent is added.
 *
 * Only folders belonging to `torrentName` are touched. A destination is not
 * private — `downloads/Other` and `TV/Show` are both shared — so renaming
 * every season-shaped folder found there would rename another torrent's
 * folder out from under it while it is mid-download. Without a name to match
 * against, nothing is renamed.
 *
 * Never merges: if the target name is already taken, the folder is left where
 * it is. Two seasons' worth of episodes sharing a folder is worse than an
 * ugly folder name.
 */
export function renameSeasonFolders(
  dest: string,
  torrentName?: string | null,
): string[] {
  if (!torrentName || destinationNamesSeason(dest)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dest, { withFileTypes: true });
  } catch {
    return [];
  }

  const renamed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const to = seasonFolderRename(entry.name);
    if (!to || to === entry.name) continue;

    // The season marker is the one token the folder may add to the pack name.
    const season = Number(to.slice("Season ".length));
    if (!isSameRelease(torrentName, entry.name, new Set([`season ${season}`]))) {
      continue;
    }

    const target = path.join(dest, to);
    if (fs.existsSync(target)) continue;

    try {
      fs.renameSync(path.join(dest, entry.name), target);
      renamed.push(`${entry.name} → ${to}`);
    } catch {
      // A locked folder just keeps its name; the planner's collision check
      // will decline to rewrite rather than strand the bytes.
    }
  }
  return renamed;
}

/**
 * Lifts however many wrapper folders are stacked under `dest`.
 *
 * Depth is passed through to the shared policy, which decides what is
 * droppable at each level — the container root unconditionally, anything
 * deeper only on evidence that it repeats what we already have.
 */
export function repairContentLayout(
  dest: string,
  torrentName?: string | null,
): { moved: number; roots: string[]; renamed: string[] } {
  const roots: string[] = [];
  let moved = 0;

  for (let depth = 0; depth < 8; depth++) {
    const result = liftWrapperFolder(dest, depth === 0 ? torrentName : null, {
      depth,
      ancestors: roots,
    });
    if (!result.flattened) break;

    roots.push(path.basename(result.from));
    moved += result.moved;
  }

  return { moved, roots, renamed: renameSeasonFolders(dest, torrentName) };
}
