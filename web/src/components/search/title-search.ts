/**
 * Client helpers for TMDB title discovery search.
 *
 * Keeps the overlay / results list free of torrent types and maps the
 * `/api/search/titles` payload onto the shared `TitleResult` card shape.
 */
import type { TitleResult } from "./group-titles";
import { releaseStatus } from "@/lib/browse/release-status";
import { titlePath, workKeyFor } from "@/components/title/work-key";
import type { WorkSearchHit } from "@/lib/search/work-search";

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
