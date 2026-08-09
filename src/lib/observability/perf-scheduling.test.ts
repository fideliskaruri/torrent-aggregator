/**
 * Perf/scheduling guards.
 *
 * Two independent server-cost decisions are covered here because they answer
 * the same question from opposite ends: `poll-schedule` decides which client
 * requests are never made, and `event-loop-recent` decides whether the effect
 * of that is visible in a number you can compare before and after.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REQUEST_DEADLINE_MS,
  MIN_REQUEST_DEADLINE_MS,
  createRequestSlot,
  decidePoll,
  requestDeadlineMs,
  shouldRefreshOnVisible,
} from "@/lib/observability/poll-schedule";
import {
  RECENT_SAMPLE_MS,
  RECENT_WINDOW_SAMPLES,
  makeLagSampler,
  monotonicNowMs,
  recentEventLoopSamples,
  recordEventLoopLag,
  resetRecentEventLoopSamples,
  summarizeLagSamples,
} from "@/lib/observability/event-loop-recent";

test("a visible, idle query polls", () => {
  assert.deepEqual(decidePoll({ hidden: false, inFlight: false }), {
    poll: true,
    reason: null,
  });
});

test("a hidden tab never polls — the request is pure server cost", () => {
  assert.equal(decidePoll({ hidden: true, inFlight: false }).poll, false);
  assert.equal(decidePoll({ hidden: true, inFlight: false }).reason, "hidden");
});

test("ticks do not pile up on a slow server", () => {
  const decision = decidePoll({ hidden: false, inFlight: true });
  assert.equal(decision.poll, false, "a tick while a request is outstanding is dropped");
  assert.equal(decision.reason, "in-flight");
});

test("hidden outranks in-flight as the reported reason", () => {
  assert.equal(decidePoll({ hidden: true, inFlight: true }).reason, "hidden");
});

test("a hidden tab stays silent even past the request deadline", () => {
  assert.deepEqual(
    decidePoll({
      hidden: true,
      inFlight: true,
      inFlightForMs: 600_000,
      deadlineMs: 15_000,
    }),
    { poll: false, reason: "hidden" },
  );
});

test("a young outstanding request still suppresses the tick", () => {
  assert.equal(
    decidePoll({
      hidden: false,
      inFlight: true,
      inFlightForMs: 14_999,
      deadlineMs: 15_000,
    }).reason,
    "in-flight",
  );
});

test("a request that never settles stops suppressing polls at the deadline", () => {
  assert.deepEqual(
    decidePoll({
      hidden: false,
      inFlight: true,
      inFlightForMs: 15_000,
      deadlineMs: 15_000,
    }),
    { poll: true, reason: null },
    "polling must recover instead of stopping forever",
  );
});

test("suppression is unbounded only when no deadline is supplied", () => {
  assert.equal(
    decidePoll({ hidden: false, inFlight: true, inFlightForMs: 600_000 }).reason,
    "in-flight",
  );
  assert.equal(
    decidePoll({
      hidden: false,
      inFlight: true,
      inFlightForMs: Number.NaN,
      deadlineMs: 15_000,
    }).reason,
    "in-flight",
    "an unknown age is treated as young, never as stuck",
  );
});

test("the deadline is derived from the cadence and clamped at both ends", () => {
  assert.equal(requestDeadlineMs(2_500), MIN_REQUEST_DEADLINE_MS);
  assert.equal(requestDeadlineMs(5_000), 20_000);
  assert.equal(requestDeadlineMs(600_000), MAX_REQUEST_DEADLINE_MS);
  assert.equal(requestDeadlineMs(0), MIN_REQUEST_DEADLINE_MS);
  assert.equal(requestDeadlineMs(Number.NaN), MIN_REQUEST_DEADLINE_MS);
});

test("an idle slot reports no outstanding request", () => {
  assert.equal(createRequestSlot().current(), null);
});

test("a superseded request cannot release its replacement's slot", () => {
  const slot = createRequestSlot();
  slot.claim({ generation: 1, startedAt: 1_000 });
  slot.claim({ generation: 2, startedAt: 2_000 });

  slot.release(1);

  assert.deepEqual(
    slot.current(),
    { generation: 2, startedAt: 2_000 },
    "the aborted generation's finally must not mark the live request idle",
  );
});

test("the owning request releases the slot", () => {
  const slot = createRequestSlot();
  slot.claim({ generation: 7, startedAt: 1_000 });
  slot.release(7);
  assert.equal(slot.current(), null);
});

test("a late release after the slot is already idle stays idle", () => {
  const slot = createRequestSlot();
  slot.claim({ generation: 3, startedAt: 1_000 });
  slot.release(3);
  slot.release(3);
  assert.equal(slot.current(), null);
});

test("an abandoned request stops suppressing polls immediately", () => {
  const slot = createRequestSlot();
  slot.claim({ generation: 1, startedAt: 1_000 });
  // What the effect cleanup does on unmount/re-query: abort, then release.
  slot.release(1);

  assert.deepEqual(
    decidePoll({
      hidden: false,
      inFlight: slot.current() !== null,
      inFlightForMs: 0,
      deadlineMs: requestDeadlineMs(5_000),
    }),
    { poll: true, reason: null },
  );
});

test("a brief tab switch does not fire an extra request", () => {
  assert.equal(
    shouldRefreshOnVisible({ intervalMs: 5_000, hiddenForMs: 300, missedTick: false }),
    false,
  );
});

test("coming back after a missed tick refreshes immediately", () => {
  assert.equal(
    shouldRefreshOnVisible({ intervalMs: 5_000, hiddenForMs: 60_000, missedTick: true }),
    true,
  );
  assert.equal(
    shouldRefreshOnVisible({ intervalMs: 5_000, hiddenForMs: 5_000, missedTick: false }),
    true,
    "a full interval of staleness is enough on its own",
  );
});

test("a non-polling query never auto-refreshes on visibility", () => {
  assert.equal(
    shouldRefreshOnVisible({ intervalMs: 0, hiddenForMs: 600_000, missedTick: true }),
    false,
  );
});

test("an empty window is honestly unavailable, not zero", () => {
  const summary = summarizeLagSamples([]);
  assert.equal(summary.available, false);
  assert.equal(summary.samples, 0);
});

test("percentiles are nearest-rank over the window", () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  const summary = summarizeLagSamples(samples);
  assert.equal(summary.p50, 50);
  assert.equal(summary.p95, 95);
  assert.equal(summary.p99, 99);
  assert.equal(summary.max, 100);
  assert.equal(summary.samples, 100);
});

test("a lone spike shows at max; p99 needs more than one sample to move", () => {
  // Nearest-rank, so with 100 samples p99 is the 99th — a SINGLE outlier sits
  // at rank 100 and is reported by max alone. This is why the payload
  // carries both, and why samples is reported next to them: reading p99 of a
  // short window as "the bad case" would understate a rare multi-second block.
  const one = summarizeLagSamples([...Array.from({ length: 99 }, () => 2), 900]);
  assert.equal(one.p50, 2);
  assert.equal(one.max, 900, "max never hides a spike");
  assert.equal(one.p99, 2, "one sample in a hundred does not reach p99");

  // Sustained blocking — 2% of the window — does move p99.
  const many = summarizeLagSamples([
    ...Array.from({ length: 98 }, () => 2),
    900,
    900,
  ]);
  assert.equal(many.p50, 2, "the typical tick is still fast");
  assert.equal(many.p99, 900, "repeated blocking is visible at p99");
});

test("the ring is bounded and forgets old samples", () => {
  resetRecentEventLoopSamples();
  for (let i = 0; i < RECENT_WINDOW_SAMPLES * 2; i += 1) recordEventLoopLag(i);
  const samples = recentEventLoopSamples();
  assert.equal(samples.length, RECENT_WINDOW_SAMPLES, "memory cannot grow without bound");
  assert.ok(
    Math.min(...samples) >= RECENT_WINDOW_SAMPLES,
    "the oldest half of the samples was dropped",
  );
  resetRecentEventLoopSamples();
});

test("bad samples are dropped, never clamped to a false zero", () => {
  resetRecentEventLoopSamples();
  recordEventLoopLag(-5);
  recordEventLoopLag(Number.NaN);
  assert.equal(recentEventLoopSamples().length, 0);
  recordEventLoopLag(12);
  assert.deepEqual(recentEventLoopSamples(), [12]);
  resetRecentEventLoopSamples();
});

test("the window length is reported so percentiles can be interpreted", () => {
  const summary = summarizeLagSamples(Array.from({ length: 60 }, () => 1));
  assert.equal(summary.windowSeconds, (60 * RECENT_SAMPLE_MS) / 1000);
});

/**
 * Clock-source guards. The sampler must measure the loop, not the clock: a
 * wall-clock step (NTP correction, sleep/resume) used to be indistinguishable
 * from a multi-second block and poisoned the whole recent window.
 */
test("a monotonic clock reports a punctual tick as near-zero lateness", () => {
  resetRecentEventLoopSamples();
  let monotonic = 1_000;
  const tick = makeLagSampler(() => monotonic);
  monotonic += RECENT_SAMPLE_MS + 4;
  tick();
  assert.deepEqual(recentEventLoopSamples(), [4]);
  resetRecentEventLoopSamples();
});

test("a wall-clock forward step does not appear as event-loop lag", () => {
  resetRecentEventLoopSamples();
  // The monotonic clock advances by exactly one interval while the wall clock
  // jumps an hour ahead. Only the monotonic delta may reach the ring.
  let monotonic = 5_000;
  const tick = makeLagSampler(() => monotonic);
  monotonic += RECENT_SAMPLE_MS;
  tick();
  assert.deepEqual(
    recentEventLoopSamples(),
    [0],
    "an NTP step or resume must not be recorded as a 3,600,000ms block",
  );
  resetRecentEventLoopSamples();
});

test("real blocking is still recorded at full magnitude", () => {
  resetRecentEventLoopSamples();
  let monotonic = 0;
  const tick = makeLagSampler(() => monotonic);
  monotonic += RECENT_SAMPLE_MS + 800;
  tick();
  monotonic += RECENT_SAMPLE_MS + 2;
  tick();
  assert.deepEqual(recentEventLoopSamples(), [800, 2]);
  resetRecentEventLoopSamples();
});

test("the injected sampler stays bounded at the ring capacity", () => {
  resetRecentEventLoopSamples();
  let monotonic = 0;
  const tick = makeLagSampler(() => monotonic);
  for (let i = 0; i < RECENT_WINDOW_SAMPLES + 10; i += 1) {
    monotonic += RECENT_SAMPLE_MS + 1;
    tick();
  }
  assert.equal(recentEventLoopSamples().length, RECENT_WINDOW_SAMPLES);
  resetRecentEventLoopSamples();
});

test("the default clock is monotonic and never steps backwards", () => {
  const first = monotonicNowMs();
  const second = monotonicNowMs();
  assert.ok(Number.isFinite(first), "the clock returns a usable number");
  assert.ok(second >= first, "a monotonic reading never goes back");
});
