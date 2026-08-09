import type { MediaMetadata } from "@/lib/torrents/types";
import {
  canonicalizeSearchQuery,
  searchDiscoveryVariants,
} from "@/lib/search/query-variants";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

function isSearchDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Poster width. 500px is the smallest size that still looks sharp on a card. */
const POSTER_SIZE = "w500";
/** Backdrop width for the title-detail hero. */
const BACKDROP_SIZE = "w1280";
/** Cast headshot width. */
const PROFILE_SIZE = "w185";
/** Episode still width. */
const STILL_SIZE = "w300";

/**
 * A key must *look* like a key.
 *
 * `.env` carried `TMDB_API_KEY=xx` for months. The old gate was
 * `process.env.TMDB_API_KEY || undefined`, which treats a two-character
 * placeholder as configured: every lookup ran, every request came back 401,
 * `searchTmdb` threw, and `enrich` swallowed it. TMDB therefore looked
 * configured and contributed *nothing* — movies and TV rendered as grey letter
 * tiles for months while anime (keyless AniList) looked fine, and no error
 * appeared anywhere.
 *
 * A misconfigured key must be indistinguishable from "no key at all" so the
 * keyless fallbacks (TVmaze, iTunes) take over instead of a broken provider
 * silently winning. A real TMDB v3 key is 32 hex characters; a v4 read token is
 * a much longer JWT. Nothing legitimate is under ten characters.
 */
const MIN_KEY_LENGTH = 10;

/** Values people actually leave in `.env` files. Compared case-insensitively. */
const PLACEHOLDER_KEYS = new Set([
  "changeme",
  "change_me",
  "dummy",
  "example",
  "fake",
  "insert_key_here",
  "none",
  "null",
  "placeholder",
  "replace_me",
  "secret",
  "todo",
  "undefined",
  "your_api_key",
  "your_api_key_here",
  "your_tmdb_api_key",
  "yourapikeyhere",
]);

/** `xx`, `xxxxxxxxxxxx`, `000000…`, `----` — one character repeated is never a key. */
const REPEATED_CHAR = /^(.)\1*$/;
/** `your-key-here`, `put your key here`, `<your api key>`. */
const OBVIOUS_TEMPLATE = /\byour\b|\bhere\b|^<.*>$|\bkey\s*goes\b/i;

/**
 * True when `value` is a usable API key rather than a placeholder.
 * Exported so tests can pin the gate down directly.
 */
export function isUsableTmdbKey(value: string | undefined | null): boolean {
  if (!value) return false;
  const key = value.trim();
  if (key.length < MIN_KEY_LENGTH) return false;
  if (REPEATED_CHAR.test(key)) return false;
  const lower = key.toLowerCase();
  if (PLACEHOLDER_KEYS.has(lower)) return false;
  if (OBVIOUS_TEMPLATE.test(lower)) return false;
  return true;
}

/** The configured key, or null when absent/placeholder. Always trimmed. */
export function tmdbApiKey(): string | null {
  const raw = process.env.TMDB_API_KEY;
  return isUsableTmdbKey(raw) ? (raw as string).trim() : null;
}

/** Whether TMDB can be called at all. Callers use this to skip straight to fallbacks. */
export function hasTmdbKey(): boolean {
  return tmdbApiKey() !== null;
}

function apiKey(): string | undefined {
  return tmdbApiKey() ?? undefined;
}

/**
 * Multi-search TMDB for movies/TV. No-ops gracefully when API key is missing.
 */
export async function searchTmdb(
  query: string,
  limit = 5,
): Promise<MediaMetadata[]> {
  const key = apiKey();
  const term = canonicalizeSearchQuery(query);
  if (!key || !term) return [];
  const deadline = Date.now() + 10_000;

  const runQuery = async (q: string): Promise<MediaMetadata[]> => {
    const url = new URL(`${TMDB_BASE}/search/multi`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("query", q);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("language", "en-US");
    url.searchParams.set("page", "1");

    const res = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);

    const json = (await res.json()) as {
      results?: TmdbMultiResult[];
    };
    return (json.results ?? [])
      .filter((r) => r.media_type === "movie" || r.media_type === "tv")
      .slice(0, limit)
      .map(mapTmdb);
  };

  const primary = await runQuery(term);
  if (primary.length > 0) return primary;
  for (const variant of searchDiscoveryVariants(term)) {
    if (variant.toLowerCase() === term.toLowerCase()) continue;
    if (Date.now() >= deadline) break;
    try {
      const hits = await runQuery(variant);
      if (hits.length > 0) return hits;
    } catch (error) {
      if (isSearchDeadlineError(error)) break;
      throw error;
    }
  }
  return primary;
}

/** Search one canonical TMDB work type for title-first discovery. */
export async function searchTmdbByType(
  mediaType: "movie" | "tv",
  query: string,
  limit = 12,
): Promise<MediaMetadata[]> {
  const key = apiKey();
  const term = canonicalizeSearchQuery(query);
  if (!key || !term) return [];
  const deadline = Date.now() + 10_000;

  const runQuery = async (q: string): Promise<MediaMetadata[]> => {
    const url = new URL(`${TMDB_BASE}/search/${mediaType}`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("query", q);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("language", "en-US");
    url.searchParams.set("page", "1");

    const res = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);

    const json = (await res.json()) as { results?: TmdbMultiResult[] };
    return (json.results ?? [])
      .slice(0, limit)
      .map((result) => mapTmdb({ ...result, media_type: mediaType }));
  };

  // The raw term first — it is what the owner typed and TMDB is genuinely good
  // at popular exact titles. Only when it comes back empty do we spend extra
  // calls on the normalized short forms (`Re:ZERO -Starting…` → `Re Zero`),
  // the exact rescue the grab ladder already relies on. The first variant that
  // finds anything wins; we never merge weaker forms into a good exact match.
  const primary = await runQuery(term);
  if (primary.length > 0) return primary;

  for (const variant of searchDiscoveryVariants(term)) {
    if (variant.toLowerCase() === term.toLowerCase()) continue;
    if (Date.now() >= deadline) break;
    try {
      const hits = await runQuery(variant);
      if (hits.length > 0) return hits;
    } catch (error) {
      if (isSearchDeadlineError(error)) break;
      throw error;
    }
  }
  return primary;
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
 * A search hit reduced to what artwork selection needs.
 *
 * `MediaMetadata` deliberately has no popularity field, but popularity is the
 * only sane tie-break between three films genuinely called "Dune", so artwork
 * lookups use this shape instead.
 */
export interface TmdbCandidate {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  /** TMDB's own popularity metric. Tie-break only — never a match signal. */
  popularity: number;
  voteCount: number;
}

export type TmdbSearchScope = "movie" | "tv" | "multi";

/**
 * Search one TMDB endpoint and return raw candidates for a caller to judge.
 *
 * Never throws and never returns a "best" answer: choosing is the caller's job
 * (see `artwork.ts`), because the right choice depends on the requested year
 * and media type.
 *
 * **`year` is a boost, not a filter.** Verified against the live API from this
 * machine: `/search/movie?query=dune&year=2024` returns *Dune* (2021-09-15)
 * ahead of *Dune: Part Two* (2024-02-27), plus *Anatomy of a Fall* (2023) and
 * *The Dune* (2025). Passing the year still improves recall for obscure
 * titles, but anything that trusts TMDB to have filtered by it will hang the
 * wrong poster on the card.
 */
export async function searchTmdbCandidates(
  scope: TmdbSearchScope,
  query: string,
  opts: { year?: number | null; limit?: number; timeoutMs?: number } = {},
): Promise<TmdbCandidate[]> {
  const key = apiKey();
  const term = query.trim();
  if (!key || !term) return [];

  const { year, limit = 8, timeoutMs = 5000 } = opts;

  const url = new URL(`${TMDB_BASE}/search/${scope}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", term);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");
  if (year && scope === "movie") url.searchParams.set("year", String(year));
  // `/search/multi` accepts no year parameter at all; sending one is ignored.
  if (year && scope === "tv") {
    url.searchParams.set("first_air_date_year", String(year));
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];

    const json = (await res.json()) as { results?: TmdbMultiResult[] };
    return (json.results ?? [])
      .filter((r) => {
        if (scope === "movie") return r.media_type !== "tv";
        if (scope === "tv") return r.media_type !== "movie";
        return r.media_type === "movie" || r.media_type === "tv";
      })
      .slice(0, limit)
      .map((r) => toCandidate(r, scope));
  } catch {
    // Timeout, DNS failure, proxy interference — artwork is optional by design.
    return [];
  }
}

function toCandidate(r: TmdbMultiResult, scope: TmdbSearchScope): TmdbCandidate {
  const mediaType: "movie" | "tv" =
    r.media_type === "tv" || r.media_type === "movie"
      ? r.media_type
      : scope === "tv"
        ? "tv"
        : "movie";
  const date = r.release_date || r.first_air_date;
  const year = date ? parseInt(date.slice(0, 4), 10) : null;

  return {
    id: r.id,
    mediaType,
    title: r.title || r.name || "",
    year: year != null && Number.isFinite(year) ? year : null,
    posterUrl: posterUrl(r.poster_path),
    backdropUrl: backdropUrl(r.backdrop_path),
    popularity: typeof r.popularity === "number" ? r.popularity : 0,
    voteCount: typeof r.vote_count === "number" ? r.vote_count : 0,
  };
}

export function posterUrl(path: string | null | undefined): string | null {
  return path ? `${IMG}/${POSTER_SIZE}${path}` : null;
}

export function backdropUrl(path: string | null | undefined): string | null {
  return path ? `${IMG}/${BACKDROP_SIZE}${path}` : null;
}

/** Cast headshot. `w185` is the smallest size that survives a 2x avatar. */
export function profileUrl(path: string | null | undefined): string | null {
  return path ? `${IMG}/${PROFILE_SIZE}${path}` : null;
}

/** Episode still. 16:9, so `w300` is the card-sized rendition. */
export function stillUrl(path: string | null | undefined): string | null {
  return path ? `${IMG}/${STILL_SIZE}${path}` : null;
}

// ---------------------------------------------------------------------------
// Detail (IMDb-grade fields)
// ---------------------------------------------------------------------------

/**
 * Full detail for one known TMDB id, credits and certification included.
 *
 * One request, not four: `append_to_response` folds `credits` and the
 * certification resource into the same round trip, which is the difference
 * between a title page that opens and one that waits on a waterfall. Verified
 * against the live API — `/movie/693134?append_to_response=credits,release_dates`
 * returns 98 cast, 149 crew, `runtime: 167`, `tagline`, `vote_count: 8233` and
 * US `PG-13` in a single 200.
 *
 * Never throws: a detail page without credits is fine, a detail page that 500s
 * is not.
 */
export async function fetchTmdbDetail(
  mediaType: "movie" | "tv",
  id: number,
  opts: { timeoutMs?: number } = {},
): Promise<TmdbFullDetail | null> {
  const key = apiKey();
  if (!key || !Number.isFinite(id)) return null;

  const url = new URL(`${TMDB_BASE}/${mediaType}/${id}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");
  url.searchParams.set(
    "append_to_response",
    mediaType === "movie" ? "credits,release_dates" : "credits,content_ratings",
  );

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as TmdbFullDetail;
  } catch {
    return null;
  }
}

/** Episodes of one season. Separate endpoint — TMDB does not append them. */
export async function fetchTmdbSeason(
  id: number,
  seasonNumber: number,
  opts: { timeoutMs?: number } = {},
): Promise<TmdbSeasonDetail | null> {
  const key = apiKey();
  if (!key || !Number.isFinite(id) || !Number.isFinite(seasonNumber)) {
    return null;
  }

  const url = new URL(`${TMDB_BASE}/tv/${id}/season/${seasonNumber}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as TmdbSeasonDetail;
  } catch {
    return null;
  }
}

export interface TmdbCredit {
  name?: string;
  character?: string;
  job?: string;
  profile_path?: string | null;
  order?: number;
}

export interface TmdbEpisode {
  episode_number?: number;
  season_number?: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  runtime?: number | null;
  air_date?: string | null;
  vote_average?: number;
}

export interface TmdbSeasonDetail {
  season_number?: number;
  name?: string;
  episodes?: TmdbEpisode[];
}

export interface TmdbFullDetail extends TmdbDetail {
  tagline?: string;
  status?: string;
  runtime?: number | null;
  vote_count?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  created_by?: { name?: string }[];
  seasons?: {
    season_number?: number;
    name?: string;
    episode_count?: number;
    air_date?: string | null;
    poster_path?: string | null;
  }[];
  credits?: { cast?: TmdbCredit[]; crew?: TmdbCredit[] };
  release_dates?: {
    results?: {
      iso_3166_1?: string;
      release_dates?: { certification?: string; type?: number }[];
    }[];
  };
  content_ratings?: { results?: { iso_3166_1?: string; rating?: string }[] };
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
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
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
  original_title?: string;
  original_name?: string;
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
  const aliases = distinctTitles(
    title,
    r.original_title,
    r.original_name,
  );

  return {
    source: "tmdb",
    mediaType,
    externalId: String(r.id),
    title,
    aliases,
    posterUrl: posterUrl(r.poster_path),
    backdropUrl: backdropUrl(r.backdrop_path),
    synopsis: r.overview || null,
    rating: r.vote_average ?? null,
    year: Number.isNaN(year as number) ? null : year,
    releaseDate: normalizeTmdbDate(r.release_date, r.first_air_date),
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
  const aliases = distinctTitles(
    title,
    r.original_title,
    r.original_name,
  );

  return {
    source: "tmdb",
    mediaType,
    externalId: String(r.id),
    title,
    aliases,
    posterUrl: posterUrl(r.poster_path),
    backdropUrl: backdropUrl(r.backdrop_path),
    synopsis: r.overview || null,
    rating: r.vote_average ?? null,
    year: Number.isNaN(year as number) ? null : year,
    releaseDate: normalizeTmdbDate(r.release_date, r.first_air_date),
    genres: (r.genres ?? []).map((g) => g.name),
    originalLanguage: r.original_language ?? null,
    originCountry: r.origin_country ?? [],
  };
}

function distinctTitles(
  primary: string,
  ...values: (string | null | undefined)[]
): string[] {
  return [...new Set(
    [primary, ...values]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];
}

/**
 * The primary release / first-air date as a stored `YYYY-MM-DD`, or null.
 *
 * A movie's date is `release_date`, a series' is `first_air_date`; TMDB gives a
 * full ISO date or an empty string, and only a real date survives. This feeds
 * future-gating (grayed poster + "Coming {date}") — see release-status.ts — so
 * an absent or malformed date is null, never a fabricated one.
 */
export function normalizeTmdbDate(
  releaseDate: string | undefined,
  firstAirDate: string | undefined,
): string | null {
  const raw = (releaseDate || firstAirDate || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (!(year > 1800 && year < 2200)) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}