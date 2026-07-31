/**
 * On-disk cache of resolved torrent metadata, so a finished download can play
 * with no network at all.
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo already has a deliberate disk fast path: `openVerifiedDiskStream`
 * (see `clients/disk-fastpath.ts`) serves fully-verified bytes straight from the
 * file and never touches the WebTorrent stream. It works. It is simply
 * unreachable from a cold start, and this is why:
 *
 *   GET /api/stream/<hash>/<file>
 *     → findBuiltinTorrentFile()
 *       → ensureClientAndRehydrate()
 *         → rehydrateFromDb()  — re-adds every row by **magnet**
 *
 * A magnet carries no metadata. WebTorrent has to fetch the info dictionary from
 * the swarm before it knows the torrent has any files at all. With the network
 * restricted, `ready` never fires, the rehydrate timer destroys the handle, and
 * `findBuiltinTorrentFile` answers `not_found` (or `metadata_pending` while it is
 * still trying). The route returns 404/425 and never reaches line 583 where the
 * disk fast path lives.
 *
 * So the fast path did not regress — it was never reachable for a torrent that
 * had to be rehydrated, because its own precondition was network-dependent.
 *
 * THE FIX
 * -------
 * Metadata is a fact about the release, not about the swarm. Once we have it we
 * should never need to ask the network for it again. `torrent.torrentFile` is
 * the bencoded .torrent; adding *that* resolves metadata locally and synchronously
 * — `ready` fires, `files`/`pieceLength`/`_hashes` populate — with the swarm
 * unreachable. Combined with the persisted verified bitfield, the disk fast path
 * then serves a completed file offline, which is what the app's own
 * "Ready — Downloaded in full. Plays instantly and seeks anywhere" already claims.
 *
 * Cached beside the media rather than in a new column: no migration, and it
 * travels with the download folder it describes.
 */
import fs from "node:fs";
import path from "node:path";

export const METADATA_CACHE_DIRNAME = path.join(".torrentflow", "metadata");

/** A `.torrent` is small; anything larger is not one and is refused. */
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export type MetadataFs = {
  mkdir: (dir: string) => void;
  writeFile: (file: string, bytes: Uint8Array) => void;
  readFile: (file: string) => Uint8Array | null;
  removeFile: (file: string) => void;
  /** Remove a directory only when it is already empty. Never recursive. */
  removeEmptyDir?: (dir: string) => void;
};

export const realMetadataFs: MetadataFs = {
  mkdir: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  writeFile: (file, bytes) => {
    // Write-then-rename: a half-written .torrent read by a later rehydrate would
    // fail to parse and silently push us back onto the magnet (i.e. back online).
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  },
  readFile: (file) => {
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_METADATA_BYTES) {
        return null;
      }
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  },
  removeFile: (file) => {
    fs.rmSync(file, { force: true });
  },
  // `rmdir` without `recursive` fails on a non-empty directory, which is
  // exactly the guarantee wanted here: this must never be able to take media
  // with it, however wrong the path it is handed.
  removeEmptyDir: (dir) => {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty, or gone — either is fine */
    }
  },
};

/** Lowercase 40-hex, or null. Anything else must never become a file name. */
export function normalizeMetadataHash(hash: string | null | undefined): string | null {
  const h = (hash ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(h) ? h : null;
}

export function metadataCacheDir(root: string): string | null {
  const base = (root ?? "").trim();
  return base ? path.join(path.resolve(base), METADATA_CACHE_DIRNAME) : null;
}

export function torrentMetadataPath(root: string, hash: string): string | null {
  const dir = metadataCacheDir(root);
  const normalized = normalizeMetadataHash(hash);
  return dir && normalized ? path.join(dir, `${normalized}.torrent`) : null;
}

/**
 * Persist a resolved info dictionary. Best-effort by design: failing to cache
 * metadata must never fail an add, it only costs a future offline start.
 */
export function saveTorrentMetadata(
  root: string,
  hash: string,
  bytes: Uint8Array | null | undefined,
  io: MetadataFs = realMetadataFs,
): boolean {
  const file = torrentMetadataPath(root, hash);
  if (!file) return false;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
  if (bytes.length > MAX_METADATA_BYTES) return false;
  try {
    io.mkdir(path.dirname(file));
    io.writeFile(file, bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The add input that needs no swarm, or null if we have never seen this
 * torrent's metadata.
 */
export function loadTorrentMetadata(
  root: string,
  hash: string,
  io: MetadataFs = realMetadataFs,
): Uint8Array | null {
  const file = torrentMetadataPath(root, hash);
  if (!file) return null;
  const bytes = io.readFile(file);
  return bytes && bytes.length > 0 ? bytes : null;
}

/**
 * Drop a release's cached metadata, and the cache folders if they empty out.
 *
 * ## Why this has to be called, and was not
 *
 * The cache exists so a **downloaded** release can be re-added and played with
 * no swarm. Once its files are gone that purpose is gone with them: what
 * remains is a ~17 KB `.torrent` describing media that no longer exists.
 *
 * This function was written and unit-tested from the start and then never
 * wired into a single production path. Measured live: downloading an album and
 * choosing "delete torrent and files" reported *"Removed torrent and files"*
 * and left `.torrentflow/metadata/<hash>.torrent` behind. Every user delete
 * leaked one, and so did every stream-cache eviction — and the retention sweep
 * evicts continuously.
 *
 * That made it the worst shape a leak can take: unbounded, automatic, and
 * **invisible** — `disk-inventory` classifies dot-prefixed entries as
 * app-internal, so these never appeared in the orphan list the owner can see.
 *
 * The rule is simply that metadata follows the files. Deleting a torrent while
 * *keeping* its files must NOT call this: the files are still playable, and
 * throwing the metadata away would put that release back on the network.
 */
export function forgetTorrentMetadata(
  root: string,
  hash: string,
  io: MetadataFs = realMetadataFs,
): void {
  const file = torrentMetadataPath(root, hash);
  if (!file) return;
  try {
    io.removeFile(file);
  } catch {
    /* best-effort */
  }
  // Leaving `.torrentflow/metadata/` behind as an empty pair of folders in every
  // category directory is a smaller mess than the files, but it is still litter
  // the owner did not create. `removeEmptyDir` refuses non-empty directories, so
  // this can never reach a sibling that still holds cached metadata.
  if (!io.removeEmptyDir) return;
  try {
    const metadataDir = path.dirname(file);
    io.removeEmptyDir(metadataDir);
    io.removeEmptyDir(path.dirname(metadataDir));
  } catch {
    /* best-effort */
  }
}

/**
 * What to hand `client.add` for a torrent we want back in the engine.
 *
 * Cached metadata wins over the magnet whenever we have it: the magnet is a
 * *request to the swarm* for something we already know. Falling back to the URI
 * keeps first-ever adds and any torrent whose cache was pruned working exactly
 * as before.
 */
export function preferredAddInput(
  root: string,
  hash: string,
  fallbackUri: string,
  io: MetadataFs = realMetadataFs,
): { input: string | Uint8Array; source: "metadata" | "uri" } {
  const cached = loadTorrentMetadata(root, hash, io);
  return cached ? { input: cached, source: "metadata" } : { input: fallbackUri, source: "uri" };
}
