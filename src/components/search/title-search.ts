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
import type { WorkSearchHit } from "@/lib/search/work-search";

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

/**
 * Merge provider-ranked lists without making the first provider in the
 * request the permanent tie-break. Each provider contributes at most one hit
 * per rank round; the round starts at a query-derived offset so category order
 * is deterministic but not movie-first.
 */
export function interleaveByProviderRank<T extends { title: string }>(
  groups: readonly (readonly T[])[],
  query: string,
): T[] {
  const out: T[] = [];
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  let hash = 2166136261;
  for (const codePoint of Array.from(query.trim().toLowerCase())) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  for (let rank = 0; rank < maxLength; rank += 1) {
    const round = groups
      .map((group, index) => ({ hit: group[rank], index }))
      .filter((entry): entry is { hit: T; index: number } => entry.hit != null);
    if (round.length === 0) continue;
    const offset = Math.abs(hash + rank) % round.length;
    for (let i = 0; i < round.length; i += 1) {
      out.push(round[(offset + i) % round.length].hit);
    }
  }
  return out;
}

/** Map API hits into the card model. Pure — safe for tests. */
export function titlesFromSearchHits(
  hits: readonly WorkSearchHit[],
  now: Date = new Date(),
): TitleResult[] {
  const out: TitleResult[] = [];
  for (const hit of hits) {
    const mediaType = (hit.mediaType || "movie").toLowerCase();
    const isSeries = hit.isSeries;
    const year = hit.year ?? null;
    const workKey =
      hit.workKey ||
      workKeyFor(hit.title, isSeries ? null : year);
    if (!workKey || !hit.title?.trim()) continue;

    const href =
      hit.href ||
      titlePath(workKey, {
        title: hit.title,
        year,
        mediaType: hit.titleMediaType || mediaType,
      });

    const releaseDate = hit.releaseDate ?? null;
    const status = releaseStatus(releaseDate, now);

    out.push({
      key: workKey,
      name: hit.title.trim(),
      year,
      isSeries,
      mediaType,
      format: hit.format,
      posterUrl: hit.posterUrl ?? null,
      releaseDate,
      status,
      href,
      overview: hit.overview ?? null,
    });
  }
  return out;
}
