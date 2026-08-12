/**
 * Behavioural guards for the poll/request lifecycle `useApiQuery` runs on.
 *
 * This repo has no DOM, no jsdom and no React test renderer, and adding one
 * to test a hook would be a dependency bought to prove a state machine. So
 * the state machine was extracted (`createRequestLifecycle`) and is driven
 * here through the *exact* call sequences the hook performs — claim on effect
 * run, `settled` in `finally`, `abandon` in cleanup, `decide` on each tick —
 * including the orderings that caused the original regression. The last test
 * asserts the hook actually wires those calls, so the extraction cannot rot
 * into a state machine nothing uses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FIRST_LOAD_REQUEST_DEADLINE_MS,
  MAX_ADAPTIVE_REQUEST_DEADLINE_MS,
  MIN_REQUEST_DEADLINE_MS,
  createRequestLifecycle,
  requestDeadlineMs,
} from "@/lib/observability/poll-schedule";

const TITLE_POLL_MS = 2_500;

/** One run of the fetch effect, as the hook sequences it. */
function beginRequest(
  lifecycle: ReturnType<typeof createRequestLifecycle>,
  now: number,
) {
  const generation = lifecycle.begin(now);
  let aborted = false;
  return {
    generation,
    /** Effect cleanup: abort + abandon, regardless of whether fetch rejects. */
    cleanup() {
      aborted = true;
      lifecycle.abandon(generation);
    },
    /** The `finally` block, which also runs for an aborted request. */
    finallyBlock() {
      lifecycle.settled(generation);
    },
    isAborted() {
      return aborted;
    },
  };
}

function tick(
  lifecycle: ReturnType<typeof createRequestLifecycle>,
  now: number,
  hidden = false,
) {
  return lifecycle.decide({ hidden, now, intervalMs: TITLE_POLL_MS });
}

test("a hidden tab never polls, even past the request deadline", () => {
  const lifecycle = createRequestLifecycle();
  beginRequest(lifecycle, 0);
  assert.deepEqual(tick(lifecycle, 10 * 60_000, true), {
    poll: false,
    reason: "hidden",
  });
});

test("an outstanding request suppresses overlapping ticks", () => {
  const lifecycle = createRequestLifecycle();
  beginRequest(lifecycle, 0);
  assert.deepEqual(tick(lifecycle, TITLE_POLL_MS), {
    poll: false,
    reason: "in-flight",
  });
});

test("a settled request stops suppressing the next tick", () => {
  const lifecycle = createRequestLifecycle();
  const req = beginRequest(lifecycle, 0);
  req.finallyBlock();
  assert.equal(tick(lifecycle, TITLE_POLL_MS).poll, true);
});

test("an aborted request stops suppressing polls without waiting for finally", () => {
  const lifecycle = createRequestLifecycle();
  const req = beginRequest(lifecycle, 0);
  req.cleanup();
  assert.equal(lifecycle.outstanding(), null);
});

test("a superseded request's finally cannot release its replacement", () => {
  const lifecycle = createRequestLifecycle();
  const first = beginRequest(lifecycle, 0);
  first.cleanup();
  const second = beginRequest(lifecycle, 100);
  // The aborted fetch rejects late, after the replacement is already running.
  first.finallyBlock();
  assert.equal(lifecycle.outstanding()?.generation, second.generation);
});

test("Strict Mode's double effect invocation leaves exactly one owner", () => {
  const lifecycle = createRequestLifecycle();
  // React 19 Strict Mode: run effect, run cleanup, run effect again.
  const first = beginRequest(lifecycle, 0);
  first.cleanup();
  const second = beginRequest(lifecycle, 0);
  first.finallyBlock();
  assert.equal(lifecycle.outstanding()?.generation, second.generation);
});

test("a stale request's finally cannot reset the deadline growth", () => {
  const lifecycle = createRequestLifecycle();
  const first = beginRequest(lifecycle, 0);
  tick(lifecycle, FIRST_LOAD_REQUEST_DEADLINE_MS);
  first.cleanup();
  beginRequest(lifecycle, FIRST_LOAD_REQUEST_DEADLINE_MS);
  first.finallyBlock();
  assert.equal(lifecycle.timeoutStreak(), 1);
});

test("a first load is given a materially more patient deadline", () => {
  const lifecycle = createRequestLifecycle();
  assert.equal(
    lifecycle.deadlineMs(TITLE_POLL_MS),
    FIRST_LOAD_REQUEST_DEADLINE_MS,
  );
});

test("a 20s first response on the 2.5s poll is never aborted", () => {
  const lifecycle = createRequestLifecycle();
  const req = beginRequest(lifecycle, 0);
  for (let now = TITLE_POLL_MS; now <= 20_000; now += TITLE_POLL_MS) {
    assert.equal(tick(lifecycle, now).poll, false, `polled at ${now}ms`);
  }
  req.finallyBlock();
  assert.equal(req.isAborted(), false);
});

test("a settled request resets the deadline to the cadence-derived one", () => {
  const lifecycle = createRequestLifecycle();
  const first = beginRequest(lifecycle, 0);
  first.finallyBlock();
  assert.equal(lifecycle.deadlineMs(TITLE_POLL_MS), MIN_REQUEST_DEADLINE_MS);
});

test("consecutive deadline replacements double the deadline each time", () => {
  const lifecycle = createRequestLifecycle();
  const first = beginRequest(lifecycle, 0);
  first.finallyBlock(); // no longer a first load
  const deadlines: number[] = [];

  let now = 0;
  for (let round = 0; round < 3; round += 1) {
    const deadline = lifecycle.deadlineMs(TITLE_POLL_MS);
    deadlines.push(deadline);
    const req = beginRequest(lifecycle, now);
    now += deadline;
    assert.equal(tick(lifecycle, now).poll, true);
    req.cleanup();
  }

  assert.deepEqual(deadlines, [
    MIN_REQUEST_DEADLINE_MS,
    MIN_REQUEST_DEADLINE_MS * 2,
    MIN_REQUEST_DEADLINE_MS * 4,
  ]);
});

test("two ticks before the replacement commits only count one timeout", () => {
  const lifecycle = createRequestLifecycle();
  const first = beginRequest(lifecycle, 0);
  first.finallyBlock();
  beginRequest(lifecycle, 0);
  tick(lifecycle, MIN_REQUEST_DEADLINE_MS);
  tick(lifecycle, MIN_REQUEST_DEADLINE_MS + TITLE_POLL_MS);
  assert.equal(lifecycle.timeoutStreak(), 1);
});

test("a normally settled request resets the timeout streak", () => {
  const lifecycle = createRequestLifecycle();
  const stuck = beginRequest(lifecycle, 0);
  tick(lifecycle, FIRST_LOAD_REQUEST_DEADLINE_MS);
  stuck.cleanup();
  const good = beginRequest(lifecycle, FIRST_LOAD_REQUEST_DEADLINE_MS);
  good.finallyBlock();
  assert.equal(lifecycle.timeoutStreak(), 0);
});

test("deadline growth saturates so a black-holed request stays recoverable", () => {
  assert.equal(
    requestDeadlineMs(TITLE_POLL_MS, { timeoutStreak: 99 }),
    MAX_ADAPTIVE_REQUEST_DEADLINE_MS,
  );
});

test("useApiQuery wires the request lifecycle rather than a bare flag", () => {
  const source = readFileSync(
    new URL("./use-api-query.ts", import.meta.url),
    "utf8",
  );
  for (const call of [
    "createRequestLifecycle()",
    "lifecycle.begin(",
    "lifecycle.settled(generation)",
    "lifecycle.abandon(generation)",
    "lifecycleRef.current.decide(",
    "lifecycleRef.current.decideVisibilityRefresh(",
  ]) {
    assert.ok(source.includes(call), `hook does not call ${call}`);
  }
  assert.match(
    source,
    /data: dataBelongsToIdentity \? data : null/,
    "data from a previous identity must never flash during navigation",
  );
  assert.match(source, /dataIdentityRef\.current === dataIdentity/);
});

function visibilityReturn(
  lifecycle: ReturnType<typeof createRequestLifecycle>,
  args: { now: number; hiddenForMs: number; missedTick: boolean },
) {
  return lifecycle.decideVisibilityRefresh({
    now: args.now,
    intervalMs: TITLE_POLL_MS,
    hiddenForMs: args.hiddenForMs,
    missedTick: args.missedTick,
  });
}

test("a quick tab flip does not fire an extra request", () => {
  const lifecycle = createRequestLifecycle();
  assert.deepEqual(
    visibilityReturn(lifecycle, { now: 500, hiddenForMs: 500, missedTick: false }),
    { refresh: false, reason: "not-stale" },
  );
});

test("returning to a tab hidden during a young first load does not restart it", () => {
  const lifecycle = createRequestLifecycle();
  const req = beginRequest(lifecycle, 0);
  // Hidden for well over one interval, so the screen is stale by cadence…
  const decision = visibilityReturn(lifecycle, {
    now: 20_000,
    hiddenForMs: 20_000,
    missedTick: false,
  });
  // …but the first load is still inside its 60s deadline and is working.
  assert.deepEqual(decision, { refresh: false, reason: "in-flight" });
  assert.equal(lifecycle.outstanding()?.generation, req.generation);
});

test("a missed tick does not restart an outstanding request", () => {
  const lifecycle = createRequestLifecycle();
  // Ticks dropped while hidden set missedTick, but a request is still running.
  beginRequest(lifecycle, 0);
  assert.deepEqual(
    tick(lifecycle, TITLE_POLL_MS, true),
    { poll: false, reason: "hidden" },
  );
  assert.deepEqual(
    visibilityReturn(lifecycle, { now: 5_000, hiddenForMs: 0, missedTick: true }),
    { refresh: false, reason: "in-flight" },
  );
});

test("a missed tick refreshes immediately when nothing is outstanding", () => {
  const lifecycle = createRequestLifecycle();
  const req = beginRequest(lifecycle, 0);
  req.finallyBlock();
  assert.deepEqual(
    visibilityReturn(lifecycle, { now: 5_000, hiddenForMs: 0, missedTick: true }),
    { refresh: true, reason: null },
  );
});

test("returning to a black-holed request refreshes and counts one timeout", () => {
  const lifecycle = createRequestLifecycle();
  beginRequest(lifecycle, 0);
  const now = FIRST_LOAD_REQUEST_DEADLINE_MS + 1;
  assert.deepEqual(
    visibilityReturn(lifecycle, { now, hiddenForMs: now, missedTick: false }),
    { refresh: true, reason: null },
  );
  assert.equal(lifecycle.timeoutStreak(), 1);
});

test("a non-polling query never refreshes on visibility", () => {
  const lifecycle = createRequestLifecycle();
  assert.deepEqual(
    lifecycle.decideVisibilityRefresh({
      now: 60_000,
      intervalMs: 0,
      hiddenForMs: 60_000,
      missedTick: true,
    }),
    { refresh: false, reason: "not-stale" },
  );
});
