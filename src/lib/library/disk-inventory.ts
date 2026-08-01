/**
 * What is actually on the volume, and which of it anything in the app accounts for.
 *
 * ## The defect this answers
 *
 * The owner looked at the Client page, saw **zero** live transfers, and said
 * *"i cna't even see these on my downloads"* — while the download folder held
 * **40.42 GB**. Eight `EngineTorrent` rows sat at 0% holding fully preallocated
 * files, and separately there were whole release folders under the root that no
 * row accounted for at all (a 2,835 MB Guardians file among them). The storage
 * cap is computed from `getDirectorySizeBytesAsync(root)` — every byte under the
 * root, tracked or not — so those invisible bytes refused every Play through a
 * limit whose cause had no surface anywhere in the product.
 *
 * The app also never reconciles the other direction: the owner deleted a whole
 * series from Explorer and rows kept advertising it as partially downloaded.
 *
 * This module is the missing half. It walks the download root and puts every
 * file in exactly one of three buckets:
 *
 *  - **tracked**   — a live `EngineTorrent` row accounts for it.
 *  - **internal**  — the app's own bookkeeping (dot-prefixed top-level entries).
 *  - **orphan**    — real media nothing accounts for. The invisible bytes.
 *
 * ## Hard rules
 *
 * 1. **It never deletes.** This module only reads. Deletion lives behind an
 *    endpoint that re-derives orphan status from here, server-side.
 * 2. **`diskBytes === trackedBytes + orphanBytes + internalBytes`.** Every
 *    counted byte lands in exactly one bucket, so the headline number can be
 *    checked against Explorer. It is pinned by a test, not by this comment.
 * 3. **Truncation is reported, never silent.** Under-reporting is precisely the
 *    bug being fixed here; a walk that stopped early says so, loudly, so the UI
 *    can refuse to present a partial total as the whole truth.
 * 4. **Links are neither followed nor counted.** A junction or symlink can point
 *    outside the root (escaping containment) or back inside it (double-counting
 *    the same bytes). Both are wrong, so link entries are skipped and counted
 *    separately.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "@/lib/download/path-containment";

/** Total dirents the walk will examine before giving up (breadth cap). */
export const DEFAULT_MAX_ENTRIES = 50_000;

/** How many directory levels below the root the walk will descend (depth cap). */
export const DEFAULT_MAX_DEPTH = 12;

/** Most orphan groups returned to a caller. */
export const DEFAULT_MAX_GROUPS = 100;

/** Sample files kept per group so the owner can recognise it. */
export const DEFAULT_MAX_FILES_PER_GROUP = 12;

/**
 * How deep a group may sit before the tracked-purity lift stops raising it.
 *
 * TorrentFlow's own path layout is `root/<category>/<show-or-movie>/[Season NN]`
 * (see the smart-path rules in AGENTS.md), so two segments below the root is the
 * *release folder* — "Guardians of the Galaxy (2014)", "Rick and Morty" — which
 * is the thing the owner recognises and the thing they mean when they say
 * "delete that". Lifting further would offer them a whole category folder as one
 * row, which hides the very releases they asked to see.
 */
export const GROUP_BASE_DEPTH = 2;

export type DiskEntryKind = "tracked" | "internal" | "orphan";

/** The `EngineTorrent` columns needed to decide what a row accounts for. */
export interface TrackedTorrentRef {
  hash?: string | null;
  name?: string | null;
  savePath?: string | null;
  verifiedFilesJson?: string | null;
}

export interface DiskOrphanFile {
  /** POSIX-style path relative to the scan root. */
  relativePath: string;
  /** Absolute path on the machine running the app. */
  path: string;
  name: string;
  bytes: number;
  modifiedMs: number | null;
}

export interface DiskOrphanGroup {
  /**
   * POSIX-style path of the group directory relative to the root. Empty string
   * means the group is the loose files sitting directly under the root.
   */
  relativePath: string;
  /** Absolute path of the group directory (the root itself when `loose`). */
  path: string;
  /** The release folder's own name; empty for the loose-files group. */
  name: string;
  /** True for files sitting directly under the root with no release folder. */
  loose: boolean;
  bytes: number;
  fileCount: number;
  /**
   * Whether removing the group directory in one action is safe.
   *
   * False when the directory still holds tracked or app-internal files, and
   * always false for the loose group (its "directory" is the download root
   * itself). Those groups are deleted a file at a time instead.
   */
  folderDeletable: boolean;
  /** Largest files first, capped — `fileCount` is the real total. */
  files: DiskOrphanFile[];
  /** True when `files` is a sample rather than the whole group. */
  filesTruncated: boolean;
  /** Newest mtime in the group, for "when did this land". */
  modifiedMs: number | null;
}

/** Why a walk stopped short of seeing everything. */
export type DiskInventoryTruncation = "entries" | "depth";

export interface DiskInventoryReport {
  /** Absolute, symlink-resolved root the walk covered. */
  root: string;
  /** Every byte counted under the root. Compare this with Explorer. */
  diskBytes: number;
  trackedBytes: number;
  internalBytes: number;
  orphanBytes: number;
  fileCount: number;
  trackedFileCount: number;
  internalFileCount: number;
  orphanFileCount: number;
  orphans: DiskOrphanGroup[];
  /** True when `orphans` omits groups because of {@link DEFAULT_MAX_GROUPS}. */
  groupsTruncated: boolean;
  /** True when the walk itself did not see the whole tree. */
  truncated: boolean;
  /** Every reason the walk stopped short. Empty when `truncated` is false. */
  truncatedBy: DiskInventoryTruncation[];
  entriesScanned: number;
  /** Directories the OS refused to list — the permission-denied surface. */
  unreadablePaths: string[];
  /** Links skipped so they are neither followed out of the root nor counted twice. */
  linksSkipped: number;
  scannedAtMs: number;
  /**
   * `diskBytes` is authoritative only when complete. `partial` is a measured
   * lower bound; `unavailable` means even the root could not be inspected.
   */
  status: "complete" | "partial" | "unavailable";
  authoritative: boolean;
}

export interface DiskInventoryOptions {
  root: string;
  /** Live rows whose files must be classified as tracked. */
  tracked?: readonly TrackedTorrentRef[];
  /** Extra absolute file paths to treat as tracked (test seam). */
  trackedPaths?: readonly string[];
  maxEntries?: number;
  maxDepth?: number;
  maxGroups?: number;
  maxFilesPerGroup?: number;
  /**
   * Apply the "dot-prefixed top-level entry is app-internal" rule. Default true.
   * Set false when scanning a subtree rather than the download root itself.
   */
  internalTopLevelDot?: boolean;
}

// ---------------------------------------------------------------------------
// Path keys
// ---------------------------------------------------------------------------

const CASE_INSENSITIVE = process.platform === "win32";

function pathKey(target: string): string {
  const resolved = path.resolve(target);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** Absolute file paths an `EngineTorrent` row recorded at verification time. */
export function trackedFilePathsFromJson(
  verifiedFilesJson: string | null | undefined,
): string[] {
  if (!verifiedFilesJson?.trim()) return [];
  try {
    const parsed = JSON.parse(verifiedFilesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path.trim()
          : "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The paths a set of rows accounts for.
 *
 * Two kinds of claim, and the difference matters:
 *
 *  - **files** — exact paths the engine verified. Unambiguous.
 *  - **roots** — `savePath/name`, the torrent's own folder or single file. A
 *    row at 0% has no verified files yet but is absolutely holding a
 *    preallocated file there, and that was eight of the forty gigabytes.
 *
 * `savePath` **alone** is deliberately not a claim: several torrents share one
 * category folder, so treating it as tracked would mark the entire library as
 * accounted-for and hide every orphan — the exact failure this module exists to
 * end.
 */
export function trackedClaims(tracked: readonly TrackedTorrentRef[]): {
  files: Set<string>;
  roots: string[];
} {
  const files = new Set<string>();
  const roots: string[] = [];
  for (const row of tracked) {
    for (const file of trackedFilePathsFromJson(row.verifiedFilesJson)) {
      files.add(pathKey(file));
    }
    const save = row.savePath?.trim();
    const name = row.name?.trim();
    if (save && name) {
      const key = pathKey(path.join(save, name));
      if (!roots.includes(key)) roots.push(key);
    }
  }
  return { files, roots };
}

function isTrackedPath(
  key: string,
  claims: { files: Set<string>; roots: string[] },
): boolean {
  if (claims.files.has(key)) return true;
  return claims.roots.some(
    (root) => key === root || key.startsWith(root + path.sep),
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Which bucket a file belongs to, from its position and the live claims.
 *
 * Internal beats everything: the `.tf-test` scratch root's whole safety story
 * (see `test-support/scratch-dir.ts`) rests on a dot-prefixed top-level entry
 * never being presented to the owner as media of theirs to reclaim.
 */
export function classifyDiskEntry(input: {
  /** POSIX-style path relative to the root. */
  relativePath: string;
  /** Absolute path. */
  path: string;
  claims: { files: Set<string>; roots: string[] };
  /**
   * Whether the dot-prefixed top-level rule applies. Only true when the scan
   * root really is the download root — a sub-scan of one release folder must
   * not decide a stray `.DS_Store` in it is TorrentFlow bookkeeping.
   */
  internalTopLevelDot?: boolean;
}): DiskEntryKind {
  const first = input.relativePath.split("/")[0] ?? "";
  if (input.internalTopLevelDot !== false && first.startsWith(".")) {
    return "internal";
  }
  if (isTrackedPath(pathKey(input.path), input.claims)) return "tracked";
  return "orphan";
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  modifiedMs: number | null;
  kind: DiskEntryKind;
}

/**
 * Which release folder an orphan file belongs to.
 *
 * Start at the release-folder depth ({@link GROUP_BASE_DEPTH}) so the owner sees
 * "Guardians of the Galaxy (2014)", then descend for as long as that directory
 * still contains tracked or internal files. A group has to double as a delete
 * unit, so a folder that also holds something the app accounts for must never be
 * offered as one row — the walk pushes down until the group is pure, and if even
 * the file's own parent is impure the group says so via `folderDeletable`.
 */
export function orphanGroupKey(input: {
  /** POSIX-style path relative to the root. */
  relativePath: string;
  /** Relative directory paths (POSIX) known to hold tracked/internal files. */
  impureDirs: ReadonlySet<string>;
  baseDepth?: number;
}): string {
  const segments = input.relativePath.split("/");
  const dirs = segments.slice(0, -1);
  if (dirs.length === 0) return "";

  const base = Math.max(1, input.baseDepth ?? GROUP_BASE_DEPTH);
  let depth = Math.min(base, dirs.length);
  while (depth < dirs.length && input.impureDirs.has(dirs.slice(0, depth).join("/"))) {
    depth += 1;
  }
  return dirs.slice(0, depth).join("/");
}

function ancestorDirs(relativePath: string): string[] {
  const dirs = relativePath.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= dirs.length; i += 1) out.push(dirs.slice(0, i).join("/"));
  return out;
}

function buildGroups(
  files: readonly ScannedFile[],
  root: string,
  maxGroups: number,
  maxFilesPerGroup: number,
): { groups: DiskOrphanGroup[]; groupsTruncated: boolean } {
  const impureDirs = new Set<string>();
  for (const file of files) {
    if (file.kind === "orphan") continue;
    for (const dir of ancestorDirs(file.relativePath)) impureDirs.add(dir);
  }

  const byKey = new Map<string, ScannedFile[]>();
  for (const file of files) {
    if (file.kind !== "orphan") continue;
    const key = orphanGroupKey({ relativePath: file.relativePath, impureDirs });
    const bucket = byKey.get(key);
    if (bucket) bucket.push(file);
    else byKey.set(key, [file]);
  }

  const groups: DiskOrphanGroup[] = [];
  for (const [key, bucket] of byKey) {
    const bytes = bucket.reduce((sum, f) => sum + f.bytes, 0);
    const modified = bucket.reduce<number | null>(
      (max, f) => (f.modifiedMs != null && (max == null || f.modifiedMs > max) ? f.modifiedMs : max),
      null,
    );
    const sorted = [...bucket].sort((a, b) => b.bytes - a.bytes);
    const loose = key === "";
    groups.push({
      relativePath: key,
      path: loose ? root : path.join(root, ...key.split("/")),
      name: loose ? "" : (key.split("/").pop() ?? ""),
      loose,
      bytes,
      fileCount: bucket.length,
      folderDeletable: !loose && !impureDirs.has(key),
      files: sorted.slice(0, maxFilesPerGroup).map((f) => ({
        relativePath: f.relativePath,
        path: f.absolutePath,
        name: f.relativePath.split("/").pop() ?? f.relativePath,
        bytes: f.bytes,
        modifiedMs: f.modifiedMs,
      })),
      filesTruncated: sorted.length > maxFilesPerGroup,
      modifiedMs: modified,
    });
  }

  groups.sort((a, b) => b.bytes - a.bytes || a.relativePath.localeCompare(b.relativePath));
  return {
    groups: groups.slice(0, maxGroups),
    groupsTruncated: groups.length > maxGroups,
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function emptyReport(
  root: string,
  scannedAtMs: number,
  status: "complete" | "unavailable",
  unreadablePaths: string[] = [],
): DiskInventoryReport {
  return {
    root,
    diskBytes: 0,
    trackedBytes: 0,
    internalBytes: 0,
    orphanBytes: 0,
    fileCount: 0,
    trackedFileCount: 0,
    internalFileCount: 0,
    orphanFileCount: 0,
    orphans: [],
    groupsTruncated: false,
    truncated: false,
    truncatedBy: [],
    entriesScanned: 0,
    unreadablePaths,
    linksSkipped: 0,
    scannedAtMs,
    status,
    authoritative: status === "complete",
  };
}

/** How many unreadable directories are worth naming before the point is made. */
const MAX_UNREADABLE_REPORTED = 20;

/**
 * Walk the download root and account for every byte under it.
 *
 * Read-only. Never deletes, never follows a link out of the root, and never
 * pretends a truncated walk was a complete one.
 */
export async function scanDiskInventory(
  options: DiskInventoryOptions,
): Promise<DiskInventoryReport> {
  const rawRoot = options.root?.trim();
  const scannedAtMs = Date.now();
  if (!rawRoot) {
    return emptyReport("", scannedAtMs, "unavailable");
  }

  let root: string;
  try {
    root = await fsp.realpath(path.resolve(rawRoot));
  } catch {
    // Zero would be a dangerous claim here: the root may be full but temporarily
    // unreadable. Preserve the observed lower bound while marking it unavailable.
    const resolved = path.resolve(rawRoot);
    return emptyReport(resolved, scannedAtMs, "unavailable", [resolved]);
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
  const maxFilesPerGroup = options.maxFilesPerGroup ?? DEFAULT_MAX_FILES_PER_GROUP;

  const claims = trackedClaims(options.tracked ?? []);
  for (const extra of options.trackedPaths ?? []) claims.files.add(pathKey(extra));

  const files: ScannedFile[] = [];
  const unreadable: string[] = [];
  const truncatedBy = new Set<DiskInventoryTruncation>();
  let entriesScanned = 0;
  let linksSkipped = 0;
  let diskBytes = 0;
  let trackedBytes = 0;
  let internalBytes = 0;
  let orphanBytes = 0;
  let trackedFileCount = 0;
  let internalFileCount = 0;
  let orphanFileCount = 0;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    if (entriesScanned >= maxEntries) {
      truncatedBy.add("entries");
      break;
    }
    const { dir, depth } = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      if (unreadable.length < MAX_UNREADABLE_REPORTED) unreadable.push(dir);
      continue;
    }

    for (const entry of entries) {
      if (entriesScanned >= maxEntries) {
        truncatedBy.add("entries");
        break;
      }
      entriesScanned += 1;
      const absolutePath = path.join(dir, entry.name);

      // Links are the one thing that can both escape the root and count the
      // same bytes twice, so they are skipped outright rather than resolved.
      if (entry.isSymbolicLink()) {
        linksSkipped += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) {
          truncatedBy.add("depth");
          continue;
        }
        stack.push({ dir: absolutePath, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      let bytes = 0;
      let modifiedMs: number | null = null;
      try {
        const stat = await fsp.lstat(absolutePath);
        if (!stat.isFile()) continue;
        bytes = stat.size;
        modifiedMs = stat.mtimeMs;
      } catch {
        if (unreadable.length < MAX_UNREADABLE_REPORTED) unreadable.push(absolutePath);
        continue;
      }

      const relativePath = toPosix(path.relative(root, absolutePath));
      const kind = classifyDiskEntry({
        relativePath,
        path: absolutePath,
        claims,
        internalTopLevelDot: options.internalTopLevelDot,
      });

      diskBytes += bytes;
      if (kind === "tracked") {
        trackedBytes += bytes;
        trackedFileCount += 1;
      } else if (kind === "internal") {
        internalBytes += bytes;
        internalFileCount += 1;
      } else {
        orphanBytes += bytes;
        orphanFileCount += 1;
      }

      files.push({ relativePath, absolutePath, bytes, modifiedMs, kind });
    }
  }

  const { groups, groupsTruncated } = buildGroups(
    files,
    root,
    maxGroups,
    maxFilesPerGroup,
  );

  const partial = truncatedBy.size > 0 || unreadable.length > 0;
  return {
    root,
    diskBytes,
    trackedBytes,
    internalBytes,
    orphanBytes,
    fileCount: files.length,
    trackedFileCount,
    internalFileCount,
    orphanFileCount,
    orphans: groups,
    groupsTruncated,
    truncated: truncatedBy.size > 0,
    truncatedBy: [...truncatedBy],
    entriesScanned,
    unreadablePaths: unreadable,
    linksSkipped,
    scannedAtMs,
    status: partial ? "partial" : "complete",
    authoritative: !partial,
  };
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

/**
 * A full walk runs on every settings read, and the tree does not change by the
 * second. Short enough that a delete is reflected almost immediately, long
 * enough that opening the panel does not re-walk the library per request.
 */
export const DISK_INVENTORY_TTL_MS = 15_000;

const inventoryCache = new Map<string, { at: number; report: DiskInventoryReport }>();

export function resetDiskInventoryCache(): void {
  inventoryCache.clear();
}

function cacheKey(options: DiskInventoryOptions): string {
  const claims = trackedClaims(options.tracked ?? []);
  return [
    pathKey(options.root ?? ""),
    claims.files.size,
    claims.roots.length,
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
  ].join("|");
}

export async function scanDiskInventoryCached(
  options: DiskInventoryOptions & { ttlMs?: number; now?: number },
): Promise<DiskInventoryReport> {
  const ttl = options.ttlMs ?? DISK_INVENTORY_TTL_MS;
  const now = options.now ?? Date.now();
  const key = cacheKey(options);
  const hit = inventoryCache.get(key);
  if (hit && now - hit.at < ttl) return hit.report;
  const report = await scanDiskInventory(options);
  inventoryCache.set(key, { at: now, report });
  return report;
}

// ---------------------------------------------------------------------------
// Delete-target resolution (still read-only)
// ---------------------------------------------------------------------------

export type OrphanTargetRefusal =
  | "no-root"
  | "empty-path"
  | "not-relative"
  | "escapes-root"
  | "is-root"
  | "internal"
  | "missing"
  | "tracked"
  | "contains-tracked"
  | "inventory-incomplete"
  | "unsupported-type";

export type OrphanTargetResolution =
  | {
      ok: true;
      /** Real, containment-checked absolute path safe to remove. */
      path: string;
      relativePath: string;
      kind: "file" | "directory";
      bytes: number;
      fileCount: number;
    }
  | { ok: false; reason: OrphanTargetRefusal; message: string };

const REFUSAL_MESSAGES: Record<OrphanTargetRefusal, string> = {
  "no-root": "No download folder is configured, so nothing can be removed.",
  "empty-path": "No file or folder was named.",
  "not-relative":
    "Only paths inside your download folder can be removed — give a path relative to it.",
  "escapes-root": "That path resolves outside your download folder.",
  "is-root": "The download folder itself is never removed.",
  internal: "That entry belongs to TorrentFlow's own bookkeeping, not to your media.",
  missing: "That file or folder is no longer there.",
  tracked: "A live transfer still owns that file. Remove the transfer instead.",
  "contains-tracked":
    "That folder still holds files a live transfer owns, so it cannot be removed as a whole.",
  "inventory-incomplete":
    "The folder could not be inspected completely. Check folder permissions or remove a smaller subfolder, then try again.",
  "unsupported-type": "Only regular files and folders can be removed.",
};

function refuse(reason: OrphanTargetRefusal): OrphanTargetResolution {
  return { ok: false, reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * Is this client-supplied relative path syntactically allowed to be resolved?
 *
 * Rejected *before* touching the filesystem: absolute paths, drive letters, UNC
 * shares, and any `..` segment. A path that survives this still has to pass a
 * realpath containment check — a junction inside the root looks perfectly
 * innocent here and can still point at `C:\Windows`.
 */
export function isSafeRelativeEntryPath(raw: string): boolean {
  const value = raw?.trim();
  if (!value) return false;
  if (value.includes("\0")) return false;
  if (value.startsWith("\\\\") || value.startsWith("//")) return false;
  if (/^[a-zA-Z]:[\\/]?/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === "..")) return false;
  return true;
}

/**
 * Re-derive, server-side, whether a path the client named is really an orphan.
 *
 * The client sends a relative path and nothing else. Everything that decides
 * whether those bytes may be removed — containment, internal-entry status,
 * whether a live torrent owns the file, whether a folder is pure — is recomputed
 * here from the filesystem and the current rows.
 */
export async function resolveOrphanTarget(options: {
  root: string;
  relativePath: string;
  tracked?: readonly TrackedTorrentRef[];
  maxEntries?: number;
  maxDepth?: number;
  /** Test seam for incomplete-inventory authorization cases. */
  _scanInventory?: typeof scanDiskInventory;
}): Promise<OrphanTargetResolution> {
  const rawRoot = options.root?.trim();
  if (!rawRoot) return refuse("no-root");
  if (!options.relativePath?.trim()) return refuse("empty-path");
  if (!isSafeRelativeEntryPath(options.relativePath)) return refuse("not-relative");

  let root: string;
  try {
    root = await fsp.realpath(path.resolve(rawRoot));
  } catch {
    return refuse("no-root");
  }

  const segments = options.relativePath
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (segments[0]?.startsWith(".")) return refuse("internal");

  const requested = path.resolve(root, ...segments);
  if (!isInsideRoot(requested, root)) return refuse("escapes-root");
  if (pathKey(requested) === pathKey(root)) return refuse("is-root");

  // realpath collapses junctions and symlinks anywhere along the path, which is
  // the only way to catch a reparse point inside the root that leaves it.
  let real: string;
  try {
    real = await fsp.realpath(requested);
  } catch {
    return refuse("missing");
  }
  if (!isInsideRoot(real, root)) return refuse("escapes-root");
  if (pathKey(real) === pathKey(root)) return refuse("is-root");

  let stat: import("node:fs").Stats;
  try {
    stat = await fsp.lstat(real);
  } catch {
    return refuse("missing");
  }
  if (stat.isSymbolicLink()) return refuse("escapes-root");

  const claims = trackedClaims(options.tracked ?? []);
  const relativePath = toPosix(path.relative(root, real));

  // A live transfer's own folder is refused as a folder, not merely as "it
  // contains something tracked" — the owner should be told the transfer owns it.
  if (isTrackedPath(pathKey(real), claims)) return refuse("tracked");

  if (stat.isFile()) {
    if (isTrackedPath(pathKey(real), claims)) return refuse("tracked");
    return {
      ok: true,
      path: real,
      relativePath,
      kind: "file",
      bytes: stat.size,
      fileCount: 1,
    };
  }

  if (!stat.isDirectory()) return refuse("unsupported-type");

  const scanInventory = options._scanInventory ?? scanDiskInventory;
  const inventory = await scanInventory({
    root: real,
    tracked: options.tracked,
    maxEntries: options.maxEntries,
    maxDepth: options.maxDepth,
    // Below the download root a dot-prefixed name is just a stray file
    // (`.DS_Store`, `.nfo` sidecars), not TorrentFlow bookkeeping. Applying the
    // top-level rule here would misclassify it as internal and both under-count
    // the folder's reclaimable bytes and refuse the delete.
    internalTopLevelDot: false,
  });
  // Recursive deletion needs positive proof that every descendant was seen.
  // Truncation, unreadable directories, and stat failures all make a scan
  // non-authoritative; "probably orphaned" is not a licence to delete.
  if (!inventory.authoritative || inventory.status !== "complete") {
    return refuse("inventory-incomplete");
  }
  if (inventory.trackedBytes > 0 || inventory.trackedFileCount > 0) {
    return refuse("contains-tracked");
  }

  return {
    ok: true,
    path: real,
    relativePath,
    kind: "directory",
    bytes: inventory.diskBytes,
    fileCount: inventory.fileCount,
  };
}
