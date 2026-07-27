import { parseEpisode, SEASON_RANGE_RE } from "./episodes";
import type { EpisodeInfo } from "./episodes";
import type { TorrentResult } from "./types";

const DEFAULT_EPISODE_BYTES = 1_500_000_000;
const MAX_EPISODES_PER_SEASON_ESTIMATE = 24;
const UNKNOWN_COMPLETE_EPISODE_ESTIMATE = 60;
const PACK_SIZE_FUDGE_FACTOR = 1.25;

type TargetEpisode = {
  season: number;
  episode: number;
};

type SeasonCoverage =
  | { kind: "single"; from: number; to: number }
  | { kind: "multi"; from: number; to: number }
  | { kind: "unknown-complete" };

function parsed(result: TorrentResult): EpisodeInfo {
  return result.episode ?? parseEpisode(result.title);
}

export function seasonCoverage(
  title: string,
  episode: EpisodeInfo = parseEpisode(title),
): SeasonCoverage | null {
  if (!episode.isSeasonPack && !episode.isBatch) return null;

  const range = title.match(SEASON_RANGE_RE);
  if (range) {
    const nums = (range[0].match(/\d{1,3}/g) ?? [])
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 1);
    if (nums.length >= 2) {
      return {
        kind: "multi",
        from: Math.min(...nums),
        to: Math.max(...nums),
      };
    }
  }

  if (episode.season != null) {
    return { kind: "single", from: episode.season, to: episode.season };
  }

  if (episode.isSeasonPack || episode.isBatch) {
    return { kind: "unknown-complete" };
  }

  return null;
}

function coversSeason(coverage: SeasonCoverage, season: number): boolean {
  if (coverage.kind === "unknown-complete") return true;
  return coverage.from <= season && season <= coverage.to;
}

function estimatedEpisodeCount(coverage: SeasonCoverage): number {
  if (coverage.kind === "unknown-complete") {
    return UNKNOWN_COMPLETE_EPISODE_ESTIMATE;
  }
  const seasons = Math.max(1, coverage.to - coverage.from + 1);
  return seasons * MAX_EPISODES_PER_SEASON_ESTIMATE;
}

function exactEpisode(result: TorrentResult, target: TargetEpisode): boolean {
  const ep = parsed(result);
  return ep.season === target.season && ep.episode === target.episode;
}

function packTier(result: TorrentResult, target: TargetEpisode): number | null {
  const ep = parsed(result);
  const coverage = seasonCoverage(result.title, ep);
  if (!coverage || !coversSeason(coverage, target.season)) return null;
  if (coverage.kind === "single" && coverage.from === target.season) return 0;
  return 1;
}

function isSizeAcceptable(
  pack: TorrentResult,
  coverage: SeasonCoverage,
  episodeBytes: number,
): boolean {
  if (pack.sizeBytes == null || pack.sizeBytes <= 0) return false;
  const expectedBytes = Math.max(1, episodeBytes) * estimatedEpisodeCount(coverage);

  /**
   * A pack is allowed to be much larger than one episode, but not unbounded.
   * We estimate the covered episode count at 24 per named season (or 60 for an
   * unnumbered "complete" pack) and allow 25% headroom for alternate encodes,
   * extras and imperfect indexer sizes. That keeps normal 12/24 episode season
   * packs eligible while stopping the concrete disaster
   * this preference would otherwise create: a 500 GB complete-series torrent
   * replacing a 500 MB episode just because it appeared earlier in the results.
   */
  return pack.sizeBytes <= expectedBytes * PACK_SIZE_FUDGE_FACTOR;
}

/**
 * Pick a series release for a specific hunt cursor.
 *
 * This is deliberately a ranking preference, not a filter: unsafe or absent
 * packs only lose their preferred rank, and the exact single episode remains
 * eligible exactly as it was before. The order is:
 *
 *   1. the single-season pack for the season we need
 *   2. a multi-season / complete pack that covers that season
 *   3. the exact single episode
 *
 * A whole-series pack can be enormous when the viewer only asked for S01E05, so
 * the size guard above runs before a pack enters tiers 1 or 2.
 */
export function selectSeriesCandidateWithPackPreference(
  results: TorrentResult[],
  target: TargetEpisode,
): TorrentResult | null {
  const usable = results.filter((r) => r.magnet && (r.seeders ?? 0) > 0);
  const singleEpisode = usable.find((r) => exactEpisode(r, target)) ?? null;
  const episodeBytes =
    singleEpisode?.sizeBytes != null && singleEpisode.sizeBytes > 0
      ? singleEpisode.sizeBytes
      : DEFAULT_EPISODE_BYTES;

  const ranked = usable
    .map((result, index) => {
      const ep = parsed(result);
      const coverage = seasonCoverage(result.title, ep);
      if (coverage && coversSeason(coverage, target.season)) {
        const tier = packTier(result, target);
        if (
          tier != null &&
          isSizeAcceptable(result, coverage, episodeBytes)
        ) {
          return { result, tier, index };
        }
      }
      if (exactEpisode(result, target)) {
        return { result, tier: 2, index };
      }
      return null;
    })
    .filter((r): r is { result: TorrentResult; tier: number; index: number } =>
      Boolean(r),
    );

  ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return ranked[0]?.result ?? null;
}
