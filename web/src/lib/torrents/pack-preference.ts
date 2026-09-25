import { parseEpisode, SEASON_RANGE_RE } from "./episodes";
import type { EpisodeInfo } from "./episodes";
import type { TorrentResult } from "./types";

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

/** Episode ranges are multi-file intent even when the parser sees their first E. */
export function isEpisodeRangeRelease(title: string): boolean {
  return (
    /\bS\d{1,3}\s*E\d{1,4}\s*[-–—~]\s*(?:S\d{1,3}\s*)?E?\d{1,4}\b/i.test(title) ||
    /\b\d{1,3}x\d{1,4}\s*[-–—~]\s*(?:\d{1,3}x)?\d{1,4}\b/i.test(title) ||
    /\b(?:episodes?|eps?|e)\s*\.?\s*\d{1,4}\s*[-–—~]\s*(?:episodes?|eps?|e)?\s*\.?\s*\d{1,4}\b/i.test(
      title,
    )
  );
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

/**
 * Does this release name the hunt target?
 *
 * Exact `SxxEyy` always matches. Absolute-numbered anime releases
 * (`[SubsPlease] Re Zero - 01`, season omitted) match only when the hunt is
 * season 1 — "01" means the first episode of the series, not S05E01.
 */
export function matchesTargetEpisode(
  result: TorrentResult,
  target: TargetEpisode,
): boolean {
  const ep = parsed(result);
  if (
    ep.isBatch ||
    ep.isSeasonPack ||
    ep.isMultiSeason ||
    isEpisodeRangeRelease(result.title)
  ) {
    return false;
  }
  if (ep.episode !== target.episode) return false;
  if (ep.season === target.season) return true;
  if (ep.season == null && target.season === 1) return true;
  return false;
}

function exactEpisode(result: TorrentResult, target: TargetEpisode): boolean {
  return matchesTargetEpisode(result, target);
}

/**
 * Pick a release for one episode.
 *
 * Episode intent is structural: only an exact episode may satisfy it. A season
 * pack cannot be promoted from its name, size, or seeder count because none of
 * those proves the requested file exists, and an episode keep must never turn
 * into an implicit season download.
 */
export function selectSeriesCandidateWithPackPreference(
  results: TorrentResult[],
  target: TargetEpisode,
): TorrentResult | null {
  return (
    results.find(
      (result) =>
        Boolean(result.magnet) &&
        (result.seeders ?? 0) > 0 &&
        exactEpisode(result, target),
    ) ?? null
  );
}
