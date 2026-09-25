import assert from "node:assert/strict";

import {
  createAdmissionControl,
  createCoalescingRunner,
  shouldParkOnResume,
  shouldQueueNewDownload,
  type QueueRow,
} from "./download-queue";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (hash: string, status: string): QueueRow => ({
  hash,
  status,
  origin: "user",
  createdAt: new Date(0),
});

async function concurrentFreshAddsRespectCap() {
  // Mirrors BuiltinClient.addTorrent: gate + reserve under the lock, the row
  // only written after a (slow) metadata wait, reservation released after.
  const admission = createAdmissionControl();
  const db: QueueRow[] = [];
  let live = 0;
  let peak = 0;
  const add = async (hash: string, failMetadata = false) => {
    const queued = await admission.withLock("u", async () => {
      await wait(1); // the DB read
      const rows = [...db];
      if (
        shouldQueueNewDownload({
          rows,
          cap: 2,
          origin: "user",
          pending: admission.pendingCount("u", rows),
        })
      ) {
        db.push(row(hash, "queued"));
        return true;
      }
      admission.reserve("u", hash);
      return false;
    });
    if (queued) return "queued";
    live++;
    peak = Math.max(peak, live);
    try {
      await wait(20); // metadata
      if (failMetadata) throw new Error("metadata timeout");
      db.push(row(hash, "downloading"));
      admission.release("u", hash);
      return "started";
    } catch {
      live--;
      return "failed";
    } finally {
      admission.release("u", hash);
    }
  };
  const results = await Promise.all(["e1", "e2", "e3", "e4"].map((h) => add(h)));
  assert.deepEqual(results.filter((r) => r === "started").length, 2);
  assert.deepEqual(results.filter((r) => r === "queued").length, 2);
  assert.ok(peak <= 2, `peak ${peak} exceeded cap`);

  // A failed add releases its reservation so the slot is usable again.
  const a2 = createAdmissionControl();
  a2.reserve("u", "x");
  assert.equal(a2.pendingCount("u", []), 1);
  a2.release("u", "x");
  assert.equal(a2.pendingCount("u", []), 0);
  // A reservation already visible as an active row is not double counted.
  a2.reserve("u", "y");
  assert.equal(a2.pendingCount("u", [row("y", "downloading")]), 0);
  console.log("PASS concurrent fresh adds never exceed the cap");
}

async function lockSerializes() {
  const admission = createAdmissionControl();
  const order: string[] = [];
  await Promise.all([
    admission.withLock("u", async () => {
      order.push("a+");
      await wait(10);
      order.push("a-");
    }),
    admission.withLock("u", async () => {
      order.push("b+");
      order.push("b-");
    }),
  ]);
  assert.deepEqual(order, ["a+", "a-", "b+", "b-"]);
  // A throwing holder still releases the lock.
  await admission.withLock("u", async () => {
    throw new Error("x");
  }).catch(() => undefined);
  assert.equal(await admission.withLock("u", async () => 7), 7);
  console.log("PASS admission lock serializes and survives throws");
}

async function promotionRequestsAreNotDropped() {
  let passes = 0;
  let queue = ["q1", "q2", "q3"];
  let free = 1;
  const run = createCoalescingRunner(async () => {
    passes++;
    const slots = free;
    free = 0;
    await wait(10);
    const take = queue.slice(0, slots);
    queue = queue.slice(slots);
    return take;
  });
  const first = run("u");
  // Two slots free while the first pass is running.
  await wait(2);
  free = 2;
  const second = run("u");
  const third = run("u");
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(passes, 2, "one rerun for requests arriving mid-pass");
  assert.deepEqual(a, ["q1", "q2", "q3"]);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  // A failing pass (e.g. a failed start retrying) still reruns when asked.
  let calls = 0;
  const flaky = createCoalescingRunner(async () => {
    calls++;
    if (calls === 1) {
      void flaky("u"); // the retry fired from inside a failing pass
      throw new Error("boom");
    }
    return ["ok"];
  });
  assert.deepEqual(await flaky("u"), ["ok"]);
  assert.equal(calls, 2);
  console.log("PASS promotion requests during a pass trigger another pass");
}

function resumeRespectsCap() {
  const rows = [row("a", "downloading"), row("b", "downloading"), row("p", "paused")];
  assert.equal(shouldParkOnResume({ rows, cap: 2, hash: "p" }), true);
  assert.equal(shouldParkOnResume({ rows, cap: 3, hash: "p" }), false);
  assert.equal(
    shouldParkOnResume({ rows: [row("a", "downloading")], cap: 2, hash: "p", pending: 1 }),
    true,
  );
  // The resumed row itself never counts against itself.
  assert.equal(
    shouldParkOnResume({ rows: [row("p", "downloading")], cap: 1, hash: "P" }),
    false,
  );
  console.log("PASS resuming a live paused torrent is admitted through the cap");
}

(async () => {
  await concurrentFreshAddsRespectCap();
  await lockSerializes();
  await promotionRequestsAreNotDropped();
  resumeRespectsCap();
})().catch((err) => {
  console.error("FAIL download queue admission", err);
  process.exit(1);
});
