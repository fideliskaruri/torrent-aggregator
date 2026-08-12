import type { TitleExtrasPayload } from "@/components/title/types";
import type { TitleProviderIdentityResult } from "../provider-identity";
import { providerEpisodePlaceholders } from "./episode-placeholders";

/**
 * Resolve provider-carried requests without changing identity providers.
 *
 * AniList identifies anime safely and supplies work-level metadata, but this
 * app has no AniList *episode* catalog — no episode titles, air dates or
 * stills. Searching TMDB by title after an AniList identity was selected could
 * attach a similarly named work's seasons, so that fallback stays forbidden.
 *
 * What AniList does supply is a verified episode *count* for the work. One
 * AniList media id is one season by construction (a sequel season carries its
 * own id), so a verified count is an honest Season 1 list of numbered
 * episodes — the user can acquire episode 7 of 12 instead of facing a blank
 * list. Nothing is invented: with no count the list stays empty and
 * `resolved:false` still says "the identity resolved, the catalog did not".
 *
 * `null` means the ordinary TMDB extras pipeline may proceed. AniList responses
 * remain authoritative for episode shape; the route may attach recommendations
 * from that same verified AniList id without changing any of these fields.
 */
export function providerExtrasResponse(
  result: TitleProviderIdentityResult,
  empty: TitleExtrasPayload,
): TitleExtrasPayload | null {
  if (result.kind === "absent") return null;

  // TMDB identities carry a verified provider id that the extras route resolves
  // through the ordinary TMDB pipeline — real episodes, seasons, genres and the
  // "more like this" rail. Returning null lets that path run; returning `empty`
  // here is exactly the silent-empty defect (BUG-008/002a) that blanked every
  // movie/series reached from search. AniList stays terminal below because this
  // app has no AniList episode catalog to resolve.
  if (
    (result.kind === "verified" || result.kind === "carried") &&
    result.identity.provider === "tmdb"
  ) {
    return null;
  }

  if (result.kind !== "verified") return empty;

  const identity = result.identity;
  const metadata = identity.metadata;
  const season = anilistSeason(identity.isSeries, empty.season);
  const hasCount = identity.isSeries && identity.episodeCount != null;
  const episodes =
    hasCount && season === 1
      ? providerEpisodePlaceholders(1, { 1: identity.episodeCount as number })
      : [];

  return {
    ...empty,
    season,
    // One AniList media id is one season; a sequel season is a separate work
    // with its own id, so claiming more than one season here would be a guess.
    seasonCount: hasCount ? 1 : null,
    seasons: hasCount ? [1] : [],
    episodes,
    overview: metadata.synopsis ?? null,
    rating: metadata.rating ?? null,
    releaseDate: metadata.releaseDate ?? null,
    // Hero facts stay honestly empty. AniList work-level metadata carries no
    // TMDB-shaped genres/vote count/certification/language, and searching TMDB
    // by title after an AniList identity was chosen is exactly the cross-work
    // contamination this path exists to avoid. Explicit here (not just via the
    // spread) so the contract reads at a glance.
    genres: [],
    voteCount: null,
    certification: null,
    originalLanguage: null,
    resolved: !identity.isSeries || episodes.length > 0,
  };
}

/**
 * Which season this answer describes.
 *
 * A film has none. A verified AniList series has exactly one — season 1 — so a
 * request for any other season is answered as itself with no episodes, never
 * silently re-pointed at season 1's list.
 */
function anilistSeason(
  isSeries: boolean,
  requested: number | null,
): number | null {
  if (!isSeries) return null;
  return requested == null || requested < 1 ? 1 : requested;
}
