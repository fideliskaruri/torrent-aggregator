/**
 * Best-effort layout fix for clients that nest multi-file torrents under
 * a junk release-name folder:
 *
 *   {savePath}/Family.Guy.S24E11.1080p.WEB/video.mkv  → wrong
 *   {savePath}/video.mkv                              → correct
 *
 * qBittorrent: use contentLayout=NoSubfolder (see qbittorrent.ts).
 * WebTorrent (builtin): no equivalent option — flatten after metadata/done
 * when every file shares a single top-level folder that looks like a
 * release root (matches torrent name or scene-style slug).
 *
 * Never flatten:
 *   - Clean season folders ("Season 01")
 *   - Multi-child dest (already mixed content)
 *   - Nested intentional trees with multiple top-level siblings
 */
import fs from "node:fs";
import path from "node:path";

/** Normalize for comparing torrent name ↔ folder name. */
export function normalizeReleaseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a single top-level directory looks like a torrent release root
 * that should not appear under our smart Category/Show/Season path.
 */
export function isJunkReleaseRoot(
  folderName: string,
  torrentName?: string | null,
): boolean {
  const name = folderName.trim();
  if (!name) return false;

  // Legitimate Sonarr-style season folder — keep
  if (/^Season\s+\d{1,3}$/i.test(name)) return false;
  // Bare "Specials" / "Extras" keep
  if (/^(specials?|extras?|featurettes?)$/i.test(name)) return false;

  if (torrentName?.trim()) {
    if (normalizeReleaseKey(name) === normalizeReleaseKey(torrentName)) {
      return true;
    }
  }

  // Scene / p2p release slug: dotted title + quality/episode tokens
  const spaced = name.replace(/[._]+/g, " ");
  if (
    name.includes(".") &&
    /\b(S\d{1,3}E\d{1,4}|\d{1,2}x\d{1,4}|\d{3,4}p|WEB-?DL|WEBRip|BluRay|HDTV|x264|x265|h\.?264|h\.?265|HEVC)\b/i.test(
      spaced,
    )
  ) {
    return true;
  }

  // Bracketed fansub folder matching common multi-file packs
  if (/^\[[^\]]+\]/.test(name) && /\d{3,4}p|episode|ep\s*\d/i.test(spaced)) {
    return true;
  }

  return false;
}

export type FlattenResult =
  | { flattened: true; from: string; moved: number }
  | { flattened: false; reason: string };

/**
 * If `dest` contains exactly one child directory that is a junk release root
 * (and no other non-junk siblings), move its contents up into `dest` and
 * remove the empty root.
 *
 * Safe to call multiple times (no-op when already flat).
 * Does not touch open file handles — call after torrent `done` when possible.
 */
export function flattenSingleReleaseRoot(
  dest: string,
  torrentName?: string | null,
): FlattenResult {
  const root = dest?.trim();
  if (!root) return { flattened: false, reason: "empty dest" };

  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { flattened: false, reason: "dest missing" };
    }
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return {
      flattened: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());

  // Already has loose files at dest root → do not risk merging mid-download mess
  if (files.length > 0) {
    return { flattened: false, reason: "dest already has files at root" };
  }
  if (dirs.length !== 1) {
    return {
      flattened: false,
      reason:
        dirs.length === 0
          ? "no subfolder"
          : `multiple subfolders (${dirs.length})`,
    };
  }

  const only = dirs[0];
  if (!isJunkReleaseRoot(only.name, torrentName)) {
    return {
      flattened: false,
      reason: `subfolder not junk release root: ${only.name}`,
    };
  }

  const from = path.join(root, only.name);
  let moved = 0;
  try {
    const inner = fs.readdirSync(from, { withFileTypes: true });
    for (const child of inner) {
      const src = path.join(from, child.name);
      const target = path.join(root, child.name);
      if (fs.existsSync(target)) {
        // Collision — skip this entry rather than overwrite
        continue;
      }
      fs.renameSync(src, target);
      moved++;
    }
    // Remove empty residual tree
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  } catch (err) {
    return {
      flattened: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (moved === 0) {
    return { flattened: false, reason: "nothing moved" };
  }
  return { flattened: true, from, moved };
}
