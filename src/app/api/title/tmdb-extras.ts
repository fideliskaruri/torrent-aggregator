/**
 * The slow half of a title page — episode names, the real season count, and
 * "more like this".
 *
 * Kept out of `GET /api/title/[workKey]` on purpose. That route answers from
 * the local database only, so the page paints immediately; everything here
 * needs the network and therefore lands in a *second* round trip
 * (`/api/title/[workKey]/extras`) that the page merges in when it arrives.
 * Nothing on screen waits for this module.
 *
 * Two rules govern what comes out of it:
 *
 *  - **A TMDB id has to be earned.** `searchTmdbCandidates` returns whatever
 *    the search endpoint felt like; the top hit for "Dune" (2024) is *Dune*
 *    (2021). So a candidate is only accepted when the title genuinely matches
 *    (`matchTier`, the same scorer `artwork.ts` uses) and the year agrees.
 *    Wearing another work's episode list is the same defect as wearing another
 *    film's poster.
 *  - **Absent is not wrong.** Every fetch here is allowed to fail, time out or
 *    be skipped for want of an API key, and every one of those cases returns
 *    empty rather than throwing. The page must be correct with none of this.
 */
import { cleanQueryTitle, matchTier } from "@/lib/metadata/artwork";
import {
  isSeriesMediaType,
  normalizeMediaType,
} from "@/lib/metadata/media-type";
import {
  posterUrl,
  searchTmdbCandidates,
  tmdbApiKey,
  type TmdbCandidate,
  type TmdbSearchScope,
} from "@/lib/metadata/tmdb";
import type { TitleEpisodeMeta } from "@/components/title/types";

const TMDB_BASE = "https://api.themoviedb.org/3";
/** Episode stills. Small on purpose — this is a 16:9 thumbnail in a row. */
const STILL_BASE = "https://image.tmdb.org/t/p/w300";

/** Long enough that a season tab flick is free, short enough to stay fresh. */
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 400;
const TIMEOUT_MS = 4000;

/**
 * The floor `artwork.ts` calls `TIER_ARTICLE` — "same title once a leading
 * article is discounted". Anything below that is not confidently the same work.
 */
const MIN_TIER = 72;

export interface TmdbRef {
  id: number;
  mediaType: "movie" | "tv";
}

export interface TmdbShowShape {
  /** Seasons TMDB knows about, specials excluded. */
  seasonCount: number | null;
  seasons: number[];
  episodesBySeason: Record<number, number>;
}

type RawShow = {
  number_of_seasons?: number;
  seasons?: { season_number?: number; episode_count?: number }[];
};

/**
 * A neighbouring work, before it is given a link.
 *
 * Deliberately not `TitleSimilar`: turning one of these into a page link needs
 * `workKeyFor`, which is the route's job, not the provider client's.
 */
export interface TmdbSimilar {
  title: string;
  year: number | null;
  mediaType: "movie" | "tv";
  posterUrl: string | null;
  rating: number | null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type Entry = { at: number; value: unknown };
const cache = new Map<string, Entry>();

/**
 * Memoise per process, misses included.
 *
 * A negative result is the expensive one: without caching it, a work TMDB has
 * never heard of would re-run a search on every render of its page.
 */
async function memo<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  const value = await run();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test seam. Not called by the app. */
export function resetTmdbExtrasCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function tmdbGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  const key = tmdbApiKey();
  if (!key) return null;

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: 21600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Timeout, DNS, proxy, rate limit. All of it is optional enrichment.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function scopeFor(mediaType: string | null): TmdbSearchScope {
  const normalized = normalizeMediaType(mediaType);
  if (!normalized) return "multi";
  return isSeriesMediaType(normalized) ? "tv" : "movie";
}

/**
 * Score a candidate the way `artwork.ts` does: title first, year as evidence.
 *
 * Returns `null` for anything not confidently this work. A wrong id here is
 * worse than no id, because it produces a *confident* wrong answer — the exact
 * failure family this repo has already been burned by.
 */
function scoreCandidate(
  queryTitle: string,
  year: number | null,
  candidate: TmdbCandidate,
): number | null {
  const tier = matchTier(queryTitle, candidate.title);
  if (tier < MIN_TIER) return null;

  let score = tier;
  if (year != null && candidate.year != null) {
    const diff = Math.abs(candidate.year - year);
    if (diff === 0) score += 30;
    else if (diff === 1) score += 8;
    else score -= 45;
  }
  return score >= MIN_TIER ? score : null;
}

/** The TMDB id for a work, or null when nothing matched well enough. */
export async function resolveTmdbRef(query: {
  title: string;
  year: number | null;
  mediaType: string | null;
}): Promise<TmdbRef | null> {
  // `cleanQueryTitle` strips release noise *and* recovers a year sitting in
  // the title, which is the only year some callers have — "Dune 2021" arrives
  // as a title, not as a year field.
  const cleaned = cleanQueryTitle(query.title);
  const name = cleaned.title;
  if (!name) return null;
  const year = query.year ?? cleaned.year;

  const scope = scopeFor(query.mediaType);
  const key = `ref:${scope}:${name.toLowerCase()}:${year ?? ""}`;

  return memo(key, async () => {
    const candidates = await searchTmdbCandidates(scope, name, {
      year,
      limit: 8,
      timeoutMs: TIMEOUT_MS,
    });

    let best: TmdbCandidate | null = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = scoreCandidate(name, year, candidate);
      if (score == null) continue;
      if (
        score > bestScore ||
        (score === bestScore &&
          best != null &&
          candidate.popularity > best.popularity)
      ) {
        best = candidate;
        bestScore = score;
      }
    }

    return best ? { id: best.id, mediaType: best.mediaType } : null;
  });
}

// ---------------------------------------------------------------------------
// Synopsis and score
// ---------------------------------------------------------------------------

export interface TmdbWorkBlurb {
  overview: string | null;
  rating: number | null;
  /**
   * Primary release / first-air date, `YYYY-MM-DD`. The base payload knows this
   * only for works already in the local catalog, so a title opened straight
   * from search would otherwise have no date to gate on and would offer Play
   * for something that is not out yet.
   */
  releaseDate: string | null;
}

/**
 * The synopsis and score for a resolved work.
 *
 * The base title payload only carries a blurb it can vouch for from *local*
 * data. When the sole cached row is rejected as a different work — a bare
 * "Dune" must not wear "Dune: Prophecy"'s synopsis — it has none, and the hero
 * would read as a title with no description. This fills that gap from the same
 * TMDB id the rest of the extras are built on, so the words on the page always
 * describe the work the page resolved to. Absent stays absent, never wrong.
 */
export async function fetchWorkBlurb(ref: TmdbRef): Promise<TmdbWorkBlurb> {
  return memo(`blurb:${ref.mediaType}:${ref.id}`, async () => {
    const raw = await tmdbGet<{
      overview?: string | null;
      vote_average?: number | null;
      release_date?: string | null;
      first_air_date?: string | null;
    }>(`/${ref.mediaType}/${ref.id}`);
    if (!raw) return { overview: null, rating: null, releaseDate: null };
    const overview =
      typeof raw.overview === "string" && raw.overview.trim()
        ? raw.overview.trim()
        : null;
    const rating =
      typeof raw.vote_average === "number" && raw.vote_average > 0
        ? raw.vote_average
        : null;
    const rawDate = raw.release_date || raw.first_air_date || null;
    const releaseDate =
      typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim())
        ? rawDate.trim()
        : null;
    return { overview, rating, releaseDate };
  });
}

// ---------------------------------------------------------------------------
// Shows, seasons, episodes
// ---------------------------------------------------------------------------

/**
 * How many seasons there really are.
 *
 * The hero used to print the number of seasons *we hold files for*, which read
 * "1 season" directly above a list headed "5 in season 2". A count that
 * contradicts the thing under it is worse than no count, so this is the only
 * source allowed to fill it — and when it is unknown, the fact is omitted.
 */
export async function fetchShowShape(id: number): Promise<TmdbShowShape> {
  return memo(`show:${id}`, async () => {
    const json = await tmdbGet<RawShow>(`/tv/${id}`);
    if (!json) return { seasonCount: null, seasons: [], episodesBySeason: {} };
    return parseShowShape(json);
  });
}

/** Convert only season numbers TMDB explicitly supplied; never fill gaps. */
export function parseShowShape(json: RawShow): TmdbShowShape {
  const seasons: number[] = [];
  const episodesBySeason: Record<number, number> = {};
  for (const season of json.seasons ?? []) {
    const n = season.season_number;
    // Season 0 is specials. It is not "a season" in the sense a user means.
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    if (!seasons.includes(n)) seasons.push(n);
    if (typeof season.episode_count === "number" && season.episode_count > 0) {
      episodesBySeason[n] = season.episode_count;
    }
  }
  seasons.sort((a, b) => a - b);

  const declared = json.number_of_seasons;
  const seasonCount =
    typeof declared === "number" && Number.isInteger(declared) && declared > 0
      ? declared
      : seasons.length > 0
        ? seasons.length
        : null;

  return { seasonCount, seasons, episodesBySeason };
}

type RawEpisode = {
  episode_number?: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
};

/** Names, synopses, air dates and runtimes for one season. */
export async function fetchSeasonEpisodes(
  id: number,
  season: number,
): Promise<TitleEpisodeMeta[]> {
  return memo(`season:${id}:${season}`, async () => {
    const json = await tmdbGet<{ episodes?: RawEpisode[] }>(
      `/tv/${id}/season/${season}`,
    );
    return parseSeasonEpisodes(json);
  });
}

/** Preserve every real episode row in TMDB's requested-season response. */
export function parseSeasonEpisodes(json: {
  episodes?: RawEpisode[];
} | null): TitleEpisodeMeta[] {
  if (!json?.episodes) return [];

  const out: TitleEpisodeMeta[] = [];
  const seen = new Set<number>();
  for (const raw of json.episodes) {
      const n = raw.episode_number;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || seen.has(n)) {
        continue;
      }
      seen.add(n);
      out.push({
        episode: n,
        name: text(raw.name),
        overview: text(raw.overview),
        airDate: isoDate(raw.air_date),
        runtimeMin:
          typeof raw.runtime === "number" && raw.runtime > 0 ? raw.runtime : null,
        stillUrl: raw.still_path ? `${STILL_BASE}${raw.still_path}` : null,
      });
  }
  out.sort((a, b) => a.episode - b.episode);
  return out;
}

// ---------------------------------------------------------------------------
// Home release dates (movies only)
// ---------------------------------------------------------------------------

/**
 * TMDB release type codes that constitute a "home release".
 *
 * 1 = Premiere, 2 = Theatrical (limited), 3 = Theatrical
 * 4 = Digital, 5 = Physical, 6 = TV
 *
 * Only types 4–6 bring the film out of its theatrical window.
 */
const HOME_RELEASE_TYPES = new Set([4, 5, 6]);

type RawCountryRelease = {
  iso_3166_1?: string;
  release_dates?: Array<{
    release_date?: string | null;
    type?: number | null;
  }>;
};

type RawReleaseDates = {
  results?: RawCountryRelease[];
};

export interface TmdbHomeRelease {
  /**
   * True when the TMDB release_dates endpoint responded with parseable data.
   *
   * Callers must not gate on a film when `checked` is false — an unreachable
   * endpoint is not evidence that the film has no home release.
   */
  checked: boolean;
  /** Earliest ISO date (YYYY-MM-DD) of a past home release, or null. */
  releasedAt: string | null;
  /** Earliest ISO date of a future home release (Digital/Physical/TV), or null. */
  nextHomeReleaseAt: string | null;
}

/**
 * Classify a TMDB release_dates result into past and future home release dates.
 *
 * Pure — no I/O, testable in isolation.
 *
 * `today` is a `YYYY-MM-DD` string representing the caller's "now".
 * Home-release types are Digital (4), Physical (5), and TV (6).
 * Premiere (1), Theatrical-limited (2), and Theatrical (3) do not count.
 */
export function classifyHomeReleaseDates(
  results: RawCountryRelease[],
  today: string,
): Pick<TmdbHomeRelease, "releasedAt" | "nextHomeReleaseAt"> {
  const past: string[] = [];
  const future: string[] = [];

  for (const country of results) {
    for (const entry of country.release_dates ?? []) {
      const type = entry.type;
      if (!HOME_RELEASE_TYPES.has(type ?? 0)) continue;
      const dateStr = parseTmdbDate(entry.release_date);
      if (!dateStr) continue;
      if (dateStr <= today) {
        past.push(dateStr);
      } else {
        future.push(dateStr);
      }
    }
  }

  past.sort();
  future.sort();
  return {
    releasedAt: past[0] ?? null,
    nextHomeReleaseAt: future[0] ?? null,
  };
}

/**
 * Whether the film has had a home release (Digital/Physical/TV) yet.
 *
 * TMDB's primary `release_date` is the EARLIEST theatrical or premiere date.
 * A film that opened in cinemas last week has a past `release_date` but no
 * home release, and must not be offered for Play or Download.
 *
 * Returns `checked: false` when the endpoint failed or returned nothing.
 * Callers must treat an unchecked film as gettable — unknown data never gates.
 */
export async function fetchHomeRelease(id: number): Promise<TmdbHomeRelease> {
  return memo(`homerelease:${id}`, async () => {
    const raw = await tmdbGet<RawReleaseDates>(`/movie/${id}/release_dates`);
    if (!raw?.results) {
      return { checked: false, releasedAt: null, nextHomeReleaseAt: null };
    }
    const today = new Date().toISOString().slice(0, 10);
    return { checked: true, ...classifyHomeReleaseDates(raw.results, today) };
  });
}

// ---------------------------------------------------------------------------
// More like this
// ---------------------------------------------------------------------------

type RawWork = {
  id?: number;
  title?: string | null;
  name?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  poster_path?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
};

/**
 * Neighbours of this work, for the space under the hero.
 *
 * A film has no episode list, so without this the page is a hero and then
 * several hundred pixels of nothing — which reads as broken. `/recommendations`
 * is TMDB's better list but is sparse for obscure works, so `/similar` tops it
 * up. Items with no poster are dropped: a rail of blank tiles is not content.
 */
export async function fetchMoreLikeThis(
  ref: TmdbRef,
  limit = 12,
): Promise<TmdbSimilar[]> {
  return memo(`similar:${ref.mediaType}:${ref.id}:${limit}`, async () => {
    const primary = await tmdbGet<{ results?: RawWork[] }>(
      `/${ref.mediaType}/${ref.id}/recommendations`,
    );

    const raw: RawWork[] = [...(primary?.results ?? [])];
    if (raw.length < limit) {
      const secondary = await tmdbGet<{ results?: RawWork[] }>(
        `/${ref.mediaType}/${ref.id}/similar`,
      );
      raw.push(...(secondary?.results ?? []));
    }

    const seen = new Set<number>();
    const out: TmdbSimilar[] = [];
    for (const item of raw) {
      if (out.length >= limit) break;
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);

      const title = text(item.title) ?? text(item.name);
      const poster = posterUrl(item.poster_path);
      if (!title || !poster) continue;

      const date = item.release_date || item.first_air_date || "";
      const year = date ? Number.parseInt(date.slice(0, 4), 10) : NaN;
      const votes = typeof item.vote_count === "number" ? item.vote_count : 0;
      const average =
        typeof item.vote_average === "number" ? item.vote_average : 0;

      out.push({
        title,
        year: Number.isFinite(year) ? year : null,
        mediaType: ref.mediaType,
        posterUrl: poster,
        // A 10.0 from four voters is not a rating. Below the floor, say nothing.
        rating: average > 0 && votes >= 20 ? Math.round(average * 10) / 10 : null,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** TMDB sends `""` for "no date"; that must not become a fake air date. */
function isoDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Extract a `YYYY-MM-DD` date from a TMDB date string.
 *
 * TMDB release_dates carry full ISO-8601 timestamps like
 * `"2026-07-15T00:00:00.000Z"`. Taking the first 10 characters works for
 * both that format and bare `"YYYY-MM-DD"` strings.
 */
function parseTmdbDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  return match ? match[0] : null;
}
