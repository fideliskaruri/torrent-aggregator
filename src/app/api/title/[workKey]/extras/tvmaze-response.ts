import type { TitleExtrasPayload } from "@/components/title/types";
import { normalizeTitleForMatch } from "@/lib/metadata/artwork";
import { workKeyMatches } from "@/components/title/work-key";
import {
  getTvmazeEpisodes,
  searchTvmazeShows,
  type TvmazeCandidate,
  type TvmazeEpisode,
} from "@/lib/metadata/tvmaze";
import type { TitleProviderIdentityResult } from "../provider-identity";

interface TvmazeExtrasDependencies {
  search: typeof searchTvmazeShows;
  episodes: typeof getTvmazeEpisodes;
}

interface TvmazeFallbackRequest {
  workKey: string;
  title: string;
  year: number | null;
  posterUrl?: string | null;
  isSeries: boolean;
}

const DEFAULT_DEPENDENCIES: TvmazeExtrasDependencies = {
  search: searchTvmazeShows,
  episodes: getTvmazeEpisodes,
};

/**
 * Resolve TV episode metadata without an API key when a carried TMDB identity
 * cannot be verified locally. Matches require an exact normalized title and,
 * whenever the carried identity has one, the exact premiere year.
 */
export async function tvmazeExtrasResponse(
  identity: TitleProviderIdentityResult,
  empty: TitleExtrasPayload,
  fallback: TvmazeFallbackRequest,
  dependencies: TvmazeExtrasDependencies = DEFAULT_DEPENDENCIES,
): Promise<TitleExtrasPayload | null> {
  const source = tvmazeLookupSource(identity, fallback);
  if (!source) return null;

  const names = uniqueNames(source.names).slice(0, 4);
  if (names.length === 0) return null;

  const results = await Promise.all(
    names.map((name) => dependencies.search(name)),
  );
  const show = chooseExactShow(
    results.flat(),
    names,
    source.year,
    fallback.posterUrl ?? null,
  );
  if (!show) return null;

  const allEpisodes = await dependencies.episodes(show.id);
  if (allEpisodes.length === 0) return null;

  const seasons = Array.from(
    new Set(allEpisodes.map((episode) => episode.season)),
  ).sort((left, right) => left - right);
  const season = empty.season ?? seasons[0] ?? null;
  if (season === null) return null;

  const episodes = allEpisodes
    .filter((episode) => episode.season === season)
    .map(toEpisodeMeta);
  if (episodes.length === 0) return null;

  return {
    ...empty,
    season,
    seasonCount: seasons.length,
    seasons,
    episodes,
    resolved: true,
  };
}

function tvmazeLookupSource(
  identity: TitleProviderIdentityResult,
  fallback: TvmazeFallbackRequest,
): { names: string[]; year: number | null } | null {
  if (
    identity.kind === "carried"
    && identity.identity.provider === "tmdb"
    && identity.identity.metadata.mediaType === "tv"
  ) {
    return {
      names: [
        identity.identity.metadata.title,
        ...(identity.identity.metadata.aliases ?? []),
      ],
      year: identity.identity.metadata.year ?? null,
    };
  }

  if (
    identity.kind !== "absent"
    || !fallback.isSeries
    || !fallback.title.trim()
    || !workKeyMatches(fallback.workKey, fallback.title, null)
  ) {
    return null;
  }

  return {
    names: [fallback.title],
    year: fallback.year,
  };
}

function chooseExactShow(
  candidates: TvmazeCandidate[],
  names: string[],
  expectedYear: number | null,
  expectedPosterUrl: string | null,
): TvmazeCandidate | null {
  const normalizedNames = new Set(
    names.map(normalizeTitleForMatch).filter(Boolean),
  );
  const exactById = new Map<number, TvmazeCandidate>();

  for (const candidate of candidates) {
    if (!normalizedNames.has(normalizeTitleForMatch(candidate.title))) continue;
    if (expectedYear !== null && candidate.year !== expectedYear) continue;

    const current = exactById.get(candidate.id);
    if (!current || candidate.score > current.score) {
      exactById.set(candidate.id, candidate);
    }
  }

  const exact = Array.from(exactById.values()).sort(
    (left, right) => right.score - left.score,
  );
  if (exact.length === 0) return null;
  if (exact.length !== 1) {
    const posterUrl = expectedPosterUrl?.trim();
    if (!posterUrl) return null;
    const posterMatches = exact.filter(
      (candidate) => candidate.posterUrl?.trim() === posterUrl,
    );
    return posterMatches.length === 1 ? posterMatches[0] : null;
  }
  return exact[0] ?? null;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    const normalized = normalizeTitleForMatch(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }

  return result;
}

function toEpisodeMeta(episode: TvmazeEpisode) {
  return {
    episode: episode.episode,
    name: episode.name,
    overview: null,
    airDate: episode.airDate,
    runtimeMin: episode.runtimeMin,
    stillUrl: episode.stillUrl,
  };
}
