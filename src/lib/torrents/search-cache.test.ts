/**
 * Cache key must distinguish filter combinations.
 * Run: npx tsx src/lib/torrents/search-cache.test.ts
 */
import assert from "node:assert/strict";
import { cacheKeyFrom, invalidateSearchCacheStores } from "./search-cache";

const base = {
  q: "dune part two",
  category: "movies",
  limit: "default",
  sources: "default",
};

const unfiltered = cacheKeyFrom({ ...base, filters: {} });
const res2160 = cacheKeyFrom({
  ...base,
  filters: { resolution: "2160p", minSeeders: 5, maxSizeBytes: 8e9 },
});
const res1080 = cacheKeyFrom({
  ...base,
  filters: { resolution: "1080p" },
});
const res2160Same = cacheKeyFrom({
  ...base,
  filters: { maxSizeBytes: 8e9, minSeeders: 5, resolution: "2160p" },
});

assert.notEqual(
  unfiltered,
  res2160,
  "unfiltered and 2160p filters must not share a cache key",
);
assert.notEqual(
  res2160,
  res1080,
  "2160p and 1080p filters must not share a cache key",
);
assert.equal(
  res2160,
  res2160Same,
  "key order inside filters must not change the cache key",
);

async function main() {
  const memory = new Map<string, unknown>([["old-target", { results: [] }]]);
  let persistedDeletes = 0;
  const cleared = await invalidateSearchCacheStores(memory, async () => {
    persistedDeletes += 1;
  });
  assert.equal(memory.size, 0, "settings invalidation clears in-memory results");
  assert.equal(persistedDeletes, 1, "settings invalidation clears persisted results");
  assert.deepEqual(cleared, { memoryCleared: true, persistedCleared: true });

  memory.set("old-target", {});
  const partial = await invalidateSearchCacheStores(memory, async () => {
    throw new Error("database unavailable");
  });
  assert.equal(memory.size, 0, "memory is cleared even when persisted cleanup fails");
  assert.equal(partial.persistedCleared, false);

// Nested resolution must appear in the serialized form (regression for
// JSON.stringify replacer array stripping nested keys).
const probe = JSON.stringify(
  { filters: { resolution: "2160p" } },
  Object.keys({ filters: { resolution: "2160p" } }).sort(),
);
assert.equal(
  probe,
  '{"filters":{}}',
  "sanity: broken stringify would empty nested filters",
);

  console.log("search-cache.test.ts: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
