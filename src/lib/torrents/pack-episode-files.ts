import { parseEpisode } from "./episodes";
import { isSupportedVideoFileName } from "./filters";

/**
 * One file inside a completed pack, as recorded in
 * `EngineTorrent.verifiedFilesJson` — an absolute path and (optionally) its
 * byte size. `mtimeMs` and any other fields the engine wrote are ignored here.
 */
export interface PackFile {
  path: string;
  size?: number | null;
}

/**
 * Path segments that mark supplementary material a season pack bundles beside
 * the real episodes. A file living under any of these folders parses to an
 * episode ("01 - A Rickle in Time.mkv") but is NOT one, so it must never map a
 * pack onto an episode row. Matched per path segment, case-insensitively, with
 * `._-` normalised to spaces so `Behind.the.Scenes` matches as three words.
 */
const EXTRAS_SEGMENT_RE =
  /\b(?:featurettes?|extras?|specials?|samples?|behind[ ]the[ ]scenes|animatics?)\b/i;

function hasExtrasSegment(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    const normalised = segment.replace(/[._-]+/g, " ");
    if (EXTRAS_SEGMENT_RE.test(normalised)) return true;
  }
  return false;
}

/** The last path segment, for either separator. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/**
 * Map a completed pack's real episode files onto episode numbers for `season`.
 *
 * ## Contract
 *
 * `packEpisodeFiles(files, season)` → `Map<episodeNumber, absoluteFilePath>`.
 *
 * A file is mapped only when ALL of these hold:
 *
 *  - it is a supported video file (`isSupportedVideoFileName`), so `.nfo`,
 *    `Torrent Downloaded From ....txt` and subtitle files never map;
 *  - its **basename** parses (via `parseEpisode`) to an *explicit* season AND
 *    episode, and that season equals `season` — a bare leading number like
 *    `01 - Title.mkv`, a file with no `SxxExx`, or one for a different season
 *    is ignored (never invented from a folder or a batch marker);
 *  - none of its path segments is a Featurettes / Extras / Specials / Sample /
 *    Behind the Scenes / Animatics folder — that material parses to an episode
 *    but is not one.
 *
 * When two files map to the same episode the **largest by `size`** is kept (a
 * missing/zero size loses to any real size; ties keep the first seen). This is
 * the same "the feature is the big file" rule `selectMainFeatureFile` uses.
 *
 * Pure: no filesystem, no database. Unit-testable in isolation.
 */
export function packEpisodeFiles(
  files: readonly PackFile[],
  season: number,
): Map<number, string> {
  const best = new Map<number, { path: string; size: number }>();

  for (const file of files) {
    const path = typeof file?.path === "string" ? file.path : "";
    if (!path) continue;
    if (!isSupportedVideoFileName(path)) continue;
    if (hasExtrasSegment(path)) continue;

    const ep = parseEpisode(basenameOf(path));
    // Require an explicit SxxExx for THIS season. A bare leading number
    // ("01 - Title.mkv"), a file with no marker, a season-pack marker, or a
    // different season is not an episode of this pack and must never map.
    if (
      ep.season !== season ||
      ep.episode == null ||
      ep.isSeasonPack ||
      ep.isMultiSeason
    ) {
      continue;
    }

    const size =
      typeof file.size === "number" && Number.isFinite(file.size) && file.size > 0
        ? file.size
        : 0;
    const existing = best.get(ep.episode);
    if (!existing || size > existing.size) {
      best.set(ep.episode, { path, size });
    }
  }

  const out = new Map<number, string>();
  for (const [episode, { path }] of best) out.set(episode, path);
  return out;
}
