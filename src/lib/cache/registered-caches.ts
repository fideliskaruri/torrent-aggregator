/**
 * Side-effect barrel that guarantees every *named* bounded cache has been
 * constructed before anything reads the size registry.
 *
 * A cache only appears in `boundedCacheSizes()` once its module has been
 * evaluated, and in Next a route bundle only evaluates the modules it actually
 * imports. The diagnostics health route imports none of the cache modules, so
 * it reported `caches: {}` — an empty object that *looks* like a clean, tiny
 * process but really means "nobody has registered here yet". That is the exact
 * failure mode the registry exists to rule out (BUG-011), so health must not be
 * able to produce it.
 *
 * Importing this module is deliberately for effect only: each import below
 * constructs its module-level cache, which self-registers by `name`.
 *
 * When adding a new named bounded cache, add it here too.
 */
import "@/lib/torrents/search-cache";
import "@/lib/metadata/cache";

import {
  boundedCacheSizes,
  registeredCacheNames,
} from "@/lib/cache/bounded-ttl-cache";

/** Names this barrel is responsible for pulling into the registry. */
export const EXPECTED_CACHE_NAMES = ["metadata:query", "search:memory"] as const;

/**
 * Cache sizes with every barrel-registered cache guaranteed present.
 *
 * Registration is the caller's proof, not a hope: the return value is the live
 * registry, and `missing` names the caches that failed to register so a silent
 * regression (a cache renamed, or dropped from this barrel) shows up in health
 * instead of vanishing.
 */
export function registeredCacheSizes(): {
  sizes: Record<string, number>;
  registered: string[];
  missing: string[];
} {
  const sizes = boundedCacheSizes();
  const registered = registeredCacheNames();
  const missing = EXPECTED_CACHE_NAMES.filter((name) => !(name in sizes));
  return { sizes, registered, missing };
}
