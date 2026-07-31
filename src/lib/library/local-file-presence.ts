/**
 * Does the file behind a local claim still exist?
 *
 * ## The defect this answers
 *
 * The owner deleted a downloaded series from Explorer. Nothing in the app
 * deletes `EngineTorrent` or `PlaybackProgress` when files vanish from under
 * it, so the episode row kept advertising **"Partial · Resume at 24:28"** with
 * a Resume button that could only ever open an empty player. An availability
 * claim must not outlive its file.
 *
 * ## `unknown` is not `absent`
 *
 * Same discipline as `browse/availability.ts` (`null` "nobody checked" is not
 * `unavailable` "checked, found nothing") and `torrents/swarm-probe.ts` (a
 * swarm we never reached is not a swarm we proved empty). Dropping a claim is
 * itself a claim: get it wrong and the viewer loses the Play button for a file
 * they actually hold. So `absent` requires positive evidence — a path we
 * recorded and the filesystem says is not there — and everything else (no
 * recorded path, an unreadable directory, a permissions error) is `unknown`,
 * which changes nothing.
 *
 * ## What counts as evidence
 *
 * 1. `EngineTorrent.verifiedFilesJson` — the absolute paths the engine recorded
 *    the last time it verified this torrent. This is exact: those files either
 *    are there or they are not.
 * 2. `EngineTorrent.savePath` — the directory the torrent was written into. Its
 *    existence does not prove *this* torrent's file is inside it (several
 *    torrents share a category folder), so it can only ever prove the negative:
 *    if the directory is gone, everything under it is gone.
 */
import fs from "node:fs";

export type LocalFilePresence = "present" | "absent" | "unknown";

/** The measured facts a {@link classifyLocalFiles} verdict is derived from. */
export interface LocalFileEvidence {
  /**
   * Every file path the record names — *including* ones the filesystem would
   * not answer for. Counting only the paths we managed to check would let a
   * single permissions error shrink the denominator until "the two I could read
   * are gone" passed for "all of them are gone".
   */
  filesRecorded: number;
  /** Of those, how many the filesystem confirmed exist. */
  filesFound: number;
  /** Of those, how many the filesystem confirmed do NOT exist. */
  filesMissing: number;
  /** What we could establish about the torrent's save directory. */
  savePath: "exists" | "missing" | "unknown";
}

/**
 * Turn measured facts into a presence verdict.
 *
 * Order is the rule:
 *  1. **present** — at least one recorded file is really there. Nothing else
 *     matters; the claim stands.
 *  2. **absent** — every recorded path was checked and every one is gone. If
 *     even one could not be checked the counts will not match, and the verdict
 *     falls through to `unknown` rather than guessing.
 *  3. **absent** — the save directory itself is gone, so its contents are too.
 *  4. **unknown** — no evidence either way. The claim is left exactly as it was.
 */
export function classifyLocalFiles(
  evidence: LocalFileEvidence,
): LocalFilePresence {
  if (evidence.filesFound > 0) return "present";
  if (evidence.filesRecorded > 0 && evidence.filesMissing === evidence.filesRecorded) {
    return "absent";
  }
  if (evidence.savePath === "missing") return "absent";
  return "unknown";
}

/** The columns a presence probe needs. */
export interface LocalFileRow {
  hash: string;
  savePath?: string | null;
  verifiedFilesJson?: string | null;
}

/**
 * `undefined` = confirmed missing, `null` = could not tell, object = exists.
 * `throwIfNoEntry: false` is what separates "not there" from "could not look",
 * which is the whole distinction this module is built on.
 */
export type StatProbe = (path: string) => "exists" | "missing" | "unknown";

const nodeStat: StatProbe = (target) => {
  try {
    return fs.statSync(target, { throwIfNoEntry: false }) ? "exists" : "missing";
  } catch {
    return "unknown";
  }
};

/** Absolute file paths the engine recorded for this torrent. */
export function recordedFilePaths(
  verifiedFilesJson: string | null | undefined,
): string[] {
  if (!verifiedFilesJson?.trim()) return [];
  try {
    const parsed = JSON.parse(verifiedFilesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
          ? ((entry as { path: string }).path.trim())
          : "",
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function collectLocalFileEvidence(
  row: LocalFileRow,
  stat: StatProbe = nodeStat,
): LocalFileEvidence {
  const paths = recordedFilePaths(row.verifiedFilesJson);
  let filesFound = 0;
  let filesMissing = 0;
  for (const p of paths) {
    const verdict = stat(p);
    if (verdict === "exists") filesFound += 1;
    else if (verdict === "missing") filesMissing += 1;
  }

  const save = row.savePath?.trim();
  return {
    filesRecorded: paths.length,
    filesFound,
    filesMissing,
    savePath: save ? stat(save) : "unknown",
  };
}

// ---------------------------------------------------------------------------
// Cached probe
// ---------------------------------------------------------------------------

/**
 * Presence is re-read often (every browse payload, every title page) but files
 * do not appear and disappear by the second, so verdicts are memoised for the
 * same window the availability memo uses.
 */
export const LOCAL_FILE_PRESENCE_TTL_MS = 30_000;

const presenceCache = new Map<string, { at: number; value: LocalFilePresence }>();

export function resetLocalFilePresenceCache(): void {
  presenceCache.clear();
}

export function localFilePresence(
  row: LocalFileRow,
  opts?: { stat?: StatProbe; now?: number; ttlMs?: number },
): LocalFilePresence {
  const now = opts?.now ?? Date.now();
  const ttl = opts?.ttlMs ?? LOCAL_FILE_PRESENCE_TTL_MS;
  const key = `${row.hash}|${row.savePath ?? ""}|${row.verifiedFilesJson?.length ?? 0}`;

  const hit = presenceCache.get(key);
  if (hit && now - hit.at < ttl) return hit.value;

  const value = classifyLocalFiles(collectLocalFileEvidence(row, opts?.stat));
  presenceCache.set(key, { at: now, value });
  return value;
}

/** A lookup for a batch of rows — one probe per row, memoised. */
export function localFilePresenceLookup(
  rows: readonly LocalFileRow[],
  opts?: { stat?: StatProbe; now?: number; ttlMs?: number },
): (hash: string) => LocalFilePresence {
  const byHash = new Map<string, LocalFilePresence>();
  for (const row of rows) {
    byHash.set(row.hash.trim().toLowerCase(), localFilePresence(row, opts));
  }
  return (hash) => byHash.get(hash.trim().toLowerCase()) ?? "unknown";
}

/**
 * The one predicate every read surface should use: is this row disqualified
 * from making a local claim? Only a proven-absent file is.
 */
export function fileConfirmedMissing(presence: LocalFilePresence): boolean {
  return presence === "absent";
}
