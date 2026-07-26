import type {
  SearchOptions,
  SearchResponse,
  TorrentResult,
  TorrentSourceAdapter,
  TorrentSourceId,
} from "./types";
import { nyaaAdapter } from "./adapters/nyaa";
import { x1337Adapter } from "./adapters/x1337";
import { apibayAdapter } from "./adapters/apibay";
import { torrentsCsvAdapter } from "./adapters/torrentscsv";
import { ytsAdapter } from "./adapters/yts";
import { eztvAdapter } from "./adapters/eztv";
import { dedupeResults, groupReleases, rankResults } from "./ranking";
import { applyFilters, type SearchFilters } from "./filters";
import { getTargetResolution } from "./target-resolution";
import { enrichResultsWithMetadata } from "@/lib/metadata/enrich";
import {
  attachDownloadRoutes,
  type RoutingPrefs,
} from "@/lib/download/attach-route";
import {
  cacheKeyFrom,
  getSearchCache,
  setSearchCache,
  rateLimit,
  rateLimitResetSeconds,
} from "./search-cache";

/**
 * Raised only when the indexer budget is spent AND there is nothing cached to
 * fall back on. Carries the wait so the UI can say something actionable.
 */
export class SearchThrottledError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(
      `Indexers are being rate limited. Retry in ${Math.max(1, retryAfterSeconds)}s.`,
    );
    this.name = "SearchThrottledError";
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

/**
 * Two budgets, because two callers with very different urgency share one set of
 * indexers. The budget models the indexers — they ban IPs that hammer them —
 * but a background watchlist pass over twenty shows would otherwise spend the
 * whole minute's allowance and throttle the human sitting at the search box.
 * The person waiting wins; a scheduled hunt can retry in half an hour.
 */
const UPSTREAM_BUDGET_KEY = "indexer-fanout";
const BACKGROUND_BUDGET_KEY = "indexer-fanout:background";
const BACKGROUND_BUDGET_MAX = 15;

/**
 * 1337x is Cloudflare-blocked from many networks (HTTP 403, no API key).
 * Opt in with ENABLE_1337X=1 if you have a working mirror/proxy.
 */
const ALL_ADAPTERS: TorrentSourceAdapter[] = [
  nyaaAdapter,
  apibayAdapter,
  torrentsCsvAdapter,
  ytsAdapter,
  eztvAdapter,
  ...(process.env.ENABLE_1337X === "1" ? [x1337Adapter] : []),
];

function pickAdapters(sources?: TorrentSourceId[]): TorrentSourceAdapter[] {
  if (!sources?.length) return ALL_ADAPTERS;
  const set = new Set(sources);
  // Allow requesting 1337x even when not in default list
  const base = [...ALL_ADAPTERS];
  if (set.has("1337x") && !base.some((a) => a.id === "1337x")) {
    base.push(x1337Adapter);
  }
  return base.filter((a) => set.has(a.id));
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
/** Per-source fetch when no explicit limit is set — enough for multi-page results. */
const DEFAULT_PER_SOURCE_LIMIT = 50;

function clampPageSize(raw?: number): number {
  const n = raw ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_SIZE);
}

function clampPage(raw: number | undefined, totalPages: number): number {
  const n = raw ?? 1;
  const page = Number.isFinite(n) ? Math.max(Math.trunc(n), 1) : 1;
  if (totalPages <= 0) return 1;
  return Math.min(page, totalPages);
}

/**
 * Fan-out search across adapters, normalize, dedupe, filter, rank, enrich.
 * Ranking runs on the filtered set so scores/bestPicks match what the user sees.
 * Returns a paginated slice of ranked results plus totalCount / page metadata.
 */
export async function searchTorrents(
  options: SearchOptions & {
    enrich?: boolean;
    filters?: SearchFilters;
    skipCache?: boolean;
    /** User download prefs for server-side path/category routing */
    routing?: RoutingPrefs | null;
    /**
     * Background work draws on a smaller, separate indexer budget so a large
     * watchlist cannot throttle the user's own interactive searches.
     */
    background?: boolean;
  },
): Promise<SearchResponse> {
  const started = Date.now();
  const query = options.query?.trim() ?? "";
  const pageSize = clampPageSize(options.pageSize);

  if (!query) {
    return {
      query,
      results: [],
      groups: [],
      tookMs: 0,
      sources: [],
      totalCount: 0,
      page: 1,
      pageSize,
      totalPages: 0,
    };
  }

  // Cache full ranked+filtered pool (no page). Enrich runs per page after slice.
  // The target resolution is part of the key: it changes the *order* of the
  // cached pool, so serving a pool ranked for a different target would silently
  // undo the setting the user just changed.
  const targetResolution = await getTargetResolution();
  const cacheKey = cacheKeyFrom({
    q: query.toLowerCase(),
    category: options.category ?? "all",
    limit: options.limit ?? "default",
    sources: options.sources?.slice().sort() ?? "default",
    filters: options.filters ?? {},
    target: targetResolution,
  });

  let fullResults: TorrentResult[] | null = null;
  let sources: SearchResponse["sources"] = [];
  let fromCache = false;

  if (!options.skipCache) {
    const cached = await getSearchCache(cacheKey);
    if (cached) {
      fullResults = cached.results;
      sources = cached.sources;
      fromCache = true;
    }
  }

  if (!fullResults) {
    const adapters = pickAdapters(options.sources);

    // Spend the indexer budget here — the only place that actually contacts
    // them. If it is exhausted, a stale cached pool beats an error every time.
    const budgetKey = options.background
      ? BACKGROUND_BUDGET_KEY
      : UPSTREAM_BUDGET_KEY;
    const budgetMax = options.background ? BACKGROUND_BUDGET_MAX : undefined;
    if (!rateLimit(budgetKey, budgetMax)) {
      // `skipCache` is a freshness contract, and automation relies on it: a
      // grab/skip decision made on stale seeder counts and a possibly-dead
      // magnet gets auto-sent to the download engine. Deferring to the next
      // pass is strictly better than acting on data we were told not to trust.
      const stale = options.skipCache
        ? null
        : await getSearchCache(cacheKey, { allowStale: true });
      if (stale) {
        fullResults = stale.results;
        sources = stale.sources;
        fromCache = true;
      } else {
        throw new SearchThrottledError(rateLimitResetSeconds(budgetKey));
      }
    }

    if (!fullResults) {
    const perSourceLimit = Math.min(
      Math.max(options.limit ?? DEFAULT_PER_SOURCE_LIMIT, pageSize),
      80,
    );

    const settled = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const results = await adapter.search({
          ...options,
          query,
          limit: perSourceLimit,
        });
        return { adapter, results };
      }),
    );

    sources = [];
    let merged: TorrentResult[] = [];

    for (let i = 0; i < settled.length; i++) {
      const adapter = adapters[i];
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        sources.push({
          id: adapter.id,
          count: outcome.value.results.length,
        });
        merged = merged.concat(outcome.value.results);
      } else {
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        sources.push({ id: adapter.id, count: 0, error: message });
      }
    }

    // Filter first, then rank — score/bestPick for the set the user actually sees
    // (e.g. 4K filter ranks among 4K releases, not a sliced full-pool ranking).
    let results = dedupeResults(merged);
    if (options.filters) {
      results = applyFilters(results, options.filters);
    }
    results = rankResults(results, query, targetResolution);

    if (options.limit != null) {
      results = results.slice(0, options.limit);
    }

    fullResults = results;

    // Cache the full unenriched pool so any page can be served from cache.
    void setSearchCache(cacheKey, {
      query,
      results: fullResults,
      groups: [],
      tookMs: Date.now() - started,
      sources,
      totalCount: fullResults.length,
      page: 1,
      pageSize,
      totalPages: 0,
    });
    }
  }

  const totalCount = fullResults.length;
  const totalPages =
    totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const page = clampPage(options.page, totalPages);
  const start = (page - 1) * pageSize;
  let results = fullResults.slice(start, start + pageSize);

  if (options.enrich !== false && results.length > 0) {
    results = await enrichResultsWithMetadata(
      results,
      query,
      options.category,
    );
  }

  // Always compute routes on the server after enrich (uses metadata)
  results = attachDownloadRoutes(
    results,
    options.category,
    options.routing ?? null,
  );

  const groups = groupReleases(results);

  return {
    query,
    results,
    groups,
    tookMs: Date.now() - started,
    sources,
    totalCount,
    page,
    pageSize,
    totalPages,
    ...(fromCache ? { cached: true } : {}),
  };
}

export function listAvailableSources(): {
  id: TorrentSourceId;
  name: string;
  enabledByDefault: boolean;
}[] {
  return [
    { id: "nyaa", name: "Nyaa", enabledByDefault: true },
    { id: "apibay", name: "ThePirateBay", enabledByDefault: true },
    { id: "torrentscsv", name: "TorrentsCSV", enabledByDefault: true },
    { id: "yts", name: "YTS", enabledByDefault: true },
    {
      id: "1337x",
      name: "1337x",
      enabledByDefault: process.env.ENABLE_1337X === "1",
    },
  ];
}

export { ALL_ADAPTERS };
