/**
 * Poll-health tests: a failing watchdog must never be silent, and a failing
 * tick must never stop the engine's timer.
 *
 * The empty `.catch(() => {})` this replaces was a live hole: if the foreground
 * poll threw on every tick, stall detection was dead and nothing said so — a
 * symptom indistinguishable from "no stalls happened". These tests pin the two
 * properties that close it: `driveForegroundSwarmWatch` (1) resolves even when
 * the poll throws, so the `void drive()` in the throttle interval can never
 * reject and disturb the timer, and (2) reports the failure through the health
 * reporter, which logs on transition and rate-limits repeats.
 */
import assert from "node:assert/strict";

import {
  driveForegroundSwarmWatch,
  recordSwarmWatchPollOutcome,
  resetSwarmWatchPollHealth,
  swarmWatchConsecutiveFailures,
  POLL_FAILURE_LOG_THROTTLE_MS,
} from "./swarm-delivery-watchdog";

function recorder() {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

async function run() {
  // ── A throwing tick does not reject (so the timer survives) and is reported ─
  {
    resetSwarmWatchPollHealth();
    const rec = recorder();
    let resolved = false;
    await driveForegroundSwarmWatch(
      async () => {
        throw new Error("boom");
      },
      { log: rec.log, now: 0 },
    ).then(() => {
      resolved = true;
    });
    assert.ok(resolved, "drive resolves even when the poll throws — timer is never disturbed");
    assert.equal(rec.lines.length, 1, "the failure was reported, not swallowed");
    assert.match(rec.lines[0], /DOWN/, "first failure is logged loudly");
    assert.equal(swarmWatchConsecutiveFailures(), 1, "the failure was counted");
  }

  // ── An internal `error` verdict counts as a failure too ────────────────
  {
    resetSwarmWatchPollHealth();
    const rec = recorder();
    await driveForegroundSwarmWatch(async () => ({ active: true, reason: "error" }), {
      log: rec.log,
      now: 0,
    });
    assert.equal(rec.lines.length, 1, "an error verdict is reported");
    assert.equal(swarmWatchConsecutiveFailures(), 1, "an error verdict is counted");
  }

  // ── A normal outcome is silent and healthy ─────────────────────────────
  {
    resetSwarmWatchPollHealth();
    const rec = recorder();
    await driveForegroundSwarmWatch(async () => ({ active: false }), { log: rec.log, now: 0 });
    assert.equal(rec.lines.length, 0, "a working poll logs nothing — silence means working");
    assert.equal(swarmWatchConsecutiveFailures(), 0, "no failures counted");
  }

  // ── Repeated failures: log once, then rate-limit, then log recovery ────
  {
    resetSwarmWatchPollHealth();
    const rec = recorder();

    const t0 = 1_000_000;
    const first = recordSwarmWatchPollOutcome(false, new Error("x"), { log: rec.log, now: t0 });
    assert.equal(first.transition, "failing", "first failure transitions into failing");
    assert.equal(first.logged, true, "first failure logs");

    // Within the throttle window: still failing, but silent.
    const soon = recordSwarmWatchPollOutcome(false, new Error("x"), {
      log: rec.log,
      now: t0 + POLL_FAILURE_LOG_THROTTLE_MS - 1,
    });
    assert.equal(soon.transition, "failing-silent", "a repeat inside the window is not re-logged");
    assert.equal(soon.logged, false, "no log spam inside the throttle window");

    // Past the throttle window: logged again, with the running count.
    const later = recordSwarmWatchPollOutcome(false, new Error("x"), {
      log: rec.log,
      now: t0 + POLL_FAILURE_LOG_THROTTLE_MS,
    });
    assert.equal(later.transition, "failing-throttled", "a repeat past the window is re-logged");
    assert.equal(later.logged, true, "the persistent failure is surfaced again, not lost");
    assert.equal(swarmWatchConsecutiveFailures(), 3, "all three failures counted");

    // Recovery is announced and resets the state.
    const ok = recordSwarmWatchPollOutcome(true, undefined, { log: rec.log, now: t0 + 999_999 });
    assert.equal(ok.transition, "recovered", "a success after failures transitions to recovered");
    assert.equal(ok.logged, true, "recovery is logged so an operator can see it come back");
    assert.match(rec.lines.at(-1)!, /recovered/, "recovery line names the recovery");
    assert.equal(swarmWatchConsecutiveFailures(), 0, "recovery resets the failure count");

    // A subsequent success is silent again.
    const quiet = recordSwarmWatchPollOutcome(true, undefined, { log: rec.log, now: t0 + 1_000_000 });
    assert.equal(quiet.logged, false, "steady healthy state is silent");
  }

  console.log("swarm-watch-health.test.ts: PASS");
}

run().catch((err) => {
  console.error("swarm-watch-health.test.ts: FAIL");
  console.error(err);
  process.exit(1);
});
