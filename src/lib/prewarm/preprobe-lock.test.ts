import assert from "node:assert/strict";
import { tryAcquirePreProbeLease, tryRunPreProbePass } from "./preprobe-lock";

async function main() {
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let runs = 0;
  const first = tryRunPreProbePass("same-user", async () => {
    runs += 1;
    await blocked;
    return "done";
  });
  await Promise.resolve();
  const second = await tryRunPreProbePass("same-user", async () => {
    runs += 1;
    return "should-not-run";
  });
  assert.deepEqual(second, { started: false });
  assert.equal(runs, 1, "concurrent calls for one user run only one pass");

  const other = await tryRunPreProbePass("other-user", async () => "independent");
  assert.deepEqual(other, { started: true, value: "independent" });
  unblock?.();
  assert.deepEqual(await first, { started: true, value: "done" });

  await assert.rejects(
    tryRunPreProbePass("throwing-user", async () => {
      throw new Error("probe failed");
    }),
    /probe failed/,
  );
  const afterFailure = tryAcquirePreProbeLease("throwing-user");
  assert.ok(afterFailure, "a thrown pass releases its lease");
  afterFailure?.();

  console.log("preprobe-lock.test.ts: all assertions passed");
}

void main();
