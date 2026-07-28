/**
 * Seek-coalescing proof for the HLS session-restart path (the "3-click" bug).
 *
 * A forward seek past the produced window in HLS mode respawns ffmpeg, which
 * takes a moment. The old code guarded that respawn with a boolean and *dropped*
 * any seek arriving while it was busy, so a viewer had to press three times: the
 * first started a restart, the second was silently discarded, the third worked.
 *
 * This probe is deliberately browser-free and deterministic. It re-creates the
 * exact ref state machine from `inline-player.tsx` — `seekInFlightRef`,
 * `seekPlanTargetRef`, `pendingSeekRef`, a per-plan `AbortController`, and the
 * plan effect's `finally` guard — and drives it with the *real* exported
 * `nextSeekRestartAction` decision. It then simulates: forward-seek past the
 * window, a SECOND forward-seek 200ms later while the first restart is in
 * flight, and asserts the player settles at the SECOND target (not the first,
 * not the old position) with no dropped gesture — one user intent, no 3-click.
 *
 * Run:
 *   node node_modules\tsx\dist\cli.mjs scripts\probes\player-seek-coalesce.mts
 */
import assert from "node:assert/strict";

import { nextSeekRestartAction } from "../../src/components/watch/inline-player";

const SEEK_TOLERANCE_SECONDS = 2;

type Plan = {
  nonce: number;
  startSec: number;
  aborted: boolean;
  abort: () => void;
  settle: () => void;
};

/**
 * A faithful stand-in for the player's HLS seek machinery. Mirrors the refs and
 * the plan effect (AbortController + guarded `finally`) 1:1 with the component.
 */
function makePlayer() {
  const state = {
    seekInFlight: false,
    seekPlanTarget: null as number | null,
    pending: 0,
    nonce: 0,
    /** Set only when a plan actually settles (not when aborted). */
    settledTarget: null as number | null,
    plansStarted: 0,
    plansAborted: 0,
    dropped: 0,
  };
  let current: Plan | null = null;

  // The plan effect: aborts the previous controller, captures `pending` as its
  // startSec, and only clears the in-flight flag when it settles unaborted.
  function runPlan() {
    if (current) {
      current.abort();
    }
    const plan: Plan = {
      nonce: state.nonce,
      startSec: state.pending,
      aborted: false,
      abort() {
        this.aborted = true;
      },
      settle() {},
    };
    plan.abort = () => {
      plan.aborted = true;
      state.plansAborted += 1;
    };
    plan.settle = () => {
      // The plan effect `finally`: a plan aborted by a newer seek must leave the
      // in-flight flag set so the replacement plan stays owned.
      if (!plan.aborted) {
        state.seekInFlight = false;
        state.seekPlanTarget = null;
        state.settledTarget = plan.startSec;
      }
    };
    state.plansStarted += 1;
    current = plan;
    return plan;
  }

  // seekToSource: coalesce instead of drop.
  function seekToSource(target: number): Plan | null {
    const decision = nextSeekRestartAction(
      {
        inFlight: state.seekInFlight,
        inFlightTargetSec: state.seekPlanTarget,
        requestedTargetSec: target,
      },
      SEEK_TOLERANCE_SECONDS,
    );
    if (decision === "ignore") {
      state.dropped += 1;
      return null;
    }
    state.seekInFlight = true;
    state.seekPlanTarget = target;
    state.pending = target;
    state.nonce += 1;
    return runPlan();
  }

  return { state, seekToSource };
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  \u2717 ${name}: ${(err as Error).message}`);
  }
}

// Scenario 1 — the reported bug: two forward seeks, the second while the first
// restart is still in flight. The second must win with no dropped gesture.
check("second forward-seek 200ms later wins; first plan is aborted, none dropped", () => {
  const { state, seekToSource } = makePlayer();

  // t=0: forward-seek past produced window (e.g. from 30s to 180s).
  const plan1 = seekToSource(180);
  assert.ok(plan1, "first seek must start a plan");
  assert.equal(state.seekInFlight, true);
  assert.equal(state.seekPlanTarget, 180);

  // t=200ms: a SECOND forward-seek (to 300s) arrives while plan1 is in flight.
  const plan2 = seekToSource(300);
  assert.ok(plan2, "second seek must NOT be dropped — it should replan");
  assert.equal(state.dropped, 0, "no seek may be silently discarded");
  assert.equal(plan1!.aborted, true, "the stale plan1 must be aborted");
  assert.equal(state.seekPlanTarget, 300, "the newest target must own the restart");
  assert.equal(state.pending, 300);

  // The aborted plan1 completes late — its guarded finally must NOT release the
  // in-flight flag that plan2 now owns.
  plan1!.settle();
  assert.equal(state.seekInFlight, true, "aborted plan1 must not clear the in-flight flag");
  assert.equal(state.settledTarget, null, "an aborted plan never settles a target");

  // plan2 settles: the player lands on the SECOND target.
  plan2!.settle();
  assert.equal(state.settledTarget, 300, "the player must end at the second target, not the first or old position");
  assert.equal(state.seekInFlight, false);
  assert.equal(state.plansStarted, 2, "exactly one plan per distinct target");
});

// Scenario 2 — a repeat of the in-flight target must not thrash ffmpeg.
check("a duplicate seek to the in-flight target is coalesced (no extra plan)", () => {
  const { state, seekToSource } = makePlayer();
  const plan1 = seekToSource(180);
  const repeat = seekToSource(181); // within tolerance of the in-flight target
  assert.equal(repeat, null, "the duplicate must be ignored");
  assert.equal(state.plansStarted, 1, "no second plan for the same target");
  plan1!.settle();
  assert.equal(state.settledTarget, 180);
});

// Scenario 3 — a fresh seek after the previous one settled starts cleanly.
check("a seek after settle starts a fresh plan (flag was released)", () => {
  const { state, seekToSource } = makePlayer();
  seekToSource(180)!.settle();
  assert.equal(state.seekInFlight, false);
  const plan2 = seekToSource(360);
  assert.ok(plan2, "a later seek must start once the previous plan settled");
  assert.equal(state.seekPlanTarget, 360);
  plan2!.settle();
  assert.equal(state.settledTarget, 360);
  assert.equal(state.dropped, 0);
});

if (failures > 0) {
  console.error(`\n${failures} seek-coalesce probe check(s) failed`);
  process.exit(1);
}
console.log("\nSeek-coalesce probe passed: the last seek wins, no dropped clicks, no 3-click.");
