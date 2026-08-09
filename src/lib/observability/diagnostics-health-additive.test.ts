import assert from "node:assert/strict";
import { buildDiagnosticsHealthResponse } from "./responses";
import {
  eventLoopDelaySnapshot,
  formatEventLoopDelay,
} from "./event-loop-delay";

const database = { ready: true, latencyMs: 3 };
const now = new Date("2026-01-01T00:00:00.000Z");

// --- the existing response shape is preserved ------------------------------

// Everything this slice adds is *additive*. The pre-existing keys must keep
// their exact names and values, so any consumer already reading this payload is
// untouched by the new observability fields.
const baseline = buildDiagnosticsHealthResponse(database, [], {
  now,
  uptimeSeconds: 10,
  buildId: "1.2.3",
});
for (const key of [
  "status",
  "live",
  "ready",
  "timestamp",
  "process",
  "build",
  "database",
  "caches",
  "components",
]) {
  assert.equal(key in baseline, true, `${key} is still present`);
}
assert.equal(baseline.status, "ok");
assert.equal(baseline.ready, true);
assert.equal(baseline.build.id, "1.2.3");
assert.equal(baseline.database.status, "up");
assert.deepEqual(baseline.caches, {}, "caches defaults to an empty map");
assert.deepEqual(baseline.components, []);

// New fields are present with honest null/empty defaults when not supplied.
assert.deepEqual(
  baseline.cacheRegistry,
  { names: [], missing: [] },
  "an empty registry reports no names rather than being absent",
);
assert.equal(baseline.enginePressure, null, "engine pressure defaults to null");
assert.equal(baseline.eventLoopDelay, null, "event loop delay defaults to null");

// --- additive fields are passed through faithfully -------------------------

const enriched = buildDiagnosticsHealthResponse(database, [], {
  now,
  uptimeSeconds: 10,
  buildId: "1.2.3",
  caches: { "search:memory": 12, "metadata:query": 3 },
  cacheNames: ["metadata:query", "search:memory"],
  missingCaches: [],
  enginePressure: { totals: { torrents: 2, wires: 9 } },
  eventLoopDelay: { available: true, p50: 1.2, p99: 40.5, max: 90, mean: 3 },
});
assert.equal(enriched.caches["search:memory"], 12);
assert.deepEqual(enriched.cacheRegistry.names, [
  "metadata:query",
  "search:memory",
]);
assert.deepEqual(enriched.cacheRegistry.missing, []);
assert.deepEqual(enriched.enginePressure, { totals: { torrents: 2, wires: 9 } });
assert.deepEqual(enriched.eventLoopDelay, {
  available: true,
  p50: 1.2,
  p99: 40.5,
  max: 90,
  mean: 3,
});

// A cache that failed to register is named, not silently dropped: an empty
// `caches` map must never be mistaken for a healthy, tiny process (BUG-011).
const degraded = buildDiagnosticsHealthResponse(database, [], {
  now,
  caches: {},
  missingCaches: ["search:memory"],
});
assert.deepEqual(
  degraded.cacheRegistry.missing,
  ["search:memory"],
  "a cache missing from the registry is reported",
);

// Registry names default to the keys of `caches` when not supplied explicitly,
// so an older caller cannot produce an inconsistent payload.
const inferred = buildDiagnosticsHealthResponse(database, [], {
  now,
  caches: { b: 1, a: 2 },
});
assert.deepEqual(inferred.cacheRegistry.names, ["a", "b"]);

// --- event loop delay ------------------------------------------------------

const delay = eventLoopDelaySnapshot();
assert.equal(typeof delay.available, "boolean");
assert.equal(typeof delay.p50, "number", "p50 is always a number");
assert.equal(typeof delay.p99, "number", "p99 is always a number");
assert.equal(Number.isFinite(delay.p50), true, "p50 is finite");
assert.equal(Number.isFinite(delay.p99), true, "p99 is finite");
assert.equal(delay.p50 >= 0, true, "p50 is never negative");
assert.equal(delay.p99 >= 0, true, "p99 is never negative");

// Reading must not reset the histogram — two readers cannot blind each other.
const second = eventLoopDelaySnapshot();
assert.equal(second.available, delay.available, "availability is stable");

// Nanoseconds in, milliseconds out, rounded to one honest decimal.
assert.deepEqual(
  formatEventLoopDelay({ p50: 1_500_000, p99: 42_000_000, max: 1e9, mean: 0 }),
  { available: true, p50: 1.5, p99: 42, max: 1000, mean: 0, resolutionMs: 10 },
  "nanosecond samples are converted to milliseconds",
);
assert.deepEqual(
  formatEventLoopDelay(null),
  { available: false, p50: 0, p99: 0, max: 0, mean: 0, resolutionMs: 10 },
  "an absent histogram reports unavailable rather than fake zeros as data",
);
assert.deepEqual(
  formatEventLoopDelay({
    p50: Number.NaN,
    p99: -1,
    max: Number.POSITIVE_INFINITY,
    mean: 0,
  }),
  { available: true, p50: 0, p99: 0, max: 0, mean: 0, resolutionMs: 10 },
  "non-finite and negative samples clamp to 0",
);

// The sampling resolution is part of the payload: without it a reader cannot
// tell an idle process's irreducible timer floor from real loop pressure.
assert.equal(
  delay.resolutionMs,
  10,
  "the sampling resolution is reported so percentiles are interpretable",
);

console.log(
  "PASS diagnostics health: existing shape preserved, additive cache/engine/event-loop fields",
);
