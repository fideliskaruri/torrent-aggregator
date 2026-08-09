/**
 * A Map that cannot grow without bound.
 *
 * Several module-level caches in this app were plain `Map`s that only ever
 * deleted an entry when that exact key was read back — so a stream of distinct
 * keys (unique search queries, per-title lookups) grew the map forever and was
 * a prime suspect for the server's slow degradation over a long session
 * (BUG-011). This is the one place that knows how to bound a cache, so a new
 * cache opts *in* to leaking rather than forgetting to opt out.
 *
 * Two guards, both required:
 *   - a hard `maxEntries` cap, enforced on write by evicting the oldest entry
 *     (insertion order, i.e. FIFO — good enough and predictable);
 *   - a periodic sweep that drops entries whose TTL has passed, so an idle
 *     cache shrinks on its own instead of holding its high-water mark.
 *
 * `peek` returns an entry even when expired, because some callers (the search
 * cache) deliberately serve stale data while being throttled. `get` applies the
 * TTL and evicts on read. Neither refreshes recency: these are TTL caches, not
 * LRU — an entry's lifetime is fixed from when it was written.
 */
export interface BoundedTtlCache<V> {
  get(key: string): V | undefined;
  /** The stored value ignoring expiry, plus whether it has expired. */
  peek(key: string): { value: V; expired: boolean } | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): boolean;
  clear(): void;
  /** Drop every expired entry now. Returns how many were removed. */
  prune(): number;
  readonly size: number;
  readonly maxEntries: number;
}

export interface BoundedTtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
  /** How often to sweep expired entries. Omit to sweep only on write/read. */
  pruneIntervalMs?: number;
  /** Registers `size` under this name in the cache-size registry (health). */
  name?: string;
}

interface Entry<V> {
  value: V;
  expires: number;
}

/**
 * Process-wide registry so a health endpoint can report cache cardinality.
 *
 * Held on `globalThis` under a `Symbol.for` key (the same singleton pattern the
 * schedulers use) because Next re-evaluates modules per bundle/route and again
 * on every dev HMR pass. A module-local `Map` therefore gave the diagnostics
 * route *its own empty copy* of the registry while the caches that actually
 * matter had registered into a different one — health reported `{}` and looked
 * like "no caches", which is indistinguishable from "no leak".
 */
const REGISTRY_KEY = Symbol.for("torrentflow.cache.registry");

interface CacheRegistration {
  sizeOf: () => number;
  prune: () => number;
}

function registry(): Map<string, CacheRegistration> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, CacheRegistration> | undefined
  >;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map<string, CacheRegistration>();
  }
  return g[REGISTRY_KEY]!;
}

/** Snapshot of every named bounded cache's current entry count. */
export function boundedCacheSizes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, registration] of registry()) {
    try {
      out[name] = registration.sizeOf();
    } catch {
      // A dead closure from a discarded HMR module must not fail diagnostics.
    }
  }
  return out;
}

/** Names currently registered. Cheap enough for tests and diagnostics. */
export function registeredCacheNames(): string[] {
  return [...registry().keys()].sort();
}

export function boundedTtlCache<V>(
  options: BoundedTtlCacheOptions,
): BoundedTtlCache<V> {
  const { maxEntries, ttlMs, pruneIntervalMs, name } = options;
  if (pruneIntervalMs && pruneIntervalMs > 0 && !name) {
    throw new Error("boundedTtlCache requires a name when pruneIntervalMs is set");
  }
  const store = new Map<string, Entry<V>>();

  function set(key: string, value: V, customTtlMs?: number): void {
    // Delete-then-set so a re-written key moves to the newest position; FIFO
    // eviction then removes genuinely oldest entries, not recently refreshed ones.
    store.delete(key);
    store.set(key, { value, expires: Date.now() + (customTtlMs ?? ttlMs) });
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  function get(key: string): V | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function peek(key: string): { value: V; expired: boolean } | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    return { value: entry.value, expired: entry.expires <= Date.now() };
  }

  function prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of store) {
      if (entry.expires <= now) {
        store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  if (name) {
    registry().set(name, { sizeOf: () => store.size, prune });
  }

  if (pruneIntervalMs && pruneIntervalMs > 0 && name) {
    armIntervalOnce(
      Symbol.for(`torrentflow.cache.prune.${name}`),
      pruneIntervalMs,
      () => registry().get(name)?.prune(),
    );
  }

  return {
    get,
    peek,
    set,
    delete: (key: string) => store.delete(key),
    clear: () => store.clear(),
    prune,
    get size() {
      return store.size;
    },
    get maxEntries() {
      return maxEntries;
    },
  };
}
import { armIntervalOnce } from "@/lib/observability/arm-interval-once";
