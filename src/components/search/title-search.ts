/**
 * Client helpers for TMDB title discovery search.
 *
 * Keeps the overlay / results list free of torrent types and maps the
 * `/api/search/titles` payload onto the shared `TitleResult` card shape.
 */
import type { TitleResult } from "./group-titles";
import { queryRelevanceTier } from "./group-titles";
import { releaseStatus } from "@/lib/browse/release-status";
import { titlePath, workKeyFor } from "@/components/title/work-key";

export interface TitleSearchHit {
  workKey: string;
  title: string;
  year: number | null;
  mediaType: string;
  posterUrl?: string | null;
  posterPath?: string | null;
  overview?: string | null;
  popularity?: number | null;
  href?: string | null;
  releaseDate?: string | null;
}

/**
 * Order title hits by how well each answers the query, then keep source order.
 *
 * TMDB ranks by its own popularity, which is not relevance: searching
 * "atlantis" returns *Stargate Atlantis* (2004) above the exact-title
 * *Atlantis* (2013). Someone who types a title expects that title. Within one
 * relevance tier the incoming order is preserved, because popularity is a fair
 * tiebreak and re-sorting it would discard the signal TMDB is genuinely good at.
 *
 * The tier function is shared with the release-grouping path so both surfaces
 * agree on what "relevant" means. Pure — safe for tests.
 */
export function rankTitleHitsByRelevance<T extends { title: string }>(
  hits: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...hits];
  return hits
    .map((hit, index) => ({ hit, index, tier: queryRelevanceTier(query, hit.title) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((x) => x.hit);
}

/** Map API hits into the card model. Pure — safe for tests. */
export function titlesFromSearchHits(
  hits: readonly TitleSearchHit[],
  now: Date = new Date(),
): TitleResult[] {
  const out: TitleResult[] = [];
  for (const hit of hits) {
    const mediaType = (hit.mediaType || "movie").toLowerCase();
    const isSeries = mediaType === "tv" || mediaType === "anime";
    const year = hit.year ?? null;
    const workKey =
      hit.workKey ||
      workKeyFor(hit.title, mediaType === "movie" ? year : null);
    if (!workKey || !hit.title?.trim()) continue;

    const href =
      hit.href ||
      titlePath(workKey, {
        title: hit.title,
        year,
        mediaType,
      });

    const releaseDate = hit.releaseDate ?? null;
    const status = releaseStatus(releaseDate, now);

    out.push({
      key: workKey,
      name: hit.title.trim(),
      year,
      isSeries,
      mediaType,
      posterUrl: hit.posterUrl ?? null,
      releaseDate,
      status,
      href,
      overview: hit.overview ?? null,
    });
  }
  return out;
}
