/**
 * When the catalog is fetched, and — much more importantly — when it is *not*.
 *
 * The rule, from the plan's own risk table: **rails make the app feel slow if
 * each tile resolves a torrent. Never resolve on render. Availability is a
 * cache refreshed in the background; tiles read it, they don't compute it.**
 * The same reasoning applies to the catalog itself. A handful of HTTP requests
 * and a few dozen upserts is not much, but paying for it on every page load is
 * the difference between a home page that appears and a home page that loads.
 *
 * So:
 *
 *  - **Warm read → serve the cache, refresh behind it.** Stale-while-
 *    revalidate. The page is rendered from rows that already exist; a stale
 *    cache kicks off a background refresh nobody waits for.
 *  - **Cold read → block, briefly.** A brand-new install has nothing cached,
 *    and "come back in a minute and it will be full" is precisely the empty
 *    first impression this whole feature exists to remove. So the very first
 *    read waits — but only up to {@link COLD_START_BUDGET_MS}, after which the
 *    page renders with whatever landed and the refresh finishes on its own.
 *  - **Timer.** Once a process has served one browse read it refreshes on an
 *    interval regardless of traffic, so an idle tab reloaded tomorrow is not
 *    reading yesterday's chart.
 *
 * ## Two sources, two jobs
 *
 * TMDB is the **catalog**: what exists, what is popular this week, and the
 * poster, synopsis and rating for it. The apibay charts are the
 * **availability overlay**: whether a chart release of that title exists and
 * how healthy its swarm is. Neither can do the other's job, and the code is
 * arranged so neither pretends to — see `./tmdb.ts` and `./availability.ts`.
 *
 * If TMDB is unreachable the charts still build a catalog on their own, the
 * old way, by collapsing release names into works. It is a visibly poorer page
 * — no synopses, artwork resolved title-by-title, names that are only as good
 * as a release string — but it is a *full* page, which is the entire point.
 *
 * Every path here is failure-tolerant by construction: `fetchFeed` and the
 * TMDB client never throw, artwork degrades to null, and `refreshCatalog`
 * returns its errors rather than raising them. A dead network leaves the cache
 * exactly as it was.
 */
import { CATALOG_FEEDS, fetchAllFeeds, type CatalogSource, type FeedResult } from "./feeds";
import { resolveArtworkBounded, type ArtworkQuery } from "./artwork";
import {
  buildAvailabilityIndex,
  catalogWorkKey,
  emptyAvailabilityIndex,
  matchAvailability,
  type AvailabilityIndex,
} from "./availability";
import {
  fetchTmdbRecommendations,
  fetchTmdbTrending,
  hasTmdbKey,
  searchTmdb,
  type TmdbKind,
  type TmdbTitle,
} from "./tmdb";
import {
  draftFromRow,
  draftFromTmdb,
  draftsFromWorks,
  dropRelatedSeeds,
  readCatalogRows,
  readCatalogStatus,
  readRelatedSeeds,
  replaceCatalogSource,
  type CatalogRow,
  type CatalogRowDraft,
  type CatalogWorkWithArt,
} from "./store";
import { collapseToWorks, pickRelated, seedWorkKeys, type CatalogWork, type TypedRelease } from "./works";
import { isSeriesMediaType, normalizeMediaType, type MediaType } from "@/lib/metadata/media-type";

/**
 * How long a cached catalog stays fresh, and how often the timer fires.
 *
 * A top-100 chart moves over hours, not seconds. An hour is short enough that
 * "Trending now" is true and long enough that a busy evening costs one fetch.
 */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

/**
 * The longest a *first ever* page load will wait for a catalog.
 *
 * Only ever paid once per install, and only when there is nothing at all to
 * show instead. Three feeds in parallel measured ~1.6s from this machine
 * behind a corporate proxy; the budget is generous against that so a slow
 * network still fills the page rather than half-filling it.
 */
export const COLD_START_BUDGET_MS = 12_000;

/**
 * How many works are kept per source.
 *
 * Deliberately deeper than a rail renders ({@link RAIL_HEAD}). "Because you're
 * watching…" falls back to this same cache when TMDB cannot be reached, so if
 * the cache were only as deep as one rail that row could only ever be the row
 * beneath it, rearranged.
 */
export const WORKS_PER_SOURCE = 48;

/**
 * How many of each source a discovery rail actually puts on screen.
 *
 * Mirrors `DISCOVERY_RAIL_SIZE` in `src/lib/browse/discovery.ts`. It lives here
 * rather than being imported from there because the catalog layer must not
 * depend on the browse layer; the two are asserted equal in the unit tests.
 */
export const RAIL_HEAD = 24;

/**
 * TMDB pages to read per chart.
 *
 * One page is twenty titles, a rail shows {@link RAIL_HEAD}, and the related
 * row's fallback needs a pool deeper than the rail. Two pages clears both.
 */
const TMDB_PAGES = 2;

/** Which TMDB chart fills which rail. */
const TMDB_SOURCES: ReadonlyArray<{ kind: TmdbKind; source: CatalogSource }> = [
  { kind: "movie", source: "trending" },
  { kind: "tv", source: "popular" },
] as const;

/** What one refresh did. Returned, never thrown. */
export interface CatalogRefreshResult {
  /** Rows written per source. */
  written: Record<string, number>;
  /** One entry per source that failed. Empty when everything answered. */
  errors: string[];
  /** True when no source answered at all — the "we reached nothing" case. */
  offline: boolean;
  /** Which layer produced the catalog, per source. For logs and QA. */
  origin: Record<string, "tmdb" | "charts">;
  /** How many catalog titles the charts could put a seeder count against. */
  availabilityHits: number;
  tookMs: number;
}

let inFlight: Promise<CatalogRefreshResult> | null = null;
const relatedInFlight = new Map<string, Promise<number>>();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Fetch every source, build the catalog, write it.
 *
 * Single-flight: concurrent callers share one refresh. Without this, the first
 * page load of a cold install would start one refresh per rail per request.
 */
export function refreshCatalog(): Promise<CatalogRefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runRefresh(): Promise<CatalogRefreshResult> {
  const started = Date.now();
  const written: Record<string, number> = {};
  const origin: Record<string, "tmdb" | "charts"> = {};
  const errors: string[] = [];

  // Both networks at once. They answer different questions and neither is a
  // precondition for the other, so a slow chart must not delay the catalog.
  const [charts, tmdb] = await Promise.all([
    safeFeeds(),
    safeTrending(),
  ]);

  for (const result of charts) {
    if (result.error) errors.push(`${result.feed.label}: ${result.error}`);
  }
  for (const { kind, error } of tmdb) {
    if (error) errors.push(`TMDB ${kind}: ${error}`);
  }

  const answered = charts.filter((r) => r.error === null && r.releases.length > 0);
  const index = answered.length > 0
    ? buildAvailabilityIndex(collapseToWorks(typedReleases(answered)))
    : emptyAvailabilityIndex();

  let availabilityHits = 0;

  // TMDB first: it is the source that produces a page worth looking at.
  const prepared: Array<{ source: CatalogSource; drafts: CatalogRowDraft[] }> = [];

  for (const { source, titles } of tmdb) {
    if (titles.length === 0) continue;
    const drafts = titles.slice(0, WORKS_PER_SOURCE).map((title) => {
      const workKey = catalogWorkKey(title.title, title.year, title.mediaType);
      const signal = matchAvailability(index, workKey, title.year);
      if (signal) availabilityHits += 1;
      return draftFromTmdb(title, workKey, signal);
    });
    prepared.push({ source, drafts });
    origin[source] = "tmdb";
  }

  // Anything TMDB could not fill, the charts fill the old way. A page built
  // out of release names is worse than one built out of a catalog; it is far
  // better than an empty one, which is the failure this feature exists to fix.
  const missing = [...new Set(CATALOG_FEEDS.map((f) => f.source))].filter(
    (source) => !prepared.some((p) => p.source === source),
  );

  const fallbacks = await Promise.all(
    missing.map(async (source) => {
      const items = typedReleases(answered.filter((r) => r.feed.source === source));
      if (items.length === 0) return null;
      const works = collapseToWorks(items).slice(0, WORKS_PER_SOURCE);
      // Only this path needs an artwork lookup: TMDB rows already carry their
      // own posters, and looking them up again would be a second network call
      // for something already in hand.
      const withArt = await attachArtwork(works);
      return { source, drafts: await draftsFromWorks(withArt) };
    }),
  );

  for (const fallback of fallbacks) {
    if (!fallback) continue;
    prepared.push(fallback);
    origin[fallback.source] = "charts";
  }

  if (prepared.length === 0) {
    // Nothing reachable. Leave the cache exactly as it was — an outage must
    // never be able to empty a catalog that was fine a minute ago.
    return {
      written,
      errors,
      offline: true,
      origin,
      availabilityHits: 0,
      tookMs: Date.now() - started,
    };
  }

  // Writes stay sequential: SQLite takes one writer at a time, and overlapping
  // them buys nothing and risks a busy timeout.
  for (const entry of prepared) {
    await replaceCatalogSource(entry.source, null, entry.drafts);
    written[entry.source] = entry.drafts.length;
  }

  // "Because you're watching…" rows are *not* rebuilt here. They are keyed to
  // the user's seed, which only the read path knows because it is the one that
  // reads the user's library. `discovery.ts` notices that a related partition
  // predates this refresh and rebuilds it with the seed in hand.
  return {
    written,
    errors,
    offline: false,
    origin,
    availabilityHits,
    tookMs: Date.now() - started,
  };
}

/** Every chart release, tagged with the media type its feed asserts. */
function typedReleases(results: readonly FeedResult[]): TypedRelease[] {
  return results.flatMap((r) =>
    r.releases.map((release) => ({ release, mediaType: r.feed.mediaType })),
  );
}

/** `fetchAllFeeds` is written not to throw; if it ever does, that is not fatal. */
async function safeFeeds(): Promise<FeedResult[]> {
  try {
    return await fetchAllFeeds();
  } catch (err) {
    console.error("[catalog] feed layer threw", err);
    return [];
  }
}

interface TrendingResult {
  kind: TmdbKind;
  source: CatalogSource;
  titles: TmdbTitle[];
  error: string | null;
}

/** Both TMDB charts, concurrently. Never throws; a missing key is not an error worth logging twice. */
async function safeTrending(): Promise<TrendingResult[]> {
  if (!hasTmdbKey()) {
    return TMDB_SOURCES.map(({ kind, source }) => ({
      kind,
      source,
      titles: [],
      error: "TMDB_API_KEY is not set",
    }));
  }

  return Promise.all(
    TMDB_SOURCES.map(async ({ kind, source }) => {
      try {
        const { titles, error } = await fetchTmdbTrending(kind, TMDB_PAGES);
        return { kind, source, titles, error };
      } catch (err) {
        return {
          kind,
          source,
          titles: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** Attach artwork to a ranked list, preserving order. Never throws. */
async function attachArtwork(
  works: readonly CatalogWork[],
): Promise<CatalogWorkWithArt[]> {
  const queries: ArtworkQuery[] = works.map((work) => ({
    title: work.title,
    year: work.year,
    // The artwork provider's own vocabulary is `movie | tv | anime | null`,
    // which is `MediaType | null` — normalised here rather than passed
    // through, so a value that this module cannot vouch for arrives as null
    // instead of as a wrong lookup.
    mediaType: normalizeMediaType(work.mediaType),
  }));

  const art = await resolveArtworkBounded(queries);
  return works.map((work, i) => ({
    ...work,
    posterUrl: art[i]?.posterUrl ?? null,
    backdropUrl: art[i]?.backdropUrl ?? null,
  }));
}

/**
 * Rebuild the "Because you're watching X" partition for one seed.
 *
 * The seed comes from the user's own playback rows, so there genuinely is an X
 * — this is never called to invent one. Two ways to answer it, in order:
 *
 *  1. **TMDB's own recommendations.** A bespoke recommender is an explicit
 *     non-goal in the plan, and TMDB already has one that is far better than
 *     anything that could honestly be hand-rolled here: it knows House of the
 *     Dragon goes with The Witcher, which no amount of chart arithmetic does.
 *  2. **The cache.** When TMDB is unreachable, other popular works of the same
 *     kind, adjacent in popularity — which is exactly what the row's heading
 *     claims and nothing more.
 *
 * Bounded, because this runs from a read path: past {@link RELATED_BUDGET_MS}
 * the cheap answer is used instead. A slightly less well chosen row beats a
 * home page that hangs waiting for a third party.
 *
 * Partitions for *other* seeds are dropped in the same pass. TorrentFlow is
 * single-user by design (`src/lib/auth.ts` returns one fixed session), exactly
 * one such row is ever rendered, and rows for a seed nobody is watching any
 * more are cache that can only go stale.
 */
export async function refreshRelatedForSeed(seed: {
  title: string;
  mediaType: MediaType | null;
}): Promise<number> {
  const title = seed.title.trim();
  if (!title) return 0;

  const key = `${title}\u0000${seed.mediaType ?? ""}`;
  const existing = relatedInFlight.get(key);
  if (existing) return existing;

  const work = runRefreshRelatedForSeed({ title, mediaType: seed.mediaType }).finally(() => {
    if (relatedInFlight.get(key) === work) relatedInFlight.delete(key);
  });
  relatedInFlight.set(key, work);
  return work;
}

async function runRefreshRelatedForSeed(seed: {
  title: string;
  mediaType: MediaType | null;
}): Promise<number> {
  const title = seed.title;

  const trending = await readCatalogRows("trending", null, WORKS_PER_SOURCE);
  const popular = await readCatalogRows("popular", null, WORKS_PER_SOURCE);
  const pool: CatalogRow[] = [...trending, ...popular];

  // What the discovery rails already put on screen. A "Because you're
  // watching…" row that repeats the row directly beneath it reads as broken,
  // so these are pushed to the back and used only to top the row up once
  // genuinely unseen candidates run out.
  const onScreen = new Set<string>([
    ...trending.slice(0, RAIL_HEAD).map((row) => row.workKey),
    ...popular.slice(0, RAIL_HEAD).map((row) => row.workKey),
  ]);

  let drafts =
    (await withBudget(
      relatedFromTmdb(seed, title, pool, onScreen),
      RELATED_BUDGET_MS,
    )) ?? null;

  if (!drafts || drafts.length === 0) {
    if (pool.length === 0) return 0;
    drafts = pickRelated(pool, title, seed.mediaType, RAIL_HEAD, onScreen).map(
      draftFromRow,
    );
  }

  await replaceCatalogSource("related", title, drafts);

  const stale = (await readRelatedSeeds()).filter((s) => s !== title);
  await dropRelatedSeeds(stale);

  return drafts.length;
}

/** The longest a browse read will wait for TMDB to choose a related row. */
export const RELATED_BUDGET_MS = 4_000;

/**
 * TMDB's recommendations for the seed, as catalog drafts. Null when TMDB
 * could not answer — which is a fallback, not a failure.
 */
async function relatedFromTmdb(
  seed: { mediaType: MediaType | null },
  title: string,
  pool: readonly CatalogRow[],
  onScreen: ReadonlySet<string>,
): Promise<CatalogRowDraft[] | null> {
  if (!hasTmdbKey()) return null;

  // A seed whose type is unknown is looked up as both; whichever TMDB
  // recognises is the answer, and neither is guessed at.
  const kinds: TmdbKind[] =
    seed.mediaType === null
      ? ["movie", "tv"]
      : [isSeriesMediaType(seed.mediaType) ? "tv" : "movie"];

  let found;
  try {
    const searches = await Promise.all(kinds.map((kind) => searchTmdb(kind, title)));
    found = searches.map((s) => s.title).find((t) => t !== null) ?? null;
  } catch (err) {
    console.error("[catalog] TMDB seed lookup failed", err);
    return null;
  }
  if (!found) return null;

  let titles;
  try {
    titles = (await fetchTmdbRecommendations(found.kind, found.tmdbId)).titles;
  } catch (err) {
    console.error("[catalog] TMDB recommendations failed", err);
    return null;
  }
  if (titles.length === 0) return null;

  // Seeder counts are copied from rows this refresh already cross-referenced
  // against the charts. Nothing new is claimed: a hit means the *same work
  // key* is already stored with that number, and a miss stays 0/null rather
  // than borrowing a number from a title that merely looks similar.
  const known = new Map(pool.map((row) => [row.workKey, row]));
  const seedKeys = seedWorkKeys(title);
  const seedTitle = title.toLowerCase();

  const drafts: CatalogRowDraft[] = [];
  for (const candidate of titles) {
    const workKey = catalogWorkKey(candidate.title, candidate.year, candidate.mediaType);
    if (!workKey) continue;
    // Never suggest the thing being watched. Checked two ways because the
    // seed is free text from a local file name and may not key identically.
    if (seedKeys.has(workKey)) continue;
    if (candidate.title.trim().toLowerCase() === seedTitle) continue;

    const row = known.get(workKey);
    const signal =
      row && row.bestRelease
        ? { peakSeeders: row.seeders, bestRelease: row.bestRelease }
        : null;
    drafts.push(draftFromTmdb(candidate, workKey, signal));
  }

  // Stable partition rather than a sort: TMDB's own ordering is the
  // recommendation, so it is preserved within each group and only the
  // already-on-screen titles are moved to the back.
  const unseen = drafts.filter((d) => !onScreen.has(d.workKey));
  const seen = drafts.filter((d) => onScreen.has(d.workKey));
  return [...unseen, ...seen].slice(0, RAIL_HEAD);
}

/** Is a cache written at `refreshedAt` still worth serving without a refetch? */
export function isStale(refreshedAt: Date | null, now: number = Date.now()): boolean {
  if (!refreshedAt) return true;
  return now - refreshedAt.getTime() > CATALOG_TTL_MS;
}

/**
 * Make sure there is *something* to render, then get out of the way.
 *
 * Returns the status the caller should treat as authoritative. Never throws:
 * a database that cannot be read is reported as an empty cache, and the rails
 * above degrade to no discovery rows rather than to a broken page.
 */
export async function ensureCatalogFresh(): Promise<{
  entryCount: number;
  refreshedAt: Date | null;
  /** True when this call waited for a network round trip. */
  blocked: boolean;
}> {
  armCatalogTimer();

  let status;
  try {
    status = await readCatalogStatus();
  } catch {
    return { entryCount: 0, refreshedAt: null, blocked: false };
  }

  if (status.entryCount === 0) {
    // Cold. Wait, but not indefinitely — the refresh keeps running either way.
    await withBudget(refreshCatalog(), COLD_START_BUDGET_MS);
    try {
      const after = await readCatalogStatus();
      return { ...after, blocked: true };
    } catch {
      return { entryCount: 0, refreshedAt: null, blocked: true };
    }
  }

  if (isStale(status.refreshedAt)) {
    // Warm but stale: serve now, refresh behind. Errors are already captured
    // in the result, so the only thing to guard is an unexpected rejection.
    void refreshCatalog().catch(() => undefined);
  }

  return { ...status, blocked: false };
}

/**
 * Refresh on an interval, independent of traffic.
 *
 * Armed lazily by the first read rather than at import time: a module that
 * starts a timer just for being imported would fire during unit tests, during
 * `next build`'s module evaluation, and in any script that touches the catalog
 * for one query. `unref` keeps it from holding a process open — a CLI script
 * that finishes must exit, not wait an hour.
 */
export function armCatalogTimer(): void {
  if (timer) return;
  if (process.env.CATALOG_TIMER === "0") return;

  const handle = setInterval(() => {
    void refreshCatalog().catch(() => undefined);
  }, CATALOG_TTL_MS);

  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    handle.unref();
  }
  timer = handle;
}

/** Stop the interval. For tests and scripts that must exit cleanly. */
export function stopCatalogTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Resolve when `promise` settles or when the budget expires, whichever is
 * first. The promise keeps running either way — this bounds the *wait*, not
 * the work.
 */
async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), budget]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
