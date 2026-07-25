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

/**
 * TMDB's static genre ids (movie + tv lists merged; ids do not collide).
 * `/search/multi` returns `genre_ids`, never genre names, so without this
 * table every search-derived record arrives with an empty genre list and
 * anything keying off "Animation" silently never fires.
 */
const TMDB_GENRES: Record<number, string> = {
  12: "Adventure",
  14: "Fantasy",
  16: "Animation",
  18: "Drama",
  27: "Horror",
  28: "Action",
  35: "Comedy",
  36: "History",
  37: "Western",
  53: "Thriller",
  80: "Crime",
  99: "Documentary",
  878: "Science Fiction",
  9648: "Mystery",
  10402: "Music",
  10749: "Romance",
  10751: "Family",
  10752: "War",
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  10770: "TV Movie",
};

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
  original_language?: string;
  origin_country?: string[];
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
  original_language?: string;
  origin_country?: string[];
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
    genres: (r.genre_ids ?? [])
      .map((id) => TMDB_GENRES[id])
      .filter((g): g is string => Boolean(g)),
    originalLanguage: r.original_language ?? null,
    originCountry: r.origin_country ?? [],
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
    originalLanguage: r.original_language ?? null,
    originCountry: r.origin_country ?? [],
  };
}
