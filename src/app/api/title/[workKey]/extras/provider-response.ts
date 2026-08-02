import type { TitleExtrasPayload } from "@/components/title/types";
import type { TitleProviderIdentityResult } from "../provider-identity";

/**
 * Resolve provider-carried requests without changing identity providers.
 *
 * AniList identifies anime safely and supplies work-level metadata, but this
 * app has no AniList episode-level catalog. Searching TMDB by title after an
 * AniList identity was selected could attach a similarly named work's seasons.
 * A verified series therefore returns its verified blurb with `resolved:false`:
 * the identity resolved, but the requested catalog shape did not.
 *
 * `null` means no provider identity was carried, so ordinary TMDB resolution
 * may proceed. Every other result is terminal.
 */
export function providerExtrasResponse(
  result: TitleProviderIdentityResult,
  empty: TitleExtrasPayload,
): TitleExtrasPayload | null {
  if (result.kind === "absent") return null;
  if (result.kind !== "verified") return empty;

  const metadata = result.identity.metadata;
  return {
    ...empty,
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
    resolved: !result.identity.isSeries,
  };
}
