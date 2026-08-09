import assert from "node:assert/strict";
import { createSnapshotScheduler } from "./snapshot-scheduler";

type Timer = { callback: () => void; delay: number; cancelled: boolean };

let now = 10_000;
const timers: Timer[] = [];
const writes: number[] = [];
const releaseWrites: Array<() => void> = [];
let activeWrites = 0;
let maxActiveWrites = 0;

const scheduler = createSnapshotScheduler<string, number>({
  intervalMs: 5_000,
  now: () => now,
  setTimer: (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  },
  clearTimer: (timer) => {
    (timer as unknown as Timer).cancelled = true;
  },
  persist: async (_key, value) => {
    writes.push(value);
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await new Promise<void>((resolve) => {
      releaseWrites.push(resolve);
    });
    activeWrites -= 1;
  },
});

async function main() {
  for (let value = 1; value <= 100; value += 1) {
    scheduler.schedule("torrent", value);
  }
  assert.equal(timers.length, 1, "a burst schedules one timer");
  assert.equal(timers[0].delay, 0, "the first snapshot may persist immediately");

  timers[0].callback();
  await Promise.resolve();
  assert.deepEqual(writes, [100], "the latest burst value wins");

  for (let value = 101; value <= 200; value += 1) {
    scheduler.schedule("torrent", value);
  }
  assert.equal(timers.length, 1, "no overlapping timer while a write is active");
  assert.equal(maxActiveWrites, 1);

  releaseWrites.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.length, 2, "one follow-up is scheduled after the write");
  assert.equal(timers[1].delay, 5_000, "follow-up respects the throttle");

  now += 5_000;
  timers[1].callback();
  await Promise.resolve();
  assert.deepEqual(writes, [100, 200], "follow-up also uses the latest value");
  assert.equal(maxActiveWrites, 1, "writes remain single-flight");

  releaseWrites.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler.size(), 0);

  scheduler.schedule("cancelled", 1);
  assert.equal(scheduler.size(), 1);
  await scheduler.cancelAndDrain("cancelled");
  assert.equal(scheduler.size(), 0);
  assert.equal(timers.at(-1)?.cancelled, true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
