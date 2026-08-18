/**
 * IMDb-grade detail for one work: synopsis, rating, runtime, genres,
 * certification, tagline, cast, director/creator, and season/episode listings.
 *
 * ## Two tiers, one identity
 *
 * This is not a second TMDB client. Identifying *which* work a title refers to
 * is the hardest part of this problem and it is already solved in `artwork.ts`
 * — normalisation, tiered matching, year weighting, the instalment/companion
 * rules that keep "Dune" off *Dune: Part Two*. `resolveTmdbRef` hands that
 * decision over, and this module only turns the resulting id into fields. A
 * card and the title page it links to therefore cannot disagree about which
 * film they are describing, and for movies and series the detail lookup costs
 * no extra search because the artwork pass already recorded the id.
 *
 * When TMDB cannot answer — no key, a placeholder key, a revoked key, a work it
 * has never heard of — the second tier takes over: `keyless-detail.ts`, which
 * asks AniList, TVmaze and iTunes through *the same matcher*. That tier exists
 * because gating text on `TMDB_API_KEY` left this install with a synopsis on 0
 * of 120 catalog rows and title pages that showed a letter tile and a title.
 * Artwork already had keyless fallbacks; text did not. Precedence is strictly
 * one-directional — a fallback is consulted only when TMDB produced nothing at
 * all, so it can never overwrite or dilute a TMDB answer.
 *
 * ## Never block a page
 *
 * Same discipline as artwork: a per-request timeout, bounded batch concurrency,
 * positive *and* negative caching, and no path that throws. A title page with
 * no credits is a worse page; a title page that hangs on credits is a broken
 * product. Every entry point here returns `null` or `[]` rather than raising.
 *
 * ## Honesty
 *
 * Missing is `null`, never invented and never zero. Two real examples found
 * while building this, both from the live API:
 *
 * - *Severance* returns `episode_run_time: []`. A series can have no canonical
 *   runtime, so `runtimeMinutes` is `null` — not `0`, which would render as
 *   "0 min".
 * - *Severance* lists a Season 3 with `episode_count: 0` and `air_date: null`,
 *   announced but unaired. `seasons` omits empty seasons, because a season
 *   selector that opens onto nothing is the same defect as an empty rail.
 */
import type { ArtworkQuery } from "./artwork";
import { normalizeQuery, resolveTmdbRef } from "./artwork";
import { resolveKeylessDetail, type KeylessDetail } from "./keyless-detail";
import {
  detailRowKey,
  detailStore,
  seasonRowKey,
  type RowMeta,
  type StoredRow,
} from "./detail-store";
import {
  fetchTmdbDetail,
  fetchTmdbSeason,
  backdropUrl,
  isUsableTmdbKey,
  posterUrl,
  profileUrl,
  stillUrl,
  type TmdbCredit,
  type TmdbFullDetail,
} from "./tmdb";

// ---------------------------------------------------------------------------
// Public contract — the title page is written against this exact shape.
// ---------------------------------------------------------------------------

export interface CastMember {
  name: string;
  /** The role, not the actor. Null when TMDB has no character for the credit. */
  character: string | null;
  profileUrl: string | null;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  /** ISO `yyyy-mm-dd`, or null for an announced season with no date. */
  airDate: string | null;
  posterUrl: string | null;
}

export interface EpisodeDetail {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
  /** 16:9 still. Null far more often than posters are — treat it as optional. */
  stillUrl: string | null;
  runtimeMinutes: number | null;
  airDate: string | null;
  rating: number | null;
}

export interface WorkDetail {
  /**
   * Who answered. TMDB when a usable key resolved the work, otherwise the
   * keyless provider that could vouch for it — see `keyless-detail.ts`.
   */
  source: "tmdb" | "anilist" | "tvmaze" | "itunes";
  /** Null on a keyless answer: there is no TMDB handle to record. */
  tmdbId: number | null;
  mediaType: "movie" | "tv";
  title: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
  tagline: string | null;
  /** TMDB's 0–10 mean. Null when nobody has voted. */
  rating: number | null;
  voteCount: number;
  /** Films: the feature runtime. Series: the typical episode runtime, if any. */
  runtimeMinutes: number | null;
  genres: string[];
  /** ISO `yyyy-mm-dd`: theatrical release, or series premiere. */
  releaseDate: string | null;
  /** Age rating such as `PG-13`, `15`, `TV-MA`. Region-resolved, see below. */
  certification: string | null;
  /** TMDB production status, e.g. `Released`, `Returning Series`, `Ended`. */
  status: string | null;
  cast: CastMember[];
  /** Films. Empty for series. */
  directors: string[];
  /** Series. Empty for films. */
  creators: string[];
  /** Series, empty seasons removed. Empty for films. */
  seasons: SeasonSummary[];
  episodeCount: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A detail payload is ~50x an artwork pair, so this cache is much smaller. */
const MAX_DETAIL_ENTRIES = 200;
/** Seasons are listed per series and there are few of them. */
const MAX_SEASON_ENTRIES = 400;
/** Detail changes slowly — a rating drifts, a cast list does not. */
const POSITIVE_TTL_MS = 1000 * 60 * 60 * 12;
/** A miss is often a rate limit. Do not turn a blip into half a day of blanks. */
const NEGATIVE_TTL_MS = 1000 * 60 * 15;
const DEFAULT_TIMEOUT_MS = 5000;
const BATCH_CONCURRENCY = 4;
/** Enough faces for two rows on a wide title page. */
const MAX_CAST = 18;
/**
 * How long a *stale* row served from the database is trusted in memory.
 *
 * Deliberately short. Stale-while-revalidate hands the caller last week's
 * synopsis instantly and refreshes behind them, but if that refresh fails the
 * stale value must not then be pinned in memory for the full positive TTL —
 * that would turn one bad network moment into twelve hours of stale detail.
 */
const STALE_MEMORY_TTL_MS = 1000 * 60;

/**
 * Certification region order.
 *
 * TMDB returns every country's rating, and a title page must show one. US
 * first because it is the most consistently populated, then GB. Falling back
 * to "whatever came first" would show a Brazilian rating to a UK user, so the
 * last resort is explicit rather than accidental.
 */
const CERT_REGIONS = ["US", "GB"];

function timeoutMs(): number {
  const raw = Number(process.env.ARTWORK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Entry<T> {
  expires: number;
  value: T;
}

const detailCache = new Map<string, Entry<WorkDetail | null>>();
const detailInFlight = new Map<string, Promise<WorkDetail | null>>();
const seasonCache = new Map<string, Entry<EpisodeDetail[]>>();
const seasonInFlight = new Map<string, Promise<EpisodeDetail[]>>();

function read<T>(store: Map<string, Entry<T>>, key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function write<T>(
  store: Map<string, Entry<T>>,
  key: string,
  value: T,
  found: boolean,
  max: number,
): void {
  store.set(key, {
    expires: Date.now() + (found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    value,
  });
  while (store.size > max) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Test-only. */
export function resetWorkDetailCache(): void {
  detailCache.clear();
  detailInFlight.clear();
  seasonCache.clear();
  seasonInFlight.clear();
  revalidating.clear();
}

// ---------------------------------------------------------------------------
// Tiered resolution: memory -> database -> TMDB
// ---------------------------------------------------------------------------

/**
 * De-duplicates background revalidations. Without this, ten cards sharing one
 * stale series would each fire their own refresh the moment they rendered.
 */
const revalidating = new Set<string>();

/** A second-tier read must never be the reason a page fails. */
async function readPersisted(key: string): Promise<StoredRow | null> {
  try {
    return await detailStore().read(key);
  } catch {
    return null;
  }
}

interface Tier<T> {
  key: string;
  memory: Map<string, Entry<T>>;
  inFlight: Map<string, Promise<T>>;
  max: number;
  meta: RowMeta;
  /** Value representing "asked, nothing found". */
  empty: T;
  isFound: (value: T) => boolean;
  /** Returns `undefined` when the persisted payload is not the shape we want. */
  decode: (payload: unknown) => T | undefined;
  fetch: () => Promise<T>;
}

/**
 * The whole point of this module's second tier.
 *
 * Order is memory, then database, then TMDB, and a database row that has aged
 * out is *served* rather than discarded while a refresh runs behind it. On a
 * self-hosted box that restarts constantly, showing last week's synopsis in
 * about a millisecond beats showing nothing for as long as a network call
 * takes. Nothing here awaits the refresh and nothing here throws.
 */
async function tiered<T>(spec: Tier<T>): Promise<T> {
  const memory = read(spec.memory, spec.key);
  if (memory !== undefined) return memory;

  const pending = spec.inFlight.get(spec.key);
  if (pending) return await pending;

  const run = (async (): Promise<T> => {
    const row = await readPersisted(spec.key);
    if (row) {
      const value = row.found ? spec.decode(row.payload) : spec.empty;
      if (value !== undefined) {
        const ttl = row.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
        const fresh = Date.now() - row.fetchedAt < ttl;
        if (fresh) {
          write(spec.memory, spec.key, value, row.found, spec.max);
          return value;
        }
        spec.memory.set(spec.key, {
          expires: Date.now() + STALE_MEMORY_TTL_MS,
          value,
        });
        revalidate(spec);
        return value;
      }
    }
    return await refresh(spec);
  })();

  spec.inFlight.set(spec.key, run);
  try {
    return await run;
  } finally {
    spec.inFlight.delete(spec.key);
  }
}

/** Fetch from TMDB and write through both tiers. */
async function refresh<T>(spec: Tier<T>): Promise<T> {
  const value = await spec.fetch();
  const found = spec.isFound(value);
  write(spec.memory, spec.key, value, found, spec.max);

  // Persist only when TMDB could actually be asked. With a placeholder key
  // `fetch` returns empty instantly without a request, and writing that would
  // fill the database with fabricated misses that outlive the misconfiguration.
  if (isUsableTmdbKey(process.env.TMDB_API_KEY)) {
    void detailStore()
      .write(spec.key, spec.meta, found ? value : null)
      .catch(() => undefined);
  }
  return value;
}

/** Fire-and-forget refresh. Never awaited by a caller, never throws. */
function revalidate<T>(spec: Tier<T>): void {
  if (revalidating.has(spec.key)) return;
  revalidating.add(spec.key);
  void (async () => {
    try {
      await refresh(spec);
    } catch {
      // A failed revalidation just means the stale value stands.
    } finally {
      revalidating.delete(spec.key);
    }
  })();
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/** Hard ceiling around work that is allowed to fail. Mirrors `artwork.ts`. */
async function guarded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  const budget = timeoutMs();
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), budget);
    try {
      work().then(
        (value) => finish(value),
        () => finish(fallback),
      );
    } catch {
      finish(fallback);
    }
  });
}

/** Order-preserving map with a hard ceiling on parallelism. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  fallback: R,
): Promise<R[]> {
  const out = new Array<R>(items.length).fill(fallback);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index]);
      } catch {
        out[index] = fallback;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * A film's certification lives under `release_dates`, a series' under
 * `content_ratings`, and both carry empty strings for regions that have a
 * release but no rating — so "first entry" is not good enough.
 */
function certificationOf(d: TmdbFullDetail): string | null {
  const movie = d.release_dates?.results ?? [];
  const tv = d.content_ratings?.results ?? [];

  const fromRegion = (region: string): string | null => {
    const m = movie.find((r) => r.iso_3166_1 === region);
    const cert = m?.release_dates?.find((x) => x.certification?.trim())
      ?.certification;
    if (cert?.trim()) return cert.trim();
    const t = tv.find((r) => r.iso_3166_1 === region);
    return t?.rating?.trim() ? t.rating.trim() : null;
  };

  for (const region of CERT_REGIONS) {
    const found = fromRegion(region);
    if (found) return found;
  }
  return null;
}

function castOf(credits: TmdbCredit[] | undefined): CastMember[] {
  return (credits ?? [])
    .slice(0, MAX_CAST)
    .filter((c) => typeof c.name === "string" && c.name.trim())
    .map((c) => ({
      name: (c.name as string).trim(),
      character: c.character?.trim() ? c.character.trim() : null,
      profileUrl: profileUrl(c.profile_path),
    }));
}

function jobHolders(credits: TmdbCredit[] | undefined, job: string): string[] {
  const names = (credits ?? [])
    .filter((c) => c.job === job && c.name?.trim())
    .map((c) => (c.name as string).trim());
  return Array.from(new Set(names));
}

/**
 * Series runtime.
 *
 * `episode_run_time` is an array and is frequently empty — *Severance* returns
 * `[]` from the live API. Returning 0 there would print "0 min" on the page, so
 * an absent runtime stays absent.
 */
function runtimeOf(d: TmdbFullDetail, mediaType: "movie" | "tv"): number | null {
  if (mediaType === "movie") {
    return typeof d.runtime === "number" && d.runtime > 0 ? d.runtime : null;
  }
  const first = (d.episode_run_time ?? []).find((n) => typeof n === "number" && n > 0);
  return first ?? null;
}

function seasonsOf(d: TmdbFullDetail): SeasonSummary[] {
  return (d.seasons ?? [])
    .filter((s) => (s.episode_count ?? 0) > 0)
    .map((s) => ({
      seasonNumber: s.season_number ?? 0,
      name: s.name?.trim() || `Season ${s.season_number ?? 0}`,
      episodeCount: s.episode_count ?? 0,
      airDate: s.air_date ?? null,
      posterUrl: posterUrl(s.poster_path),
    }))
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function toWorkDetail(
  d: TmdbFullDetail,
  mediaType: "movie" | "tv",
): WorkDetail | null {
  const title = (d.title || d.name || "").trim();
  if (!title) return null;

  const releaseDate = d.release_date || d.first_air_date || null;
  const rating =
    typeof d.vote_average === "number" && d.vote_average > 0
      ? d.vote_average
      : null;

  return {
    source: "tmdb",
    tmdbId: d.id,
    mediaType,
    title,
    year: yearOf(releaseDate),
    posterUrl: posterUrl(d.poster_path),
    backdropUrl: backdropUrl(d.backdrop_path),
    overview: d.overview?.trim() ? d.overview.trim() : null,
    tagline: d.tagline?.trim() ? d.tagline.trim() : null,
    rating,
    voteCount: typeof d.vote_count === "number" ? d.vote_count : 0,
    runtimeMinutes: runtimeOf(d, mediaType),
    genres: (d.genres ?? [])
      .map((g) => g.name)
      .filter((n): n is string => Boolean(n)),
    releaseDate,
    certification: certificationOf(d),
    status: d.status?.trim() ? d.status.trim() : null,
    cast: castOf(d.credits?.cast),
    directors: mediaType === "movie" ? jobHolders(d.credits?.crew, "Director") : [],
    creators:
      mediaType === "tv"
        ? Array.from(
            new Set(
              (d.created_by ?? [])
                .map((c) => c.name?.trim())
                .filter((n): n is string => Boolean(n)),
            ),
          )
        : [],
    seasons: mediaType === "tv" ? seasonsOf(d) : [],
    episodeCount:
      typeof d.number_of_episodes === "number" ? d.number_of_episodes : 0,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function detailKey(ref: { id: number; mediaType: string }): string {
  return `${ref.mediaType}:${ref.id}`;
}

/**
 * Full detail for one title, or null when nothing can vouch for a match.
 *
 * Precedence is fixed and one-directional: **TMDB when a usable key resolved
 * the work**, otherwise a keyless provider. A fallback is only ever consulted
 * when TMDB produced nothing at all, so it can never overwrite, dilute or
 * race a TMDB answer — the failure this module is least allowed to have is a
 * page that mixes two works' facts.
 *
 * Never throws and never hangs.
 */
export async function resolveWorkDetail(
  q: ArtworkQuery,
): Promise<WorkDetail | null> {
  try {
    const ref = await resolveTmdbRef(q);
    if (ref) {
      const detail = await detailForRef(ref);
      if (detail) return detail;
    }
    return await keylessDetail(q);
  } catch {
    return null;
  }
}

/**
 * The keyless tier: same caching, timeout and de-duplication as the TMDB one.
 *
 * Not persisted to `detailStore`. That table's rows are keyed by TMDB id and
 * its misses are written only when TMDB could actually be asked; a keyless
 * answer belongs to neither, and writing one would make a keyless install's
 * database look like a TMDB-enriched one.
 */
async function keylessDetail(q: ArtworkQuery): Promise<WorkDetail | null> {
  const query = normalizeQuery(q);
  if (!query) return null;

  const key = `keyless:${query.mediaType ?? "any"}:${query.title.toLowerCase()}:${query.year ?? "-"}`;

  const cached = read(detailCache, key);
  if (cached !== undefined) return cached;

  const pending = detailInFlight.get(key);
  if (pending) return await pending;

  const run = (async () => {
    const resolved = await guarded(() => resolveKeylessDetail(query), null);
    const value = resolved ? fromKeyless(resolved) : null;
    write(detailCache, key, value, value != null, MAX_DETAIL_ENTRIES);
    return value;
  })();

  detailInFlight.set(key, run);
  try {
    return await run;
  } finally {
    detailInFlight.delete(key);
  }
}

/**
 * A keyless answer in the shape the title page already reads.
 *
 * Everything these providers do not publish stays empty rather than being
 * approximated: no cast, no crew, no certification, no tagline, and a
 * `voteCount` of 0 that the hero already treats as "no votes to show".
 */
function fromKeyless(detail: KeylessDetail): WorkDetail {
  return {
    source: detail.source,
    tmdbId: null,
    mediaType: detail.mediaType,
    title: detail.title,
    year: detail.year ?? yearOf(detail.releaseDate),
    posterUrl: detail.posterUrl,
    backdropUrl: detail.backdropUrl,
    overview: detail.overview,
    tagline: null,
    rating: detail.rating,
    voteCount: 0,
    runtimeMinutes: detail.runtimeMinutes,
    genres: detail.genres,
    releaseDate: detail.releaseDate,
    certification: null,
    status: null,
    cast: [],
    directors: [],
    creators: [],
    seasons: [],
    episodeCount: detail.episodeCount,
  };
}

/** Detail for an already-known TMDB id. Cached and de-duplicated. */
export async function detailForRef(ref: {
  id: number;
  mediaType: "movie" | "tv";
}): Promise<WorkDetail | null> {
  const key = detailKey(ref);

  const cached = read(detailCache, key);
  if (cached !== undefined) return cached;

  const pending = detailInFlight.get(key);
  if (pending) return await pending;

  const run = (async () => {
    const raw = await guarded(
      () => fetchTmdbDetail(ref.mediaType, ref.id, { timeoutMs: timeoutMs() }),
      null,
    );
    const value = raw ? toWorkDetail(raw, ref.mediaType) : null;
    write(detailCache, key, value, value != null, MAX_DETAIL_ENTRIES);
    return value;
  })();

  detailInFlight.set(key, run);
  try {
    return await run;
  } finally {
    detailInFlight.delete(key);
  }
}

/**
 * Order-preserving batch. `result[i]` belongs to `queries[i]`.
 *
 * Concurrency is lower than artwork's because each item here is two requests
 * rather than one and the payloads are far larger. Never throws.
 */
export async function resolveWorkDetailBatch(
  queries: ArtworkQuery[],
): Promise<(WorkDetail | null)[]> {
  if (!Array.isArray(queries) || queries.length === 0) return [];
  return mapBounded(
    queries,
    BATCH_CONCURRENCY,
    (q) => resolveWorkDetail(q),
    null,
  );
}

/**
 * Episodes of one season, in episode order. Empty array when unavailable —
 * a season list that fails to load must render as "no episodes", not a crash.
 */
export async function resolveSeasonEpisodes(
  q: ArtworkQuery,
  seasonNumber: number,
): Promise<EpisodeDetail[]> {
  try {
    const ref = await resolveTmdbRef(q);
    if (!ref || ref.mediaType !== "tv") return [];
    return await seasonForRef(ref.id, seasonNumber);
  } catch {
    return [];
  }
}

/** Episodes for an already-known series id. Cached and de-duplicated. */
export async function seasonForRef(
  id: number,
  seasonNumber: number,
): Promise<EpisodeDetail[]> {
  if (!Number.isFinite(seasonNumber) || seasonNumber < 0) return [];
  const key = `tv:${id}:s${seasonNumber}`;

  const cached = read(seasonCache, key);
  if (cached !== undefined) return cached;

  const pending = seasonInFlight.get(key);
  if (pending) return await pending;

  const run = (async () => {
    const raw = await guarded(
      () => fetchTmdbSeason(id, seasonNumber, { timeoutMs: timeoutMs() }),
      null,
    );
    const episodes = (raw?.episodes ?? [])
      .filter((e) => typeof e.episode_number === "number")
      .map((e) => ({
        seasonNumber: e.season_number ?? seasonNumber,
        episodeNumber: e.episode_number as number,
        title: e.name?.trim() || `Episode ${e.episode_number}`,
        overview: e.overview?.trim() ? e.overview.trim() : null,
        stillUrl: stillUrl(e.still_path),
        runtimeMinutes:
          typeof e.runtime === "number" && e.runtime > 0 ? e.runtime : null,
        airDate: e.air_date ?? null,
        rating:
          typeof e.vote_average === "number" && e.vote_average > 0
            ? e.vote_average
            : null,
      }))
      .sort((a, b) => a.episodeNumber - b.episodeNumber);

    write(
      seasonCache,
      key,
      episodes,
      episodes.length > 0,
      MAX_SEASON_ENTRIES,
    );
    return episodes;
  })();

  seasonInFlight.set(key, run);
  try {
    return await run;
  } finally {
    seasonInFlight.delete(key);
  }
}
