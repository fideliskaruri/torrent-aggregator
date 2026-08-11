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

export interface TvmazeEpisode {
  season: number;
  episode: number;
  name: string | null;
  airDate: string | null;
  runtimeMin: number | null;
  stillUrl: string | null;
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

interface TvmazeEpisodeRow {
  season?: unknown;
  number?: unknown;
  name?: unknown;
  airdate?: unknown;
  runtime?: unknown;
  image?: {
    medium?: unknown;
    original?: unknown;
  } | null;
}

const TVMAZE_SEARCH = "https://api.tvmaze.com/search/shows";
const TVMAZE_EPISODES = "https://api.tvmaze.com/shows";

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

/**
 * Fetch canonical episodes for one already-resolved TVMaze show. Invalid rows,
 * specials without positive season/episode numbers, and network failures are
 * omitted rather than converted into synthetic metadata.
 */
export async function getTvmazeEpisodes(
  showId: number,
  opts: { timeoutMs?: number } = {},
): Promise<TvmazeEpisode[]> {
  if (!Number.isInteger(showId) || showId <= 0) return [];

  const { timeoutMs = 5000 } = opts;

  try {
    const res = await fetch(`${TVMAZE_EPISODES}/${showId}/episodes`, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];

    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];

    return rows
      .slice(0, 5000)
      .flatMap((value): TvmazeEpisode[] => {
        const row = value as TvmazeEpisodeRow;
        const season = toPositiveInteger(row.season);
        const episode = toPositiveInteger(row.number);
        if (season === null || episode === null) return [];

        const original =
          typeof row.image?.original === "string" ? row.image.original : null;
        const medium =
          typeof row.image?.medium === "string" ? row.image.medium : null;

        return [{
          season,
          episode,
          name: toOptionalString(row.name),
          airDate: toDateString(row.airdate),
          runtimeMin: toPositiveInteger(row.runtime),
          stillUrl: original ?? medium,
        }];
      })
      .sort((left, right) =>
        left.season - right.season || left.episode - right.episode
      );
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

function toPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateString(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}
