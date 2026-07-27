/**
 * TVmaze — keyless TV artwork.
 *
 * Why this exists even though TMDB now has a real key: TMDB rate-limits under a
 * browse-heavy UI (called out in the project's own risk table), a key can be
 * revoked or expire, and anyone cloning this repo starts with no key at all.
 * The product has to look finished with zero keys configured.
 *
 * Verified live from this machine:
 *   GET https://api.tvmaze.com/search/shows?q=severance
 *   -> [{ score: 0.903, show: { name: "Severance", premiered: "2022-02-18",
 *          image: { medium, original } } }, ...]
 *   original -> https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg
 *
 * Shape notes that cost time if assumed:
 * - `image` is null for a lot of older/obscure shows — always guard it.
 * - `premiered` is the *series* premiere, not the season's year.
 * - The endpoint returns fuzzy matches with a `score` far below 1 ("Aligned
 *   Reverence" scored 0.21 for a "severance" query), so the caller must judge
 *   the title itself. `score` is a tie-break at best.
 * - There is no backdrop/banner in this payload. Posters only.
 */

export interface TvmazeCandidate {
  id: number;
  title: string;
  year: number | null;
  /** 2:3-ish poster. TVmaze serves the untouched original. */
  posterUrl: string | null;
  /** TVmaze search exposes no wide art. Always null; kept for a uniform shape. */
  backdropUrl: null;
  /** TVmaze's own fuzzy search score, 0..1. */
  score: number;
}

interface TvmazeSearchRow {
  score?: number;
  show?: {
    id?: number;
    name?: string;
    premiered?: string | null;
    image?: { medium?: string | null; original?: string | null } | null;
  };
}

const TVMAZE_SEARCH = "https://api.tvmaze.com/search/shows";

/**
 * Search TVmaze for shows matching `query`. Never throws — an artwork provider
 * that can fail a page is worse than a page with letter tiles.
 */
export async function searchTvmazeShows(
  query: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<TvmazeCandidate[]> {
  const term = query.trim();
  if (!term) return [];

  const { limit = 8, timeoutMs = 5000 } = opts;
  const url = new URL(TVMAZE_SEARCH);
  url.searchParams.set("q", term);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];

    const rows = (await res.json()) as TvmazeSearchRow[];
    if (!Array.isArray(rows)) return [];

    return rows
      .slice(0, limit)
      .map(toCandidate)
      .filter((c): c is TvmazeCandidate => c !== null);
  } catch {
    return [];
  }
}

function toCandidate(row: TvmazeSearchRow): TvmazeCandidate | null {
  const show = row.show;
  if (!show?.name) return null;

  const year = show.premiered ? parseInt(show.premiered.slice(0, 4), 10) : NaN;

  return {
    id: show.id ?? 0,
    title: show.name,
    year: Number.isFinite(year) ? year : null,
    posterUrl: show.image?.original || show.image?.medium || null,
    backdropUrl: null,
    score: typeof row.score === "number" ? row.score : 0,
  };
}
