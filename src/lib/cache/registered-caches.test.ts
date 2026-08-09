import assert from "node:assert/strict";
import {
  boundedTtlCache,
  boundedCacheSizes,
  registeredCacheNames,
} from "./bounded-ttl-cache";
import {
  EXPECTED_CACHE_NAMES,
  registeredCacheSizes,
} from "./registered-caches";

const REGISTRY_KEY = Symbol.for("torrentflow.cache.registry");

// The registry lives on globalThis, not in a module-local Map. Next evaluates a
// module once per route bundle and again on every dev HMR pass; a module-local
// registry gave the diagnostics route its own empty copy, so health reported
// `{}` — which looks identical to "nothing is leaking" (BUG-011).
const globalRegistry = (globalThis as unknown as Record<symbol, unknown>)[
  REGISTRY_KEY
];
assert.ok(
  globalRegistry instanceof Map,
  "registry is a globalThis Symbol.for singleton",
);

// A registration made through the module is visible on the global singleton,
// which is what a second module copy would read.
boundedTtlCache<number>({
  maxEntries: 4,
  ttlMs: 60_000,
  name: "test:registry-singleton",
}).set("a", 1);
assert.equal(
  (globalRegistry as Map<string, () => number>).has("test:registry-singleton"),
  true,
  "named caches register into the global singleton",
);
assert.equal(
  boundedCacheSizes()["test:registry-singleton"],
  1,
  "sizes are read back through the singleton",
);

// A second, independently-created registry entry survives alongside the first:
// registration persists rather than being replaced wholesale.
boundedTtlCache<number>({
  maxEntries: 4,
  ttlMs: 60_000,
  name: "test:registry-second",
});
assert.equal(
  registeredCacheNames().includes("test:registry-singleton"),
  true,
  "earlier registration persists after a later one",
);
assert.equal(
  registeredCacheNames().includes("test:registry-second"),
  true,
  "later registration is also present",
);

// A dead closure (a cache from a discarded HMR module) must not fail health.
(globalRegistry as Map<string, () => number>).set("test:throwing", () => {
  throw new Error("stale closure");
});
assert.doesNotThrow(
  () => boundedCacheSizes(),
  "a throwing size closure cannot break diagnostics",
);
assert.equal(
  "test:throwing" in boundedCacheSizes(),
  false,
  "a throwing cache is omitted rather than reported as zero",
);
(globalRegistry as Map<string, () => number>).delete("test:throwing");

// The barrel is the guarantee that health can never honestly report `{}`:
// importing it constructs every named cache module.
const snapshot = registeredCacheSizes();
for (const name of EXPECTED_CACHE_NAMES) {
  assert.equal(
    name in snapshot.sizes,
    true,
    `barrel registers ${name} into the health registry`,
  );
  assert.equal(
    snapshot.registered.includes(name),
    true,
    `${name} is listed among registered names`,
  );
}
assert.deepEqual(
  snapshot.missing,
  [],
  "no expected cache is missing from the registry",
);
assert.equal(
  Object.keys(snapshot.sizes).length > 0,
  true,
  "health can never report an empty cache map after the barrel import",
);

console.log(
  "PASS registered caches: globalThis registry singleton, persistence, barrel registration",
);
