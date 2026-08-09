/**
 * Warm-probe deduplication tests.
 *
 * Warming is speculative, so it must never multiply: two callers asking for the
 * same file at the same time share one run.
 *
 * Run: npx tsx src/lib/media/warm-probe-lock.test.ts
 */
import assert from "node:assert/strict";
import { runWarmProbe, warmProbeKey, warmProbesInFlight } from "./warm-probe-lock";

let failures = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  await check("given the same file, two concurrent warms run the probe once", async () => {
    let runs = 0;
    let release: (value: string) => void = () => {};
    const task = () => {
      runs += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const key = warmProbeKey("ABC", "Pack/S01E02.mkv");
    const first = runWarmProbe(key, task);
    const second = runWarmProbe(key, task);
    assert.equal(runs, 1);
    assert.equal(warmProbesInFlight(), 1);
    release("done");
    assert.equal(await first, "done");
    assert.equal(await second, "done");
    assert.equal(warmProbesInFlight(), 0);
  });

  await check("given different files, warms do not share a run", async () => {
    let runs = 0;
    const task = async () => {
      runs += 1;
      return runs;
    };
    await Promise.all([
      runWarmProbe(warmProbeKey("abc", "a.mkv"), task),
      runWarmProbe(warmProbeKey("abc", "b.mkv"), task),
    ]);
    assert.equal(runs, 2);
  });

  await check("given a settled warm, a later warm of the same file may run again", async () => {
    let runs = 0;
    const key = warmProbeKey("abc", "a.mkv");
    const task = async () => {
      runs += 1;
      return runs;
    };
    await runWarmProbe(key, task);
    await runWarmProbe(key, task);
    assert.equal(runs, 2);
  });

  await check("given a failing warm, the key is released instead of latching", async () => {
    const key = warmProbeKey("abc", "boom.mkv");
    await assert.rejects(runWarmProbe(key, async () => { throw new Error("probe failed"); }));
    assert.equal(warmProbesInFlight(), 0);
    assert.equal(await runWarmProbe(key, async () => "ok"), "ok");
  });

  await check("the key is case-insensitive on the infoHash", () => {
    assert.equal(warmProbeKey("ABC", "a.mkv"), warmProbeKey("abc", "a.mkv"));
  });

  console.log(
    `\n${failures === 0 ? "warm-probe-lock: all tests passed" : `warm-probe-lock: ${failures} failing`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
