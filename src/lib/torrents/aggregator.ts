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
import { dedupeResults, groupReleases, rankResults } from "./ranking";
import { applyFilters, type SearchFilters } from "./filters";
import { enrichResultsWithMetadata } from "@/lib/metadata/enrich";
import {
  attachDownloadRoutes,
  type RoutingPrefs,
} from "@/lib/download/attach-route";
import {
  cacheKeyFrom,
  getSearchCache,
  setSearchCache,
} from "./search-cache";

/**
 * 1337x is Cloudflare-blocked from many networks (HTTP 403, no API key).
 * Opt in with ENABLE_1337X=1 if you have a working mirror/proxy.
 */
const ALL_ADAPTERS: TorrentSourceAdapter[] = [
  nyaaAdapter,
  apibayAdapter,
  torrentsCsvAdapter,
  ytsAdapter,
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
  const cacheKey = cacheKeyFrom({
    q: query.toLowerCase(),
    category: options.category ?? "all",
    limit: options.limit ?? "default",
    sources: options.sources?.slice().sort() ?? "default",
    filters: options.filters ?? {},
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
    results = rankResults(results, query);

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
