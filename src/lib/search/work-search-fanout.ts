import { searchAniListWorks } from "@/lib/metadata/anilist";
import { searchTmdbByType } from "@/lib/metadata/tmdb";
import { searchItunes } from "@/lib/metadata/itunes";
import { searchTvmazeShows } from "@/lib/metadata/tvmaze";
import {
  interleaveByProviderRank,
  rankTitleHitsByRelevance,
} from "@/components/search/title-search";
import {
  canonicalizeSearchQuery,
  displaySearchQuery,
  searchDiscoveryVariants,
} from "@/lib/search/query-variants";
import {
  bestQueryRelevanceTier,
  hasRelevantTitle,
} from "@/lib/search/relevance";
import {
  workSearchHitFromKeylessCandidate,
  workSearchHitFromMetadata,
  type WorkSearchCategory,
  type WorkSearchHit,
  type WorkSearchScope,
} from "@/lib/search/work-search";

/**
 * Every attempted provider rejected. Distinct from "found nothing": an empty
 * 200 would make an outage indistinguishable from a genuine miss, so the route
 * turns this into a real error status instead.
 */
export class AllProvidersFailedError extends Error {
  /**
   * The provider/category names that actually rejected — never a placeholder.
   * Routes derive `failedProviders` from this, so an empty or invented list
   * would put an untruthful outage report in front of the user.
   */
  readonly failed: readonly string[];

  constructor(failed: readonly string[], cause?: unknown) {
    super("All title providers failed", { cause });
    this.name = "AllProvidersFailedError";
    this.failed = failed;
  }
}

export interface WorkSearchFanoutResult {
  results: WorkSearchHit[];
  /** The canonical string actually sent to every provider and to ranking. */
  query: string;
  /** The query as typed (whitespace-normalized), for echoing back. */
  displayQuery: string;
  attempted: WorkSearchCategory[];
  failed: WorkSearchCategory[];
  /** True when at least one provider failed but others still answered. */
  partial: boolean;
  /** True when a previous successful result was served during an outage. */
  stale?: boolean;
}

export type WorkSearchProviders = {
  [K in WorkSearchCategory]: (
    query: string,
    limit: number,
  ) => Promise<WorkSearchHit[]>;
};

export const defaultWorkSearchProviders: WorkSearchProviders = {
  movies: async (query, limit) =>
    withKeylessFallback(
      query,
      () => searchTmdbByType("movie", query, limit).then((items) =>
        hitsFrom(items, "movies")
      ),
      () => searchKeylessMovies(query, limit, Date.now() + 10_000),
    ),
  series: async (query, limit) =>
    withKeylessFallback(
      query,
      () => searchTmdbByType("tv", query, limit).then((items) =>
        hitsFrom(items, "series")
      ),
      () => searchKeylessSeries(query, limit, Date.now() + 10_000),
    ),
  anime: async (query, limit) => {
    const works = await searchAniListWorks(query, limit);
    const out: WorkSearchHit[] = [];
    for (const work of works) {
      const hit = workSearchHitFromMetadata(work.metadata, "anime", work.format);
      if (hit) out.push(hit);
    }
    return out;
  },
};

async function withKeylessFallback(
  query: string,
  primary: () => Promise<WorkSearchHit[]>,
  fallback: () => Promise<WorkSearchHit[]>,
): Promise<WorkSearchHit[]> {
  let primaryHits: WorkSearchHit[] = [];
  let primaryError: unknown = null;
  try {
    primaryHits = await primary();
  } catch (error) {
    primaryError = error;
  }
  if (hasRelevantWorkHit(query, primaryHits)) return primaryHits;

  const fallbackHits = await fallback();
  const merged = [...primaryHits, ...fallbackHits];
  if (primaryError && !hasRelevantWorkHit(query, merged)) throw primaryError;
  return merged;
}

async function searchKeylessMovies(
  query: string,
  limit: number,
  deadlineMs: number,
): Promise<WorkSearchHit[]> {
  const out: WorkSearchHit[] = [];
  for (const variant of searchDiscoveryVariants(query)) {
    const timeoutMs = keylessSearchTimeoutMs(deadlineMs);
    if (timeoutMs === 0) break;
    const candidates = await searchItunes(variant, {
      limit,
      timeoutMs,
    });
    for (const candidate of candidates) {
      const hit = workSearchHitFromKeylessCandidate(
        candidate,
        "movies",
        "itunes",
      );
      if (hit) out.push(hit);
    }
    if (hasRelevantWorkHit(query, out)) break;
  }
  return dedupeProviderHits(out);
}

async function searchKeylessSeries(
  query: string,
  limit: number,
  deadlineMs: number,
): Promise<WorkSearchHit[]> {
  const out: WorkSearchHit[] = [];
  for (const variant of searchDiscoveryVariants(query)) {
    const timeoutMs = keylessSearchTimeoutMs(deadlineMs);
    if (timeoutMs === 0) break;
    const candidates = await searchTvmazeShows(variant, {
      limit,
      timeoutMs,
    });
    for (const candidate of candidates) {
      const hit = workSearchHitFromKeylessCandidate(
        candidate,
        "series",
        "tvmaze",
      );
      if (hit) out.push(hit);
    }
    if (hasRelevantWorkHit(query, out)) break;
  }
  return dedupeProviderHits(out);
}

export function keylessSearchTimeoutMs(
  deadlineMs: number,
  nowMs = Date.now(),
): number {
  return Math.max(0, Math.min(4_000, deadlineMs - nowMs));
}

function hasRelevantWorkHit(
  query: string,
  hits: readonly WorkSearchHit[],
): boolean {
  return hits.some((hit) =>
    hasRelevantTitle(query, [hit.title, ...hit.aliases])
  );
}

function dedupeProviderHits(hits: readonly WorkSearchHit[]): WorkSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.provider}:${hit.providerId ?? hit.workKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hitsFrom(
  metadata: Awaited<ReturnType<typeof searchTmdbByType>>,
  category: WorkSearchCategory,
): WorkSearchHit[] {
  const out: WorkSearchHit[] = [];
  for (const item of metadata) {
    const hit = workSearchHitFromMetadata(item, category);
    if (hit) out.push(hit);
  }
  return out;
}

function categoriesForScope(scope: WorkSearchScope): WorkSearchCategory[] {
  return scope === "all" ? ["movies", "series", "anime"] : [scope];
}

const WORK_SEARCH_FRESH_MS = 5 * 60_000;
const WORK_SEARCH_STALE_MS = 24 * 60 * 60_000;
const WORK_SEARCH_CACHE_LIMIT = 100;

type CachedWorkSearch = {
  result: WorkSearchFanoutResult;
  freshUntil: number;
  staleUntil: number;
};

const successfulWorkSearches = new Map<string, CachedWorkSearch>();

function workSearchCacheKey(
  scope: WorkSearchScope,
  query: string,
  limit: number,
): string {
  return `${scope}:${limit}:${query.toLowerCase()}`;
}

function readCachedWorkSearch(
  key: string,
  now = Date.now(),
): { result: WorkSearchFanoutResult; stale: boolean } | null {
  const cached = successfulWorkSearches.get(key);
  if (!cached) return null;
  if (cached.staleUntil <= now) {
    successfulWorkSearches.delete(key);
    return null;
  }
  return {
    result: cached.result,
    stale: cached.freshUntil <= now,
  };
}

function rememberWorkSearch(
  key: string,
  result: WorkSearchFanoutResult,
  now = Date.now(),
): void {
  successfulWorkSearches.delete(key);
  successfulWorkSearches.set(key, {
    result,
    freshUntil: now + WORK_SEARCH_FRESH_MS,
    staleUntil: now + WORK_SEARCH_STALE_MS,
  });
  while (successfulWorkSearches.size > WORK_SEARCH_CACHE_LIMIT) {
    const oldest = successfulWorkSearches.keys().next().value;
    if (oldest == null) break;
    successfulWorkSearches.delete(oldest);
  }
}

/**
 * Fan out to every provider in scope on ONE canonical query, then rank, dedupe
 * and bound.
 *
 * Two guarantees the endpoints depend on:
 *  - one canonical query for provider requests, ranking and upstream caching,
 *    so casing/whitespace variants of the same search take the same warm path;
 *  - one provider failing degrades to the categories that did answer instead of
 *    failing the whole search — but a total failure is still thrown, never
 *    laundered into an empty 200.
 */
export async function searchWorksByScope(
  scope: WorkSearchScope,
  rawQuery: string,
  limit: number,
  providers: WorkSearchProviders = defaultWorkSearchProviders,
): Promise<WorkSearchFanoutResult> {
  const query = canonicalizeSearchQuery(rawQuery);
  const displayQuery = displaySearchQuery(rawQuery);
  const attempted = categoriesForScope(scope);
  const cacheEnabled = providers === defaultWorkSearchProviders;
  const cacheKey = cacheEnabled
    ? workSearchCacheKey(scope, query, limit)
    : null;

  if (cacheKey) {
    const cached = readCachedWorkSearch(cacheKey);
    if (cached && !cached.stale) {
      return { ...cached.result, stale: false };
    }
  }

  const settled = await Promise.allSettled(
    attempted.map((category) => providers[category](query, limit)),
  );

  const failed = attempted.filter(
    (_, index) => settled[index].status === "rejected",
  );
  if (failed.length === attempted.length) {
    const stale = cacheKey ? readCachedWorkSearch(cacheKey) : null;
    if (stale) {
      return {
        ...stale.result,
        failed,
        partial: true,
        stale: true,
      };
    }
    const firstReason = (settled[0] as PromiseRejectedResult | undefined)?.reason;
    throw new AllProvidersFailedError(failed, firstReason);
  }

  const byCategory: WorkSearchHit[][] = settled.map((entry) =>
    entry.status === "fulfilled" ? entry.value : [],
  );

  // Rank the merged set first so relevance — not provider order — decides which
  // representative of a shared workKey survives, then dedupe, then re-cap: the
  // fan-out gathers up to 3×limit.
  const merged =
    attempted.length > 1
      ? interleaveByProviderRank(byCategory, query)
      : byCategory[0];
  const ranked = rankTitleHitsByRelevance(merged, query);
  const seen = new Set<string>();
  const results = ranked
    .filter(
      (hit) =>
        bestQueryRelevanceTier(query, [hit.title, ...hit.aliases]) < 6,
    )
    .filter((hit) => (seen.has(hit.workKey) ? false : (seen.add(hit.workKey), true)))
    .slice(0, limit);

  const result = {
    results,
    query,
    displayQuery,
    attempted,
    failed,
    partial: failed.length > 0,
  };
  if (cacheKey) rememberWorkSearch(cacheKey, result);
  return result;
}
