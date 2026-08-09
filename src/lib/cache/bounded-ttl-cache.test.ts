import assert from "node:assert/strict";
import { boundedTtlCache, boundedCacheSizes } from "./bounded-ttl-cache";
import {
  armedInterval,
  disarmInterval,
} from "@/lib/observability/arm-interval-once";

// A hard cap evicts the oldest entries (FIFO), so a stream of distinct keys
// cannot grow the map without bound (BUG-011).
const cap = boundedTtlCache<number>({ maxEntries: 3, ttlMs: 60_000 });
for (let i = 0; i < 10; i += 1) cap.set(`k${i}`, i);
assert.equal(cap.size, 3, "never exceeds maxEntries");
assert.equal(cap.get("k0"), undefined, "oldest entries are evicted");
assert.equal(cap.get("k9"), 9, "newest entry is retained");

// Re-writing a key moves it to newest, so it is not the next evicted.
const lru = boundedTtlCache<number>({ maxEntries: 2, ttlMs: 60_000 });
lru.set("a", 1);
lru.set("b", 2);
lru.set("a", 3); // refresh a
lru.set("c", 4); // should evict b, not a
assert.equal(lru.get("a"), 3, "refreshed key survives");
assert.equal(lru.get("b"), undefined, "stale key evicted");
assert.equal(lru.get("c"), 4);

// TTL: get evicts an expired entry; peek still returns it flagged expired.
const ttl = boundedTtlCache<string>({ maxEntries: 10, ttlMs: 5 });
ttl.set("x", "hello");
assert.equal(ttl.get("x"), "hello", "fresh value returns");
const start = Date.now();
while (Date.now() - start < 12) {
  /* spin briefly past the 5ms TTL */
}
assert.equal(ttl.get("x"), undefined, "expired value is not returned by get");
ttl.set("y", "world");
const peeked = ttl.peek("y");
assert.equal(peeked?.value, "world");
assert.equal(peeked?.expired, false);

// A stored null value (a cached negative) is distinct from a miss.
const nullable = boundedTtlCache<number | null>({ maxEntries: 4, ttlMs: 60_000 });
nullable.set("neg", null);
assert.equal(nullable.get("neg"), null, "cached null is a hit, not a miss");
assert.equal(nullable.get("absent"), undefined, "missing key is undefined");

// Named caches appear in the health registry.
const named = boundedTtlCache<number>({ maxEntries: 5, ttlMs: 60_000, name: "test:sizes" });
named.set("one", 1);
named.set("two", 2);
assert.equal(boundedCacheSizes()["test:sizes"], 2, "size is reported by name");

// Periodic pruning must be process-singleton and dynamically target the newest
// HMR cache registration rather than retaining an obsolete store closure.
assert.throws(
  () =>
    boundedTtlCache<number>({
      maxEntries: 5,
      ttlMs: 60_000,
      pruneIntervalMs: 10,
    }),
  /requires a name/,
  "periodic caches require a stable singleton name",
);
const pruneName = "test:singleton-prune";
const pruneKey = Symbol.for(`torrentflow.cache.prune.${pruneName}`);
disarmInterval(pruneKey);
boundedTtlCache<number>({
  maxEntries: 5,
  ttlMs: 60_000,
  pruneIntervalMs: 10,
  name: pruneName,
});
const firstTimer = armedInterval(pruneKey);
boundedTtlCache<number>({
  maxEntries: 5,
  ttlMs: 60_000,
  pruneIntervalMs: 10,
  name: pruneName,
});
assert.equal(
  armedInterval(pruneKey),
  firstTimer,
  "re-registering a cache reuses the process-wide prune timer",
);
disarmInterval(pruneKey);

console.log("PASS bounded TTL cache: caps, FIFO eviction, TTL, null hits, size registry");
