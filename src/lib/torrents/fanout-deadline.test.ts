/**
 * The interactive fan-out must not be held hostage by one unreachable source,
 * and automation must keep waiting.
 * Run: npx tsx src/lib/torrents/fanout-deadline.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INTERACTIVE_ADAPTER_DEADLINE_MS,
  withAdapterDeadline,
} from "./aggregator";

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}

async function main() {
  const healthy = await withAdapterDeadline(after(5, ["ok"]), 200, "nyaa");
  assert.deepEqual(healthy, ["ok"], "a source inside the budget is untouched");

  await assert.rejects(
    () => withAdapterDeadline(never<string[]>(), 20, "yts"),
    /yts exceeded the 20ms search budget/,
    "a stalled source is reported by name, not silently empty",
  );

  // Omitting the budget is what automation does: it must keep the previous
  // behaviour of waiting for the adapter's own timeout, because a grab made
  // from a silently narrowed pool is worse than a slow one.
  assert.deepEqual(
    await withAdapterDeadline(after(30, ["late"]), undefined, "apibay"),
    ["late"],
    "without a budget the slow source still contributes",
  );
  assert.deepEqual(
    await withAdapterDeadline(after(30, ["late"]), 0, "apibay"),
    ["late"],
    "a zero budget means 'no deadline', not 'fail immediately'",
  );

  // A source that loses the race must not crash the process later.
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  const doomed = new Promise<string[]>((_resolve, reject) =>
    setTimeout(() => reject(new Error("mirror died")), 10),
  );
  await assert.rejects(() => withAdapterDeadline(doomed, 1, "torrentscsv"));
  await after(40, null);
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(
    unhandled,
    null,
    "the losing adapter's failure must not become an unhandled rejection",
  );

  assert.ok(
    INTERACTIVE_ADAPTER_DEADLINE_MS > 3000 &&
      INTERACTIVE_ADAPTER_DEADLINE_MS < 12_000,
    "the interactive budget sits above every healthy source and below one dead mirror",
  );

  // A pool narrowed by the interactive deadline shares its cache key with
  // automation's searches, so it must never be written to the search cache.
  const aggregatorSource = readFileSync(
    fileURLToPath(new URL("./aggregator.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    aggregatorSource,
    /outcome\.reason instanceof AdapterDeadlineError\) truncatedByDeadline = true/,
    "a deadline miss marks the pool as truncated",
  );
  assert.match(
    aggregatorSource,
    /if \(!truncatedByDeadline\) void setSearchCache\(/,
    "a truncated pool is not cached for callers without a deadline",
  );

  console.log("fanout-deadline.test.ts: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
