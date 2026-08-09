import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { normalizeTitle } from "@/lib/utils";
import { boundedTtlCache } from "@/lib/cache/bounded-ttl-cache";
import { armIntervalOnce } from "@/lib/observability/arm-interval-once";
import type { SearchResponse } from "./types";

const DEFAULT_TTL_MS = 1000 * 60 * 3; // 3 minutes
const RATE_WINDOW_MS = 1000 * 60;
const RATE_MAX = 40;

// Bounded so a long session of distinct queries cannot grow it without limit
// (BUG-011). The hard `maxEntries` cap alone does the bounding; there is
// deliberately no periodic prune, because `allowStale` serves expired entries
// via `peek` and a timer that deleted them would make stale-serving vanish
// under upstream throttling. Expired entries linger until FIFO eviction.
const memory = boundedTtlCache<SearchResponse>({
  maxEntries: 500,
  ttlMs: DEFAULT_TTL_MS,
  name: "search:memory",
});

const rateBuckets = new Map<string, { count: number; reset: number }>();

// Expired rate-limit windows must be swept on a timer, not by eviction: dropping
// a bucket that is still inside its window would silently reset a limit early.
//
// Armed once per process through the shared guard (see `armIntervalOnce`).
// Without it, every dev HMR re-evaluation and every route bundle that imports
// this module started another sweep over a *different* `rateBuckets` map,
// pinning the old module closure alive forever.
export const SEARCH_RATE_SWEEP_KEY = Symbol.for(
  "torrentflow.search-cache.rate-sweep",
);

armIntervalOnce(SEARCH_RATE_SWEEP_KEY, RATE_WINDOW_MS, () => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.reset < now) rateBuckets.delete(key);
  }
});

export async function invalidateSearchCacheStores(
  memoryStore: { clear(): void },
  deletePersisted: () => Promise<unknown>,
): Promise<{ memoryCleared: true; persistedCleared: boolean }> {
  memoryStore.clear();
  try {
    await deletePersisted();
    return { memoryCleared: true, persistedCleared: true };
  } catch (error) {
    console.warn("[search-cache] Failed to clear persisted entries:", error);
    return { memoryCleared: true, persistedCleared: false };
  }
}

/**
 * Ranking settings are embedded in cache identity, but old rows are not useful
 * after a target change and stale fallback must not resurrect incompatible
 * ordering. Clear both process memory and persisted fallback entries.
 */
export async function invalidateSearchCache(): Promise<{
  memoryCleared: true;
  persistedCleared: boolean;
}> {
  return invalidateSearchCacheStores(memory, () => prisma.searchCache.deleteMany());
}

/**
 * Budget for **outbound indexer fetches**, not for user requests.
 *
 * This app binds to 127.0.0.1 with no auth, so throttling the user protects
 * nobody — there is no adversary on the other end of the socket. What genuinely
 * needs protecting is the public indexers, which ban IPs that hammer them.
 *
 * Counting HTTP requests to `/api/search` measured the wrong thing entirely: a
 * cache hit contacts no indexer at all, yet still burned budget, so paging
 * through results or nudging a filter could lock the user out of his own app
 * for a minute with nothing to show for it. The budget is therefore spent at
 * the point of the actual upstream fan-out.
 */
export function rateLimit(key: string, max = RATE_MAX): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** Seconds until `key`'s budget refills, for an actionable error message. */
export function rateLimitResetSeconds(key: string): number {
  const bucket = rateBuckets.get(key);
  if (!bucket) return 0;
  return Math.max(0, Math.ceil((bucket.reset - Date.now()) / 1000));
}

/**
 * Stable cache key. Nested objects (filters) must be fully included —
 * JSON.stringify(obj, Object.keys(obj)) only keeps those keys at *every*
 * depth, so nested filter fields (resolution, minSeeders, …) became `{}`
 * and every filter combo shared one unfiltered cache entry.
 */
export function cacheKeyFrom(parts: Record<string, unknown>): string {
  const raw = JSON.stringify(sortKeysDeep(parts));
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeysDeep(obj[key]);
  }
  return out;
}

export async function getSearchCache(
  key: string,
  opts: { allowStale?: boolean } = {},
): Promise<SearchResponse | null> {
  const mem = memory.peek(key);
  if (mem && (opts.allowStale || !mem.expired)) return mem.value;

  try {
    const row = await prisma.searchCache.findUnique({ where: { cacheKey: key } });
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      // A stale entry is worth far more than an error when we are being
      // throttled — the alternative is showing the user nothing at all.
      if (opts.allowStale) return JSON.parse(row.payload) as SearchResponse;
      void prisma.searchCache.delete({ where: { cacheKey: key } }).catch(() => undefined);
      return null;
    }
    const value = JSON.parse(row.payload) as SearchResponse;
    memory.set(key, value, row.expiresAt.getTime() - Date.now());
    return value;
  } catch {
    return null;
  }
}

export async function setSearchCache(
  key: string,
  value: SearchResponse,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  // Recorded so the browse availability resolver can find "the latest search
  // for this title" without reconstructing this row's opaque `cacheKey` from
  // an option set it does not know. See the field comment in schema.prisma.
  const normalizedQuery = normalizeTitle(value.query ?? "") || null;
  memory.set(key, value, ttlMs);
  try {
    await prisma.searchCache.upsert({
      where: { cacheKey: key },
      create: {
        cacheKey: key,
        normalizedQuery,
        payload: JSON.stringify(value),
        expiresAt,
      },
      update: {
        normalizedQuery,
        payload: JSON.stringify(value),
        expiresAt,
      },
    });
  } catch {
    // ignore
  }
}
