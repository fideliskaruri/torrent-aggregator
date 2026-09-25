/**
 * Concurrent identical work must collapse onto one promise — and must stop
 * being shared the moment it settles.
 * Run: npx tsx src/lib/cache/single-flight.test.ts
 */
import assert from "node:assert/strict";
import { createSingleFlight } from "./single-flight";

async function main() {
  const flight = createSingleFlight<number>();
  let runs = 0;

  const work = () =>
    new Promise<number>((resolve) => {
      runs += 1;
      setTimeout(() => resolve(runs), 10);
    });

  const [a, b, c] = await Promise.all([
    flight.run("same", work),
    flight.run("same", work),
    flight.run("same", work),
  ]);
  assert.equal(runs, 1, "three concurrent callers must share one execution");
  assert.deepEqual([a, b, c], [1, 1, 1], "every caller sees the same answer");
  assert.equal(flight.size, 0, "settled entries are released");

  await flight.run("same", work);
  assert.equal(runs, 2, "it is a concurrency device, never a result cache");

  await Promise.all([flight.run("x", work), flight.run("y", work)]);
  assert.equal(runs, 4, "different keys must not be shared");

  // Failures are shared by the concurrent callers but never remembered.
  let failures = 0;
  const failing = () => {
    failures += 1;
    return Promise.reject(new Error("upstream down"));
  };
  const settled = await Promise.allSettled([
    flight.run("bad", failing),
    flight.run("bad", failing),
  ]);
  assert.equal(failures, 1, "concurrent callers share one failed attempt");
  assert.deepEqual(
    settled.map((r) => r.status),
    ["rejected", "rejected"],
    "both callers see the failure",
  );
  await assert.rejects(
    () => flight.run("bad", failing),
    /upstream down/,
    "a later caller retries rather than inheriting a dead promise",
  );
  assert.equal(failures, 2, "a failure is not cached");

  // A synchronously thrown error must be reported through the promise, and
  // must not leave the key pinned.
  await assert.rejects(
    () =>
      flight.run("sync-throw", () => {
        throw new Error("bad input");
      }),
    /bad input/,
  );
  assert.equal(flight.size, 0, "a synchronous throw releases the key");

  console.log("single-flight.test.ts: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
