import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  armIntervalOnce,
  armedInterval,
  disarmInterval,
} from "./arm-interval-once";

/**
 * These module-scope sweeps used to be bare `setInterval` calls. Next
 * re-evaluates a module once per route bundle and again on every dev HMR pass,
 * so each re-evaluation armed another 60s timer over another copy of the map —
 * a growing pile of wakeups pinning discarded module closures alive, which is
 * the slow-degradation signature these caches exist to avoid (BUG-011).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..");

// --- arm-once semantics ----------------------------------------------------

const KEY = Symbol.for("torrentflow.test.arm-once");
disarmInterval(KEY);

let ticks = 0;
const first = armIntervalOnce(KEY, 5, () => {
  ticks += 1;
});
assert.equal(first.armed, true, "the first arming creates the timer");
assert.ok(first.timer, "a timer handle is returned");

// Every subsequent module evaluation must reuse the same handle, not add one.
for (let i = 0; i < 5; i += 1) {
  const again = armIntervalOnce(KEY, 5, () => {
    ticks += 1;
  });
  assert.equal(again.armed, false, "re-evaluation does not arm a second timer");
  assert.equal(again.timer, first.timer, "the original handle is reused");
}
assert.equal(armedInterval(KEY), first.timer, "the singleton is readable");
assert.equal(ticks, 0, "arming alone does not run the sweep");

// A sweep that throws must not take the process down with it.
disarmInterval(KEY);
const throwing = armIntervalOnce(KEY, 5, () => {
  throw new Error("sweep blew up");
});
assert.equal(throwing.armed, true, "a throwing sweep still arms");
assert.equal(
  typeof (throwing.timer as { unref?: unknown }).unref,
  "function",
  "the sweep is unref-able so it never holds the process open",
);
disarmInterval(KEY);
assert.equal(armedInterval(KEY), null, "disarm forgets the timer");

// A non-positive interval is refused rather than becoming a busy loop.
assert.equal(
  armIntervalOnce(KEY, 0, () => {}).armed,
  false,
  "a zero interval is refused",
);
disarmInterval(KEY);

// --- the two real sweeps arm through the guard -----------------------------

const availabilitySource = fs.readFileSync(
  path.join(src, "lib", "browse", "availability.ts"),
  "utf8",
);
const searchCacheSource = fs.readFileSync(
  path.join(src, "lib", "torrents", "search-cache.ts"),
  "utf8",
);
const boundedCacheSource = fs.readFileSync(
  path.join(src, "lib", "cache", "bounded-ttl-cache.ts"),
  "utf8",
);

for (const [name, source] of [
  ["browse/availability.ts", availabilitySource],
  ["torrents/search-cache.ts", searchCacheSource],
  ["cache/bounded-ttl-cache.ts", boundedCacheSource],
] as const) {
  assert.match(
    source,
    /armIntervalOnce\(/,
    `${name} arms its sweep through the once-per-process guard`,
  );
  assert.equal(
    /\bsetInterval\(/.test(source),
    false,
    `${name} has no unguarded module-scope setInterval left`,
  );
}

/**
 * Connection budgets are explicitly out of scope for the observability slice.
 * This asserts the number in source so an "optimisation" cannot quietly raise
 * the swarm's connection ceiling under cover of a diagnostics change.
 */
const engineSource = fs.readFileSync(
  path.join(src, "lib", "clients", "builtin-engine.ts"),
  "utf8",
);
assert.match(
  engineSource,
  /const BUILTIN_CLIENT_OPTIONS = \{ utp: false, maxConns: 32 \} as const;/,
  "maxConns stays at 32 and utp stays off",
);
assert.equal(
  (engineSource.match(/maxConns\s*:/g) ?? []).length,
  1,
  "maxConns is assigned in exactly one place",
);

console.log(
  "PASS timer singletons: sweeps arm once per process; maxConns budget unchanged",
);
