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
    resolved: !result.identity.isSeries,
  };
}
