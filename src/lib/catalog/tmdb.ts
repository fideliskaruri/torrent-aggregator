/**
 * TMDB — the answer to *what exists and what is popular*.
 *
 * This module replaced a design that built the catalog out of torrent release
 * names, and the reason is worth keeping written down, because it is the
 * difference between a product and a directory listing.
 *
 * A top-100 torrent chart is a list of *files*:
 *
 *   Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H264.MP4-BTM
 *   House of the Dragon S03E05 480p x264-mSD
 *
 * Turning those back into "Obsession" and "House of the Dragon" is possible —
 * `src/lib/torrents/work-identity.ts` does it, and does it well — but it is
 * reverse-engineering, it is lossy, and it yields a title and nothing else. No
 * poster, no synopsis, no rating. TMDB returns *the same titles this week*
 * with all of that attached and none of the guessing, so the catalog is built
 * from TMDB and the charts are demoted to what they are actually authoritative
 * about: whether a thing can be downloaded, and how healthily. See
 * `./availability.ts`.
 *
 * ## Rules this module holds to
 *
 * **Titles are passed through verbatim.** A TMDB `title` is already canonical,
 * and putting it through release-name cleaning would actively damage it — the
 * cleaner reads "A Shop for Killers" as a title plus a scene group and returns
 * "A Shop for". Release-name logic belongs on release names. Nowhere else.
 *
 * **Nothing here throws.** Every call returns `{ …, error }`. A dead network,
 * a missing key, a 401, a body that changed shape — all of them are "no data
 * from TMDB", which the refresh layer turns into "keep serving the cache".
 * The home page must never be able to fail because a third party did.
 *
 * **`vote_average: 0` is not a rating of zero.** TMDB returns 0 for
 * *unrated*, and printing "0.0" under a poster would be inventing a verdict
 * nobody gave. Unrated arrives here as `null`.
 */
import { normalizeMediaType, type MediaType } from "@/lib/metadata/media-type";

/** Overridable so an offline test can point the client at a dead port. */
const BASE = process.env.TMDB_BASE_URL ?? "https://api.themoviedb.org/3";
const IMAGE_BASE = process.env.TMDB_IMAGE_BASE_URL ?? "https://image.tmdb.org/t/p";

/**
 * Image sizes.
 *
 * `w500` is the width a poster tile is actually rendered near, and `w1280` is
 * what a hero backdrop needs; asking for `original` would ship multi-megabyte
 * JPEGs into a rail of twenty-four cards.
 */
export const TMDB_POSTER_SIZE = "w500";
export const TMDB_BACKDROP_SIZE = "w1280";

/** Matches the feed client's budget: long enough for a slow proxy, no longer. */
export const TMDB_TIMEOUT_MS = 8_000;

/**
 * The wait a *read path* may spend on TMDB.
 *
 * "Because you're watching…" is rebuilt from a browse read, so its budget is
 * a fraction of the refresh budget; past it, the row is derived from cache
 * instead. A row that is slightly less well chosen beats a page that hangs.
 */
export const TMDB_READ_TIMEOUT_MS = 3_500;

/** TMDB's two endpoint families. Not a media type — see {@link TmdbTitle}. */
export type TmdbKind = "movie" | "tv";

/** One catalog title as TMDB states it. Nothing derived, nothing guessed. */
export interface TmdbTitle {
  tmdbId: number;
  kind: TmdbKind;
  /** Canonical, verbatim. Never round-tripped through release-name cleaning. */
  title: string;
  year: number | null;
  mediaType: MediaType;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  /** TMDB's 0–10 vote average, or null when the title is simply unrated. */
  rating: number | null;
}

/**
 * The outcome of one TMDB call.
 *
 * `titles: []` with `error: null` (TMDB answered, had nothing) and `titles: []`
 * with an error (we never reached TMDB) are different states, and the refresh
 * layer treats them differently: the first is a real answer, the second must
 * never be allowed to overwrite a cache that was fine a minute ago.
 */
export interface TmdbResult {
  titles: TmdbTitle[];
  error: string | null;
}

/** Is a key configured at all? Absence is a normal state, not a failure. */
export function hasTmdbKey(): boolean {
  return readKey() !== null;
}

function readKey(): string | null {
  const key = process.env.TMDB_API_KEY?.trim();
  return key ? key : null;
}

/** Build a full image URL, or null when TMDB has no artwork for the field. */
export function tmdbImageUrl(path: unknown, size: string): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith("/")) return null;
  return `${IMAGE_BASE}/${size}${trimmed}`;
}

interface TmdbRow {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  media_type?: unknown;
  release_date?: unknown;
  first_air_date?: unknown;
  poster_path?: unknown;
  backdrop_path?: unknown;
  overview?: unknown;
  vote_average?: unknown;
}

/**
 * Parse a TMDB list body.
 *
 * Exported so the shape can be tested against captured payloads without a
 * network — the parsing is where a silent regression would hide, and a live
 * assertion against a chart that changes hourly can only ever be vague.
 *
 * Rows without an id or a usable title are dropped rather than defaulted: an
 * untitled card is not a card. Duplicates by id are dropped too, since paging
 * a chart that reorders between requests can return the same title twice.
 */
export function parseTmdbList(data: unknown, kind: TmdbKind): TmdbTitle[] {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];

  const out: TmdbTitle[] = [];
  const seen = new Set<number>();

  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as TmdbRow;

    const tmdbId = typeof row.id === "number" && row.id > 0 ? row.id : null;
    if (tmdbId === null || seen.has(tmdbId)) continue;

    const title = firstString(row.title, row.name);
    if (!title) continue;

    // A mixed-media endpoint labels its own rows; a single-kind endpoint does
    // not, and then the requested kind is the answer. A row that labels itself
    // as something else — TMDB search will happily return a *person*, who has
    // a `name` and would otherwise sail through as a title — is dropped.
    const labelled = row.media_type === undefined || row.media_type === null;
    const rowKind = labelled ? kind : asKind(row.media_type);
    if (!rowKind) continue;
    const mediaType = normalizeMediaType(rowKind);
    if (!mediaType) continue;

    seen.add(tmdbId);
    out.push({
      tmdbId,
      kind: rowKind,
      title,
      year: parseYear(row.release_date ?? row.first_air_date),
      mediaType,
      posterUrl: tmdbImageUrl(row.poster_path, TMDB_POSTER_SIZE),
      backdropUrl: tmdbImageUrl(row.backdrop_path, TMDB_BACKDROP_SIZE),
      overview: firstString(row.overview),
      rating: parseRating(row.vote_average),
    });
  }

  return out;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asKind(value: unknown): TmdbKind | null {
  return value === "movie" || value === "tv" ? value : null;
}

/** `"2024-03-01"` → `2024`. Anything else → null; a partial date is not a year. */
function parseYear(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 1800 ? year : null;
}

/** TMDB uses 0 for *unrated*, and an unrated title has no rating to show. */
function parseRating(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 10) return null;
  return Math.round(value * 10) / 10;
}

/** One GET. Returns a body or an error string, never both, and never throws. */
async function tmdbGet(
  path: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<{ data: unknown; error: string | null }> {
  const key = readKey();
  if (!key) return { data: null, error: "TMDB_API_KEY is not set" };

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("api_key", key);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // The whole point of this layer is that it is cached in the database on
      // a timer; letting the runtime keep a second copy would only make the
      // "refreshed at" the rails report a lie.
      cache: "no-store",
    });
    if (!res.ok) return { data: null, error: `HTTP ${res.status}` };
    return { data: await res.json(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * This week's chart for one kind.
 *
 * `pages` exists because one TMDB page is twenty titles and a rail renders
 * twenty-four. It is also what keeps "Because you're watching…" from being the
 * row beneath it rearranged: that row is drawn from this same cache, so the
 * cache has to be deeper than what a rail puts on screen.
 *
 * Pages are fetched concurrently and merged in order. A page that fails is
 * skipped, not fatal — nineteen titles is a rail; an error is not.
 */
export async function fetchTmdbTrending(
  kind: TmdbKind,
  pages = 2,
  timeoutMs = TMDB_TIMEOUT_MS,
): Promise<TmdbResult> {
  const wanted = Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1);

  const responses = await Promise.all(
    wanted.map((page) =>
      tmdbGet(`/trending/${kind}/week`, { page: String(page) }, timeoutMs),
    ),
  );

  const titles: TmdbTitle[] = [];
  const seen = new Set<number>();
  const errors: string[] = [];

  for (const response of responses) {
    if (response.error) {
      errors.push(response.error);
      continue;
    }
    for (const title of parseTmdbList(response.data, kind)) {
      if (seen.has(title.tmdbId)) continue;
      seen.add(title.tmdbId);
      titles.push(title);
    }
  }

  // An error is only reported when it cost us everything. A first page that
  // landed and a second that timed out is a shorter rail, not a broken one.
  return { titles, error: titles.length > 0 ? null : (errors[0] ?? null) };
}

/**
 * Find the catalog entry a locally-watched title refers to.
 *
 * The seed is a display title harvested from the user's own playback rows, so
 * it is spelled however the file it came from spelled it. TMDB's search is the
 * thing that copes with that; the first result is taken because TMDB already
 * ranks by relevance and popularity, and a second-guessing heuristic here
 * would be the bespoke recommender the plan lists as a non-goal.
 */
export async function searchTmdb(
  kind: TmdbKind,
  query: string,
  year: number | null = null,
  timeoutMs = TMDB_READ_TIMEOUT_MS,
): Promise<{ title: TmdbTitle | null; error: string | null }> {
  const trimmed = query.trim();
  if (!trimmed) return { title: null, error: null };

  const params: Record<string, string> = { query: trimmed, include_adult: "false" };
  if (year) params[kind === "movie" ? "year" : "first_air_date_year"] = String(year);

  const { data, error } = await tmdbGet(`/search/${kind}`, params, timeoutMs);
  if (error) return { title: null, error };

  return { title: parseTmdbList(data, kind)[0] ?? null, error: null };
}

/**
 * TMDB's own "more like this".
 *
 * `/recommendations` rather than `/similar`: both were probed against this key
 * and they are not close. House of the Dragon recommends The Witcher and The
 * Sandman; `/similar` returned unrelated anime. A bespoke recommender is an
 * explicit non-goal, so using the catalog's own — much better — answer is
 * exactly the right amount of work to do here.
 */
export async function fetchTmdbRecommendations(
  kind: TmdbKind,
  tmdbId: number,
  timeoutMs = TMDB_READ_TIMEOUT_MS,
): Promise<TmdbResult> {
  const { data, error } = await tmdbGet(
    `/${kind}/${tmdbId}/recommendations`,
    {},
    timeoutMs,
  );
  if (error) return { titles: [], error };
  return { titles: parseTmdbList(data, kind), error: null };
}
