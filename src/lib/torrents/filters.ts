import type { TorrentResult, TorrentSourceId } from "./types";
import { parseEpisode } from "./episodes";

export interface SearchFilters {
  minSeeders?: number;
  maxSeeders?: number;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  resolution?: string; // 1080p | 720p | 2160p | 480p
  codec?: string; // x265 | x264 | hevc | av1
  sources?: TorrentSourceId[];
  hasMagnet?: boolean;
  season?: number;
  episode?: number;
  /**
   * "packs"    — only multi-episode releases (season packs, batches, complete
   *              collections). One grab instead of twelve.
   * "episodes" — only single episodes, for topping up a season you mostly have.
   */
  releaseKind?: "packs" | "episodes";
}

export function applyFilters(
  results: TorrentResult[],
  filters: SearchFilters,
): TorrentResult[] {
  return results.filter((r) => {
    if (filters.minSeeders != null && (r.seeders ?? 0) < filters.minSeeders) {
      return false;
    }
    if (filters.maxSeeders != null && (r.seeders ?? 0) > filters.maxSeeders) {
      return false;
    }
    if (
      filters.minSizeBytes != null &&
      (r.sizeBytes == null || r.sizeBytes < filters.minSizeBytes)
    ) {
      return false;
    }
    if (
      filters.maxSizeBytes != null &&
      (r.sizeBytes == null || r.sizeBytes > filters.maxSizeBytes)
    ) {
      return false;
    }
    if (filters.resolution) {
      const res = filters.resolution.toLowerCase();
      const hay = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
      if (res === "2160p" || res === "4k") {
        if (!hay.includes("2160p") && !hay.includes("4k") && !hay.includes("uhd")) {
          return false;
        }
      } else if (!hay.includes(res)) {
        return false;
      }
    }
    if (filters.codec) {
      const c = filters.codec.toLowerCase();
      const hay = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
      if (c === "hevc" || c === "x265") {
        if (!hay.includes("hevc") && !hay.includes("x265") && !hay.includes("h.265")) {
          return false;
        }
      } else if (!hay.includes(c)) {
        return false;
      }
    }
    if (filters.hasMagnet && !r.magnet) return false;

    if (filters.releaseKind) {
      // Trust the adapter-supplied parse when present so the filter can never
      // disagree with the "S01 pack" chip the card renders.
      const ep = r.episode ?? parseEpisode(r.title);
      const isPack = ep.isBatch || ep.isSeasonPack;
      if (filters.releaseKind === "packs" && !isPack) return false;
      if (filters.releaseKind === "episodes" && isPack) return false;
    }

    if (filters.season != null || filters.episode != null) {
      const ep = parseEpisode(r.title);
      if (filters.season != null && ep.season != null && ep.season !== filters.season) {
        return false;
      }
      if (filters.episode != null && ep.episode != null && ep.episode !== filters.episode) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Release/file names that are supplementary material, not the feature itself:
 * samples, featurettes, bonus discs, deleted scenes, behind-the-scenes,
 * making-of, gag reels, bloopers, outtakes, B-roll (I14b).
 *
 * Deliberately does NOT include cut/edition words ("extended", "unrated",
 * "theatrical", "director's cut", "imax") — those describe a *version* of the
 * main feature, not an extra — nor collision-prone real-title words
 * ("interview", "trailer", "teaser"), because "The Interview" and
 * "Trailer Park Boys" are real works, not bonus material.
 */
const EXTRAS_NAME_RE =
  /\b(?:samples?|featurettes?|extras?|bonus(?:[ _-]?dis[ck])?|deleted[ _-]?scenes?|behind[ _-]?the[ _-]?scenes|making[ _-]?of|gag[ _-]?reels?|bloopers?|outtakes?|b[ _-]?roll)\b/i;

/**
 * True when a release or file name looks like supplementary material rather
 * than the main feature. Dots/underscores are normalised to spaces first so a
 * scene name like `Movie.2020.BONUS.DISC` matches on word boundaries.
 */
export function isExtrasRelease(title: string | null | undefined): boolean {
  if (!title) return false;
  return EXTRAS_NAME_RE.test(String(title).replace(/[._]/g, " "));
}

/** The subset of a torrent file this module needs to pick the main feature. */
export interface SelectableFile {
  name?: string | null;
  path?: string | null;
  length?: number | null;
}

export interface MainFeatureSelection<T> {
  file: T;
  index: number;
}

const VIDEO_EXT_RE =
  /\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$/i;

/** One authoritative filename rule for content the app can treat as video. */
export function isSupportedVideoFileName(name: string): boolean {
  return VIDEO_EXT_RE.test(name.replace(/\\/g, "/"));
}

/**
 * Pick the main feature video from a torrent's file list (I14b).
 *
 * "Play" on a movie must land on the feature, never a bonus/extra/sample even
 * when the extra sorts first or the pack bundles both. The rule: among video
 * files, prefer non-extras; within that class pick the largest by byte length
 * (the feature is the big file, extras are short). Falls back to extras-only
 * video, then to the largest file of any kind, so a single-file torrent (or one
 * that names nothing recognisably) still resolves to something playable.
 */
export function selectMainFeatureFile<T extends SelectableFile>(
  files: readonly T[],
): MainFeatureSelection<T> | null {
  if (!files || files.length === 0) return null;

  const named = files.map((file, index) => ({
    file,
    index,
    name: String(file.name ?? file.path ?? ""),
    length: typeof file.length === "number" && file.length > 0 ? file.length : 0,
  }));

  const videos = named.filter((f) => isSupportedVideoFileName(f.name));
  const pool = videos.length > 0 ? videos : named;

  const mains = pool.filter((f) => !isExtrasRelease(f.name));
  const candidates = mains.length > 0 ? mains : pool;

  let best = candidates[0];
  for (const f of candidates) {
    if (f.length > best.length) best = f;
  }
  return { file: best.file, index: best.index };
}

export function parseFiltersFromParams(
  params: URLSearchParams,
): SearchFilters {
  const num = (key: string) => {
    const v = params.get(key);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    minSeeders: num("minSeeders"),
    maxSeeders: num("maxSeeders"),
    minSizeBytes: num("minSize"),
    maxSizeBytes: num("maxSize"),
    resolution: params.get("resolution") || undefined,
    codec: params.get("codec") || undefined,
    hasMagnet: params.get("hasMagnet") === "1" ? true : undefined,
    season: num("season"),
    episode: num("episode"),
    releaseKind:
      params.get("releaseKind") === "packs"
        ? "packs"
        : params.get("releaseKind") === "episodes"
          ? "episodes"
          : undefined,
  };
}
