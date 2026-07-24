import type { MediaMetadata } from "@/lib/torrents/types";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

function apiKey(): string | undefined {
  return process.env.TMDB_API_KEY || undefined;
}

/**
 * Multi-search TMDB for movies/TV. No-ops gracefully when API key is missing.
 */
export async function searchTmdb(
  query: string,
  limit = 5,
): Promise<MediaMetadata[]> {
  const key = apiKey();
  if (!key) return [];

  const url = new URL(`${TMDB_BASE}/search/multi`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    throw new Error(`TMDB HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    results?: TmdbMultiResult[];
  };

  return (json.results ?? [])
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, limit)
    .map(mapTmdb);
}

export async function getTmdbById(
  mediaType: "movie" | "tv",
  id: string,
): Promise<MediaMetadata | null> {
  const key = apiKey();
  if (!key) return null;

  const url = new URL(`${TMDB_BASE}/${mediaType}/${id}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as TmdbDetail;
  return mapTmdbDetail(data, mediaType);
}

interface TmdbMultiResult {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
}

interface TmdbDetail {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  genres?: { id: number; name: string }[];
}

function mapTmdb(r: TmdbMultiResult): MediaMetadata {
  const mediaType = r.media_type === "tv" ? "tv" : "movie";
  const title = r.title || r.name || `TMDB #${r.id}`;
  const date = r.release_date || r.first_air_date;
  const year = date ? parseInt(date.slice(0, 4), 10) : null;

  return {
    source: "tmdb",
    mediaType,
    externalId: String(r.id),
    title,
    posterUrl: r.poster_path ? `${IMG}/w500${r.poster_path}` : null,
    backdropUrl: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : null,
    synopsis: r.overview || null,
    rating: r.vote_average ?? null,
    year: Number.isNaN(year as number) ? null : year,
    genres: [],
  };
}

function mapTmdbDetail(
  r: TmdbDetail,
  mediaType: "movie" | "tv",
): MediaMetadata {
  const title = r.title || r.name || `TMDB #${r.id}`;
  const date = r.release_date || r.first_air_date;
  const year = date ? parseInt(date.slice(0, 4), 10) : null;

  return {
    source: "tmdb",
    mediaType,
    externalId: String(r.id),
    title,
    posterUrl: r.poster_path ? `${IMG}/w500${r.poster_path}` : null,
    backdropUrl: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : null,
    synopsis: r.overview || null,
    rating: r.vote_average ?? null,
    year: Number.isNaN(year as number) ? null : year,
    genres: (r.genres ?? []).map((g) => g.name),
  };
}
