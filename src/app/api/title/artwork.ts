/**
 * Artwork for a title page, resolved from what is already on disk.
 *
 * Two rules shape this module:
 *
 *  1. **A page render never waits on the network.** Everything here reads the
 *     local cache tables the search/enrich pipeline already populated
 *     (`CatalogEntry`, `CachedMetadata`). Missing artwork is a normal state
 *     with a designed fallback tile, not an error worth stalling a page for.
 *  2. **A poster is a claim about identity.** `catalogAgrees` is the same
 *     one-directional rule `work-identity.ts` enforces: a catalog title may
 *     *refine* the name a release states, never blur it. Bidirectional
 *     containment is how a single row titled "Dune" once lent its poster to
 *     *Children of Dune* and *Dune: Prophecy* alike. A miss costs nothing;
 *     wrong artwork costs trust.
 *
 * The shared `@/lib/metadata/artwork` module supplies the last resort, when
 * nothing local holds a poster at all. It is reached through a hard time
 * budget (see {@link resolveArtworkBestEffort}) because it may go to the
 * network, and a page render must not.
 */
import prisma from "@/lib/prisma";
import { catalogAgrees } from "@/lib/torrents/work-identity";
import type { MediaType } from "@/lib/metadata/media-type";
import {
  resolveArtwork,
  type Artwork,
  type ArtworkQuery,
} from "@/lib/metadata/artwork";

export type { Artwork, ArtworkQuery };

export const NO_ARTWORK: Artwork = { posterUrl: null, backdropUrl: null };

/** A cached catalog row, with everything a title page can borrow from it. */
export interface CachedCatalogRow {
  title: string;
  mediaType: string;
  externalId: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  synopsis: string | null;
  rating: number | null;
  year: number | null;
}

/**
 * The most recent cached catalog row whose title agrees with this work.
 *
 * Scans recent rows rather than querying by title: `CachedMetadata.title` is
 * unindexed and the accept/reject rule is `catalogAgrees`, not SQL
 * containment — and doing it in SQL is precisely how the bidirectional-match
 * bug got re-introduced in the rails module. Rows are scanned newest-first, so
 * the freshest agreeing row wins.
 */
export async function findCachedCatalogRow(
  workName: string,
  mediaType: MediaType | null,
  workYear: number | null = null,
): Promise<CachedCatalogRow | null> {
  const name = workName.trim();
  if (!name) return null;

  const rows = await prisma.cachedMetadata.findMany({
    select: {
      title: true,
      mediaType: true,
      externalId: true,
      posterUrl: true,
      backdropUrl: true,
      synopsis: true,
      rating: true,
      year: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  for (const row of rows) {
    if (!catalogAgrees(name, row.title)) continue;
    // A media type we are sure of is a filter; one we are not sure of is not.
    if (mediaType && row.mediaType && row.mediaType !== mediaType) continue;
    // Year discipline, by what a year means for the media type (the same split
    // `artwork.ts` uses). A film or anime is a point-in-time work: "Dune" (2021)
    // and "Dune" (1984) are two works, so a same-title row two or more years off
    // is a different one and must not lend its poster. A series year is the
    // *season* someone browsed, not the premiere, so only a row that premiered
    // well *after* the year asked for is ruled out — a later season is normal.
    if (workYear && row.year) {
      const diff = row.year - workYear;
      const isSeriesRow = row.mediaType === "tv";
      if (isSeriesRow ? diff >= 2 : Math.abs(diff) >= 2) continue;
    }
    return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The shared artwork module, under a time budget
// ---------------------------------------------------------------------------

/** How long the page will wait on artwork before rendering without it. */
const ARTWORK_BUDGET_MS = 1_200;

/**
 * Best-effort artwork, with a hard time budget.
 *
 * Called only when nothing local supplied a poster. The budget exists because
 * "quick load times" is a product requirement, not a preference: a catalog
 * lookup that hangs must cost a missing poster, never a blank page. The losing
 * side of the race is not cancelled — it keeps running and populates the
 * shared module's own cache, so the next render gets the answer for free.
 */
export async function resolveArtworkBestEffort(
  query: ArtworkQuery,
): Promise<Artwork> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Artwork>((resolve) => {
      timer = setTimeout(() => resolve(NO_ARTWORK), ARTWORK_BUDGET_MS);
    });
    try {
      return await Promise.race([resolveArtwork(query), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return NO_ARTWORK;
  }
}
