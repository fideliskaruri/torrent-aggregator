/**
 * Pre-probe scheduler tests.
 *
 * WHAT THESE ARE GUARDING
 * -----------------------
 * The scheduler exists because the pre-probe was wired to a route action nothing
 * ever sends — a capability nothing invokes. These assert the tick's decisions
 * with every dependency injected, so no swarm, DB, or real timer is touched:
 *
 *   - `off` scope does nothing (the user's explicit opt-out) and reschedules on
 *     the disabled-poll cadence.
 *   - a foreground stream skips the *entire* pass — no rank, no probe — and
 *     retries soon so probing resumes shortly after playback ends.
 *   - an idle, in-scope tick runs rank *then* probe and reschedules on the
 *     steady cadence.
 *   - a throwing pass reschedules rather than propagating, so one bad run never
 *     kills the timer.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/prewarm/preprobe-scheduler.test.ts
 */
import assert from "node:assert/strict";
import {
  runPreProbeTick,
  PREPROBE_INTERVAL_MS,
  PREPROBE_FOREGROUND_RETRY_MS,
  PREPROBE_DISABLED_POLL_MS,
  type PreProbeTickDeps,
} from "./preprobe-scheduler";
import type { PreProbeResult, PreProbeScope } from "./preprobe";

let failures = 0;

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function emptyResult(scope: PreProbeScope): PreProbeResult {
  return {
    scope,
    probed: [],
    skippedFresh: [],
    skippedLive: [],
    capped: false,
    verdicts: {},
  };
}

/** A deps bundle that records what got called. */
function harness(over: Partial<PreProbeTickDeps> & { scope: PreProbeScope; foreground: boolean }) {
  const calls = { preRank: 0, preProbe: 0 };
  const deps: PreProbeTickDeps = {
    userId: "local",
    resolveScope: async () => over.scope,
    isForeground: () => over.foreground,
    preRank: async () => {
      calls.preRank += 1;
    },
    preProbe: async () => {
      calls.preProbe += 1;
      return emptyResult(over.scope);
    },
    ...over,
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  console.log("pre-probe scheduler\n");

  await checkAsync("scope off does nothing and polls again later", async () => {
    // RED check: if the tick ran the pass regardless of scope, preProbe would be
    // called and the delay would be the steady interval, not the disabled poll.
    const { deps, calls } = harness({ scope: "off", foreground: false });
    const o = await runPreProbeTick(deps);
    assert.equal(calls.preRank, 0, "off must not rank");
    assert.equal(calls.preProbe, 0, "off must not probe");
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "off");
    assert.equal(o.delayMs, PREPROBE_DISABLED_POLL_MS);
  });

  await checkAsync("a foreground stream skips the whole pass", async () => {
    // RED check: dropping the foreground guard would let a viewer's playback be
    // raced by speculative ranking and probing — the one thing this must never do.
    const { deps, calls } = harness({ scope: "monitored", foreground: true });
    const o = await runPreProbeTick(deps);
    assert.equal(calls.preRank, 0, "must not rank while watching");
    assert.equal(calls.preProbe, 0, "must not probe while watching");
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "foreground");
    assert.equal(o.delayMs, PREPROBE_FOREGROUND_RETRY_MS);
  });

  await checkAsync("an idle in-scope tick ranks then probes", async () => {
    // RED check: if the tick probed without ranking first, preRank would be 0 and
    // the probe would measure a cold pool.
    const order: string[] = [];
    let ranks = 0;
    let probes = 0;
    const deps: PreProbeTickDeps = {
      userId: "local",
      resolveScope: async () => "monitored",
      isForeground: () => false,
      preRank: async () => {
        ranks += 1;
        order.push("rank");
      },
      preProbe: async () => {
        probes += 1;
        order.push("probe");
        return emptyResult("monitored");
      },
    };
    const o = await runPreProbeTick(deps);
    assert.equal(ranks, 1);
    assert.equal(probes, 1);
    assert.deepEqual(order, ["rank", "probe"], "must rank before probing");
    assert.equal(o.ran, true);
    assert.equal(o.delayMs, PREPROBE_INTERVAL_MS);
  });

  await checkAsync("playback starting during ranking cancels before probing", async () => {
    let foreground = false;
    let probes = 0;
    const deps: PreProbeTickDeps = {
      userId: "foreground-after-rank",
      resolveScope: async () => "monitored",
      isForeground: () => foreground,
      preRank: async () => {
        foreground = true;
      },
      preProbe: async () => {
        probes += 1;
        return emptyResult("monitored");
      },
    };
    const outcome = await runPreProbeTick(deps);
    assert.equal(probes, 0, "a pass must yield between ranking and probing");
    assert.equal(outcome.skipped, "foreground");
    assert.equal(outcome.delayMs, PREPROBE_FOREGROUND_RETRY_MS);
  });

  await checkAsync("playback starting inside probing retries soon", async () => {
    const { deps } = harness({
      scope: "monitored",
      foreground: false,
      preProbe: async () => ({
        ...emptyResult("monitored"),
        skipped: "foreground",
      }),
    });
    const outcome = await runPreProbeTick(deps);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.skipped, "foreground");
    assert.equal(outcome.delayMs, PREPROBE_FOREGROUND_RETRY_MS);
  });

  await checkAsync("a throwing pass reschedules instead of propagating", async () => {
    // RED check: without the try/catch the rejection would escape and the
    // self-scheduling `.then(schedule)` chain would never re-arm the timer.
    const deps: PreProbeTickDeps = {
      userId: "local",
      resolveScope: async () => "monitored",
      isForeground: () => false,
      preRank: async () => {
        throw new Error("indexer down");
      },
      preProbe: async () => emptyResult("monitored"),
    };
    const o = await runPreProbeTick(deps);
    assert.equal(o.ran, false);
    assert.equal(o.delayMs, PREPROBE_INTERVAL_MS, "a failed pass still reschedules on the steady cadence");
  });

  await checkAsync("a settings-read error backs off rather than crashing", async () => {
    // RED check: an unguarded scope read would reject out of the tick and stall
    // the timer; instead it must return the disabled-poll delay.
    const deps: PreProbeTickDeps = {
      userId: "local",
      resolveScope: async () => {
        throw new Error("db locked");
      },
      isForeground: () => false,
      preRank: async () => {},
      preProbe: async () => emptyResult("monitored"),
    };
    const o = await runPreProbeTick(deps);
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "settings-error");
    assert.equal(o.delayMs, PREPROBE_DISABLED_POLL_MS);
  });

  console.log(
    failures === 0
      ? "\nPASS — pre-probe scheduler runs on a cadence and yields to viewers"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
