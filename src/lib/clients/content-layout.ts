/**
 * Content layout — where a torrent's files land inside our save path.
 *
 * A multi-file torrent states its paths relative to a folder named after the
 * release, and WebTorrent writes `savePath + dirname(file.path)`. Since we
 * always compute the save path ourselves (`Anime/Solo Leveling/Season 01`),
 * that container folder is redundant and we end up with
 * `…/Season 01/Solo Leveling 1080p … x265-EMBER/…`.
 *
 * qBittorrent solves this with `contentLayout=NoSubfolder`, which drops the
 * container root. WebTorrent has no equivalent, so we do it ourselves.
 *
 * Some packs wrap twice, e.g.
 *   `Solo Leveling 1080p … EMBER/Solo Leveling S01 1080p … EMBER/`
 * so one level is not always enough. But "this folder is the only child" is
 * NOT evidence that it is redundant — every rule about what a folder means
 * lives in `content-layout-policy.ts`, shared with the on-disk repair.
 */
import {
  destinationKeys,
  destinationNamesSeason,
  mayDropFolder,
  physicalKey,
  seasonFolderRename,
  segments,
} from "./content-layout-policy";

export type TorrentFileLike = { path: string; length?: number };

export type LayoutPlan = {
  /** Folders dropped, outermost first. */
  roots: string[];
  /** Release folders renamed to `Season NN`, as `from → to`. */
  renamed: string[];
  /** New path for each file, in the same order as the input. */
  paths: string[];
};

/**
 * Works out which container folders to drop.
 *
 * Returns `null` to leave the layout untouched — every ambiguity resolves that
 * way, because a wrong rewrite writes real bytes to the wrong place.
 *
 * @param files    the torrent's files, in torrent order
 * @param destPath where the torrent is being saved; used to spot a folder that
 *                 merely repeats a destination component
 */
export function planContentLayout(
  files: readonly TorrentFileLike[],
  destPath?: string | null,
): LayoutPlan | null {
  if (files.length === 0) return null;

  let split = files.map((f) => segments(f.path));

  // Reject traversal in the input rather than the output: stripping consumes
  // leading segments, so a `..` would be eaten before any output check saw it.
  if (split.some((s) => s.some((seg) => seg === ".." || seg === "."))) {
    return null;
  }

  const destKeys = destinationKeys(destPath);
  const roots: string[] = [];

  // Bounded purely as a loop guard; two is the deepest wrap seen in practice.
  for (let depth = 0; depth < 8; depth++) {
    // A file at the top level means we have reached the content.
    if (split.some((s) => s.length < 2)) break;

    const root = split[0][0];
    if (!split.every((s) => s[0] === root)) break;
    if (!mayDropFolder(root, depth, destKeys, roots)) break;

    split = split.map((s) => s.slice(1));
    roots.push(root);
  }

  // A multi-season pack keeps its season folders — dropping them would merge
  // two S01E01s — but they arrive named after the release, not the season.
  // Skipped when the destination already names a season: the only way to be
  // under `Season 01` holding an S02 folder is a mis-detection upstream, and
  // `Season 01/Season 02` is not an improvement on leaving it alone.
  const renamed: string[] = [];
  if (!destinationNamesSeason(destPath)) {
    const renameOf = new Map<string, string | null>();
    split = split.map((s) => {
      if (s.length < 2) return s;
      const from = s[0];
      if (!renameOf.has(from)) {
        const to = seasonFolderRename(from);
        renameOf.set(from, to);
        if (to) renamed.push(`${from} → ${to}`);
      }
      const to = renameOf.get(from);
      return to ? [to, ...s.slice(1)] : s;
    });
  }

  if (roots.length === 0 && renamed.length === 0) return null;

  const paths = split.map((s) => s.join("/"));
  if (paths.some((p) => !p)) return null;

  // Two files must never collapse onto one path. Compared the way the
  // filesystem sees them, not as raw strings: the store strips reserved
  // characters from basenames and Windows ignores case.
  const keys = new Set(paths.map(physicalKey));
  if (keys.size !== paths.length) return null;

  return { roots, renamed, paths };
}

/** What the caller found at a path we are about to write to. */
export type ExistingFile = {
  /** Size on disk. */
  size: number;
  /** Info hash that claimed it, if any. */
  owner: string | null;
  /** True when a directory sits where we want a file. */
  isDirectory?: boolean;
};

/**
 * Applies {@link planContentLayout} in place. Returns the plan that was
 * applied, or null when nothing changed.
 *
 * `existingAt` lets the caller veto a rewrite that would land on a file
 * another torrent already owns — flattening several episode releases into one
 * season folder can otherwise point two active stores at the same
 * `sample.mkv` and let each verify over the other.
 */
export function applyContentLayout(
  torrent: {
    infoHash?: string | null;
    path?: string | null;
    files?: TorrentFileLike[] | null;
  },
  existingAt?: (relativePath: string) => ExistingFile | null,
  claim?: (paths: readonly string[]) => boolean,
): LayoutPlan | null {
  const files = torrent.files;
  if (!Array.isArray(files)) return null;

  const plan = planContentLayout(files, torrent.path);
  if (!plan) return null;

  if (existingAt) {
    const self = torrent.infoHash?.toLowerCase() ?? null;
    for (let i = 0; i < plan.paths.length; i++) {
      const found = existingAt(plan.paths[i]);
      if (!found) continue;

      // Ours by record: resume data, whatever its size.
      if (self && found.owner === self) continue;

      const reason = found.isDirectory
        ? "a directory is in the way"
        : found.owner
          ? `it belongs to torrent ${found.owner.slice(0, 8)}`
          : found.size !== files[i].length
            ? "a file of a different size is already there"
            : null;

      if (reason) {
        console.warn(
          `[content-layout] keeping the release folder — "${plan.paths[i]}" would collide: ${reason}`,
        );
        return null;
      }
      // Unclaimed and the right size: a download of ours from before the
      // manifest existed. Claimed below along with the rest.
    }
  }

  // Claim before writing. If the record cannot be made durable, the next
  // torrent has no way to tell these files from its own resume data — so we
  // decline to flatten rather than write files we cannot account for.
  if (claim && !claim(plan.paths)) {
    console.warn(
      "[content-layout] keeping the release folder — ownership could not be recorded",
    );
    return null;
  }

  files.forEach((file, i) => {
    file.path = plan.paths[i];
  });
  return plan;
}

const PATCHED = Symbol.for("torrentflow.contentLayoutPatched");

type Proto = Record<string, unknown>;

/** Looks up what is already at a path, or null if nothing is. */
export type ExistingFileProbe = (
  dest: string,
  relativePath: string,
) => ExistingFile | null;

/** Records the paths a torrent now owns; false if it could not be recorded. */
export type ClaimPaths = (
  infoHash: string,
  dest: string,
  paths: readonly string[],
) => boolean;

/**
 * Rewrites file paths on the way in.
 *
 * `_processParsedTorrent` is the last point before the chunk store is built
 * from `files`, and `torrentFile` has already been serialised by then, so the
 * info hash is unaffected. Idempotent; the prototype is shared process-wide.
 */
export function patchTorrentContentLayout(
  torrentPrototype: object,
  existingAt?: ExistingFileProbe,
  claim?: ClaimPaths,
): void {
  const proto = torrentPrototype as Proto;
  if (proto[PATCHED as unknown as string]) return;

  const original = proto._processParsedTorrent;
  if (typeof original !== "function") return;
  Object.defineProperty(proto, PATCHED, { value: true, enumerable: false });

  const fn = original as (...args: unknown[]) => unknown;
  proto._processParsedTorrent = function patched(
    this: {
      name?: string;
      path?: string;
      infoHash?: string;
      files?: TorrentFileLike[];
      skipVerify?: boolean;
      _preloadedStore?: unknown;
    },
    ...args: unknown[]
  ) {
    const result = fn.apply(this, args);
    try {
      // `client.seed()` sets skipVerify, and a preloaded store is already
      // bound to the on-disk names. In both cases the bytes exist at the paths
      // the torrent states, so rewriting them would point the store at files
      // that are not there.
      if (this.skipVerify || this._preloadedStore) return result;

      const dest = this.path;
      const probe =
        existingAt && dest ? (rel: string) => existingAt(dest, rel) : undefined;
      const record =
        claim && dest && this.infoHash
          ? (paths: readonly string[]) => claim(this.infoHash!, dest, paths)
          : undefined;

      const plan = applyContentLayout(this, probe, record);
      if (plan) {
        const what = [
          plan.roots.length
            ? `removed ${plan.roots.length} wrapper folder${plan.roots.length === 1 ? "" : "s"}`
            : null,
          plan.renamed.length ? `renamed ${plan.renamed.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ");
        console.info(
          `[content-layout] ${this.name ?? "torrent"} → ${
            dest || "the save path"
          }: ${what}`,
        );
      }
    } catch (err) {
      // A layout tweak must never stop a download from starting.
      console.warn(
        "[content-layout] rewrite failed",
        err instanceof Error ? err.message : err,
      );
    }
    return result;
  };
}

/**
 * Reaches the Torrent class by deep import — webtorrent ships no `exports`
 * map for it. Returns false rather than throwing so a webtorrent upgrade that
 * moves the file degrades to the on-disk repair instead of breaking downloads.
 */
export async function patchWebTorrentContentLayout(
  existingAt?: ExistingFileProbe,
  claim?: ClaimPaths,
): Promise<boolean> {
  try {
    const mod: unknown = await import(
      /* webpackIgnore: true */ "webtorrent/lib/torrent.js"
    );
    const ctor = (mod as { default?: unknown })?.default ?? mod;
    const proto = (ctor as { prototype?: object })?.prototype;
    if (!proto) return false;
    patchTorrentContentLayout(proto, existingAt, claim);
    return true;
  } catch {
    return false;
  }
}
