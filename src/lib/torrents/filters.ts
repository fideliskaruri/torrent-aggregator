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
  };
}
