/**
 * The slow TMDB half of a title page — episode names, the real season count,
 * hero facts, and release dates.
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
  searchTmdbCandidates,
  applyTmdbCredential,
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
/**
 * A miss is cached too — otherwise a work TMDB never heard of re-searches on
 * every render — but only briefly. The full 6h TTL on a *transient* failure
 * (a timeout, a cold-start race, a rate limit) poisoned a real title for six
 * hours: Bleach resolved fine in isolation yet its page showed "no episodes"
 * because one early null was pinned. A short negative TTL self-heals in
 * minutes while a genuinely-missing title still gets a breather.
 */
const NEG_TTL_MS = 2 * 60 * 1000;
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

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type Entry = { at: number; ttl: number; value: unknown };
const cache = new Map<string, Entry>();

/** A result carrying nothing usable — cached only briefly so it self-heals. */
function isNegativeResult(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

/**
 * Memoise per process, misses included.
 *
 * A negative result is the expensive one: without caching it, a work TMDB has
 * never heard of would re-run a search on every render of its page.
 */
async function memo<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;

  const value = await run();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    at: Date.now(),
    ttl: isNegativeResult(value) ? NEG_TTL_MS : TTL_MS,
    value,
  });
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
  const headers = applyTmdbCredential(url, key);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, {
      cache: "force-cache",
      headers,
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
// Hero facts — genres, vote count, certification, original language
// ---------------------------------------------------------------------------

/**
 * The extra dimensions a streaming-style hero prints beside the title: what it
 * is (genres), how many people scored it (vote count), who it is rated for
 * (certification), and what language it was made in (original language).
 *
 * Every one is enrichment. A missing key, a timed-out call, or a work TMDB has
 * only a stub for yields empty/null in that slot — never a throw, never a
 * placeholder the page would have to explain away.
 */
export interface TmdbTitleFacts {
  /** Genre names, provider order preserved, e.g. `["Drama", "Sci-Fi"]`. */
  genres: string[];
  voteCount: number | null;
  /** US content rating, falling back to the first region TMDB offers. */
  certification: string | null;
  /** Uppercased ISO-639-1 code for display, e.g. `"EN"`. */
  originalLanguage: string | null;
}

type RawTitleDetail = {
  genres?: Array<{ name?: string | null }>;
  vote_count?: number | null;
  original_language?: string | null;
};

type RawContentRatings = {
  results?: Array<{ iso_3166_1?: string; rating?: string | null }>;
};

/**
 * Genres, vote count and original language, plus the certification that lives
 * on a *separate* endpoint (content_ratings for TV, release_dates for film).
 *
 * The two calls have no dependency on one another, so they run together via
 * `Promise.all` rather than one after the other. Both are memoised through the
 * same detail endpoints the rest of the module already hits, so on a warm page
 * this is free.
 */
export async function fetchTitleFacts(ref: TmdbRef): Promise<TmdbTitleFacts> {
  return memo(`facts:${ref.mediaType}:${ref.id}`, async () => {
    const [detail, certRaw] = await Promise.all([
      tmdbGet<RawTitleDetail>(`/${ref.mediaType}/${ref.id}`),
      ref.mediaType === "tv"
        ? tmdbGet<RawContentRatings>(`/tv/${ref.id}/content_ratings`)
        : tmdbGet<RawReleaseDates>(`/movie/${ref.id}/release_dates`),
    ]);

    const base = parseTitleDetailFacts(detail);
    const certification =
      ref.mediaType === "tv"
        ? pickTvCertification((certRaw as RawContentRatings | null)?.results ?? [])
        : pickMovieCertification(
            (certRaw as RawReleaseDates | null)?.results ?? [],
          );

    return { ...base, certification };
  });
}

/**
 * Pull genres, vote count and original language out of a TMDB detail body.
 *
 * Pure — no I/O, testable in isolation. Genre names are trimmed and de-duped
 * but otherwise kept in provider order (TMDB lists the primary genre first).
 * A zero vote count is reported as `null`: a score with nobody behind it is not
 * a count worth printing. The language code is uppercased for display.
 */
export function parseTitleDetailFacts(
  raw: RawTitleDetail | null,
): Omit<TmdbTitleFacts, "certification"> {
  if (!raw) return { genres: [], voteCount: null, originalLanguage: null };

  const genres: string[] = [];
  for (const genre of raw.genres ?? []) {
    const name = genre.name?.trim();
    if (name && !genres.includes(name)) genres.push(name);
  }

  const voteCount =
    typeof raw.vote_count === "number" && raw.vote_count > 0
      ? raw.vote_count
      : null;

  const lang = raw.original_language?.trim();
  const originalLanguage = lang ? lang.toUpperCase() : null;

  return { genres, voteCount, originalLanguage };
}

/**
 * Pick the content rating from a TMDB `/tv/{id}/content_ratings` result set.
 *
 * Pure. Prefers the US entry — the certification a US-facing hero expects —
 * and falls back to the first non-empty rating any region supplies, so a
 * foreign show still shows *something* rather than nothing.
 */
export function pickTvCertification(
  results: Array<{ iso_3166_1?: string; rating?: string | null }>,
): string | null {
  const us = results.find((r) => r.iso_3166_1 === "US")?.rating?.trim();
  if (us) return us;
  for (const r of results) {
    const value = r.rating?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Pick the content certification from a TMDB `/movie/{id}/release_dates` set.
 *
 * Pure. A movie's certification hangs off individual release entries, so this
 * digs one level deeper than the TV form. US first, then the first non-empty
 * certification from any region.
 */
export function pickMovieCertification(results: RawCountryRelease[]): string | null {
  const us = firstCertification(
    results.find((r) => r.iso_3166_1 === "US")?.release_dates,
  );
  if (us) return us;
  for (const country of results) {
    const value = firstCertification(country.release_dates);
    if (value) return value;
  }
  return null;
}

function firstCertification(
  entries: RawCountryRelease["release_dates"],
): string | null {
  for (const entry of entries ?? []) {
    const value = entry.certification?.trim();
    if (value) return value;
  }
  return null;
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
    certification?: string | null;
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
