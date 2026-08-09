import { searchAniListWorks } from "@/lib/metadata/anilist";
import { searchTmdbByType } from "@/lib/metadata/tmdb";
import {
  interleaveByProviderRank,
  rankTitleHitsByRelevance,
} from "@/components/search/title-search";
import {
  canonicalizeSearchQuery,
  displaySearchQuery,
} from "@/lib/search/query-variants";
import {
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
}

export type WorkSearchProviders = {
  [K in WorkSearchCategory]: (
    query: string,
    limit: number,
  ) => Promise<WorkSearchHit[]>;
};

export const defaultWorkSearchProviders: WorkSearchProviders = {
  movies: async (query, limit) => hitsFrom(
    await searchTmdbByType("movie", query, limit),
    "movies",
  ),
  series: async (query, limit) => hitsFrom(
    await searchTmdbByType("tv", query, limit),
    "series",
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

  const settled = await Promise.allSettled(
    attempted.map((category) => providers[category](query, limit)),
  );

  const failed = attempted.filter(
    (_, index) => settled[index].status === "rejected",
  );
  if (failed.length === attempted.length) {
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
    .filter((hit) => (seen.has(hit.workKey) ? false : (seen.add(hit.workKey), true)))
    .slice(0, limit);

  return {
    results,
    query,
    displayQuery,
    attempted,
    failed,
    partial: failed.length > 0,
  };
}
