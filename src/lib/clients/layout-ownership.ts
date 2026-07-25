/**
 * Which torrent owns which file on disk.
 *
 * Flattening several releases into one season folder points two chunk stores
 * at the same directory. Without a record of who wrote what, the only signal
 * available is "a file of the same size is already there" — and same size is
 * not the same file. Fixed-size RAR volumes, `.pad` files, zero-length
 * placeholders and two encodes of the same source all collide that way, and
 * the loser gets verified over by the winner's pieces.
 *
 * So we write it down. A path claimed by another info hash is never treated as
 * resume data, whatever its size.
 *
 * Deliberately a JSON sidecar rather than a schema change: it has to be
 * readable before a torrent is added and before Prisma is necessarily up, and
 * losing it is survivable — the worst case is falling back to the size check.
 */
import fs from "node:fs";
import path from "node:path";

import { physicalKey } from "./content-layout-policy";

type Manifest = Record<string, { infoHash: string; dest: string }>;

const FILE = path.join(process.cwd(), ".torrentflow-layout.json");

let cache: Manifest | null = null;

function load(): Manifest {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = {};
    if (parsed && typeof parsed === "object") {
      // Validate rather than trust: a half-written file must not silently
      // become a manifest full of undefined owners.
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = v as { infoHash?: unknown; dest?: unknown };
        if (typeof e?.infoHash === "string" && typeof e?.dest === "string") {
          cache[k] = { infoHash: e.infoHash, dest: e.dest };
        }
      }
    }
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Replaces the manifest atomically. Returns false if it could not be written.
 *
 * A truncate-then-write would leave an empty or half-parsed file if the
 * process died or the disk filled — and an empty manifest silently restores
 * exactly the cross-torrent overwriting this exists to prevent. So we write a
 * sibling and rename, which is atomic on both NTFS and ext4.
 */
function persist(): boolean {
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache ?? {}), "utf8");
    fs.renameSync(tmp, FILE);
    return true;
  } catch (err) {
    console.warn(
      "[layout-ownership] could not persist",
      err instanceof Error ? err.message : err,
    );
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Stable key for a file, matching how the filesystem sees it. */
function keyFor(dest: string, relativePath: string): string {
  return `${physicalKey(path.resolve(dest))}\u0000${physicalKey(relativePath)}`;
}

/**
 * The info hash that claimed this path, or null if nobody has.
 *
 * Note the difference from "no file is there": an unclaimed path with a file
 * on it is either a pre-manifest download of ours or somebody else's data.
 */
export function ownerOf(dest: string, relativePath: string): string | null {
  const entry = load()[keyFor(dest, relativePath)];
  return entry ? entry.infoHash : null;
}

/**
 * Records that `infoHash` owns these paths under `dest`.
 *
 * Returns false if the claim could not be written down. The caller must then
 * NOT flatten: without a durable record the next torrent has no way to tell
 * these files from its own resume data, which is the corruption this whole
 * mechanism exists to stop. Failing to flatten only costs a nested folder.
 */
export function claimPaths(
  infoHash: string,
  dest: string,
  relativePaths: readonly string[],
): boolean {
  if (!infoHash || !dest || relativePaths.length === 0) return false;
  const m = load();
  const hash = infoHash.toLowerCase();
  const added: string[] = [];
  for (const rel of relativePaths) {
    const k = keyFor(dest, rel);
    if (!(k in m)) added.push(k);
    m[k] = { infoHash: hash, dest };
  }
  if (persist()) return true;

  // Roll the in-memory view back so it cannot disagree with the file on disk.
  for (const k of added) delete m[k];
  return false;
}

/**
 * Forgets what `infoHash` owned under one destination.
 *
 * Scoped to the destination on purpose: the same torrent can have been
 * downloaded to two places and only one of them deleted, and dropping the
 * surviving location's claim would expose those files to being overwritten.
 */
export function releasePaths(infoHash: string, dest?: string): void {
  const m = load();
  const hash = infoHash.toLowerCase();
  const scope = dest ? path.resolve(dest) : null;
  let changed = false;
  for (const [k, v] of Object.entries(m)) {
    if (v.infoHash !== hash) continue;
    if (scope && path.resolve(v.dest) !== scope) continue;
    delete m[k];
    changed = true;
  }
  if (changed) persist();
}

/** Test seam — drops the in-process cache. */
export function resetOwnershipCache(): void {
  cache = null;
}
