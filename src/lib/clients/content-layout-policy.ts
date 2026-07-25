/**
 * The one place that decides what a folder *means*.
 *
 * Two things flatten torrent layouts: the planner, which rewrites paths before
 * the chunk store is built, and the repair, which lifts folders that are
 * already on disk. If they disagree by even one rule, a torrent added today
 * lands somewhere its own resume data is not, and the bytes are downloaded
 * twice. So both import their rules from here and nowhere else.
 */
import path from "node:path";

/**
 * Structures a player, reader or console looks up by name. Dropping one breaks
 * playback rather than merely moving files, so it is never dropped — not at
 * any depth, not by either half.
 */
export const PROTECTED_FOLDER =
  /^(?:BDMV|VIDEO_TS|AUDIO_TS|CERTIFICATE|PRIVATE|AVCHD|BDROM|STREAM|PLAYLIST|CLIPINF|PS3_GAME|PS3_UPDATE|USRDIR|SYSTEM\.BIN)$/i;

/**
 * Folders that organise content rather than wrap it. `Disc 2` and `Season 02`
 * are the only thing keeping two sets of identically named files apart, so
 * dropping one silently merges them.
 *
 * These are still dropped when the destination path already says the same
 * thing — `Season 01` inside `…/Season 01` is pure repetition.
 */
export const STRUCTURAL_FOLDER =
  /^(?:season[\s._-]*\d{1,3}|s\d{1,3}|series[\s._-]*\d{1,3}|specials?|extras?|featurettes?|bonus|subs?|subtitles?|sample|disc[\s._-]*\d+|cd[\s._-]*\d+|dvd[\s._-]*\d+|dis[ck][\s._-]*\d+|vol(?:ume)?[\s._-]*\d+|part[\s._-]*\d+)$/i;

/** Tokens that describe *which* season, not *which* release. */
const SEASON_MARKER = /^s(\d{1,3})$/;

/**
 * Tokens that describe the encode rather than the work. Two names that share
 * only these share nothing meaningful — `1080p x265` is not a title.
 */
const TECHNICAL_TOKEN =
  /^(?:\d{3,4}p|4k|uhd|hdr|hdr10|sdr|x26[45]|h26[45]|hevc|avc|xvid|divx|web|webrip|webdl|bdrip|brrip|bluray|blu|ray|dvdrip|hdtv|remux|aac|ac3|eac3|dts|dd|ddp|flac|mp3|opus|atmos|truehd|\d+bit|bits|\d+|dual|multi|audio|subs?|repack|proper|internal|complete|completo|batch|pack|extended|final)$/;

/** Reserved characters `fs-chunk-store` strips from every basename it writes. */
const RESERVED_FILENAME = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Splits a torrent path on either separator, dropping empty segments. */
export function segments(p: string): string[] {
  return p
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Compares folder names the way a person would: `Season 1`, `Season 01` and
 * `S01` are the same folder. Leading zeros are only stripped off a season or
 * episode marker — `007` and `7` are different films.
 */
export function folderKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/^s(?=\d{1,3}\b)/, "season ")
    .replace(/\s+/g, " ")
    .replace(/^(season|series|disc|disk|cd|dvd|vol|volume|part)\s+0*(\d+)/, "$1 $2")
    .trim();
}

/**
 * Tokenises a release name, folding season markers so `S01` and `Season 01`
 * are one token.
 */
function releaseTokens(name: string): Set<string> {
  const flat = name
    .toLowerCase()
    .replace(/\bseason\s*(\d{1,3})\b/g, "s$1")
    .replace(/\bs(\d{1,3})\b/g, (_, d: string) => `s${Number(d)}`)
    .replace(/\be(\d{1,3})\b/g, (_, d: string) => `e${Number(d)}`);
  return new Set(flat.split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * True when two folder names are the same release wrapped twice.
 *
 * Deliberately not a similarity score. A threshold cannot tell
 * `… Dual Audio` from `… English Audio` (0.75 alike), or `x264` from `x265`
 * (0.67) — and getting that wrong merges two different encodes into one
 * folder. So the test is exact: the names must agree on every token, with two
 * escape hatches and no others.
 *
 *   - A season marker may differ, but **only** if the destination already
 *     names that season. `Frieren Complete` vs `Frieren S01` going into
 *     `Anime/Frieren` is not a duplicate — the inner folder is the only thing
 *     saying which season these files are.
 *   - The names must share at least one token that is not pure encode jargon,
 *     so two unrelated releases cannot match on `1080p x265` alone.
 *
 * False negatives merely leave a folder nested. False positives destroy the
 * only thing keeping two releases apart, so the asymmetry is intentional.
 */
export function isSameRelease(
  a: string,
  b: string,
  destKeys?: Set<string>,
): boolean {
  const ta = releaseTokens(a);
  const tb = releaseTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;

  let sharedMeaningful = 0;
  for (const t of ta) if (tb.has(t) && !TECHNICAL_TOKEN.test(t)) sharedMeaningful++;
  if (sharedMeaningful === 0) return false;

  const allowed = (t: string): boolean => {
    const season = SEASON_MARKER.exec(t);
    if (!season) return false;
    // Only droppable if the destination already says which season this is.
    return destKeys?.has(`season ${Number(season[1])}`) ?? false;
  };

  for (const t of ta) if (!tb.has(t) && !allowed(t)) return false;
  for (const t of tb) if (!ta.has(t) && !allowed(t)) return false;
  return true;
}

/**
 * The destination components a container folder may repeat.
 *
 * Only the tail is considered. Matching every component would let a folder
 * named `Downloads` or `Media` be dropped because the library happens to live
 * under a folder of that name, which says nothing about the torrent.
 */
export function destinationKeys(destPath?: string | null): Set<string> {
  return new Set(segments(destPath ?? "").slice(-3).map(folderKey));
}

/**
 * Decides whether one container level may be dropped. Shared verbatim by the
 * planner and the repair — this function *is* the agreement between them.
 *
 * @param name     the folder in question
 * @param depth    0 for the torrent's own container root
 * @param destKeys from {@link destinationKeys}
 * @param ancestors folders already dropped, outermost first
 */
export function mayDropFolder(
  name: string,
  depth: number,
  destKeys: Set<string>,
  ancestors: readonly string[],
): boolean {
  if (PROTECTED_FOLDER.test(name)) return false;

  const repeatsDestination = destKeys.has(folderKey(name));

  // A structural folder is the only thing separating two discs or two
  // seasons. It goes only when the destination already says the same thing.
  if (STRUCTURAL_FOLDER.test(name)) return repeatsDestination;

  // Depth 0 is the torrent's container root, redundant by construction —
  // this is exactly qBittorrent's `contentLayout=NoSubfolder`, so a download
  // moved between the two clients still finds its files.
  if (depth === 0) return true;

  // Deeper down, absence of meaning is not evidence. Require proof.
  return (
    repeatsDestination ||
    ancestors.some((prior) => isSameRelease(prior, name, destKeys))
  );
}

/** True when the destination path itself already names one season. */
export function destinationNamesSeason(destPath?: string | null): boolean {
  const segs = segments(destPath ?? "");
  const last = segs[segs.length - 1];
  return last !== undefined && /^(?:season|series|s)[\s._-]*\d{1,3}$/i.test(last);
}

/**
 * Renames a release folder that names exactly one season into `Season NN`.
 *
 * A multi-season pack cannot have its season folders *dropped* — they are the
 * only thing keeping two sets of identically numbered episodes apart — so the
 * batch root goes and the library is left holding
 * `Solo Leveling/Solo Leveling S01 1080p … x265-EMBER/`. Renaming gives the
 * same layout a single-season download would have produced.
 *
 * Deliberately narrow, because a wrong rename merges two releases:
 *
 *   - never a protected or already-structural folder (`Season 01`, `Specials`,
 *     `Extras`, `BDMV` …) — those are either correct already or not seasons;
 *   - the name must carry at least one encode token, so a *title* that happens
 *     to contain `S2` is not mistaken for a season folder;
 *   - the name must resolve to exactly one season number, so `S01-S02` and
 *     other ranges are left alone.
 *
 * Returns null to leave the folder untouched, which is always the safe answer.
 */
export function seasonFolderRename(name: string): string | null {
  if (PROTECTED_FOLDER.test(name)) return null;
  if (STRUCTURAL_FOLDER.test(name)) return null;

  const found = [
    ...name.matchAll(/(?:^|[^a-z0-9])s(?:eason)?[\s._-]*(\d{1,3})(?![0-9])/gi),
  ];
  const seasons = new Set(found.map((m) => Number(m[1])));
  if (seasons.size !== 1) return null;

  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.some((t) => TECHNICAL_TOKEN.test(t))) return null;

  const season = [...seasons][0];
  return `Season ${String(season).padStart(2, "0")}`;
}

/**
 * The key two paths collide on *as files on disk*, which is not the same as
 * being equal strings.
 *
 * `fs-chunk-store` strips reserved characters from every basename it writes,
 * on every platform, so `Episode 01: Arrival.mkv` and `Episode 01 Arrival.mkv`
 * are one file. Windows adds case insensitivity and ignores trailing dots and
 * spaces. Comparing raw strings misses all of it and lets two files quietly
 * verify over each other.
 */
export function physicalKey(relativePath: string): string {
  const parts = segments(relativePath);
  const cleaned = parts.map((seg, i) => {
    let s = seg;
    // Only the basename is sanitised by the store; directories are joined
    // as-is, but Windows still folds their case and trailing punctuation.
    if (i === parts.length - 1) s = s.replace(RESERVED_FILENAME, "");
    if (process.platform === "win32") s = s.replace(/[. ]+$/, "");
    return s;
  });
  const joined = cleaned.join("/");
  return process.platform === "win32" ? joined.toLowerCase() : joined;
}

/**
 * True when `child` is at or below `root`, resolving `..` first.
 *
 * Compares path segments rather than the string prefix: a real folder called
 * `..stfolder` (Syncthing writes one) starts with `..` without escaping
 * anything.
 */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
