/**
 * Retention sweep scheduler tests.
 *
 * These assert the invocation layer, not the destructive sweep itself:
 *   - under budget only previews and never deletes,
 *   - foreground playback skips the whole pass,
 *   - over-budget preview triggers the delete pass,
 *   - a throw in one pass returns a next delay rather than killing the loop.
 *
 * Run: node node_modules/tsx/dist/cli.mjs src/lib/library/retention-sweep-scheduler.test.ts
 */
import assert from "node:assert/strict";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { RETENTION_POLICY_EPHEMERAL } from "./retention-settings";
import {
  RETENTION_SWEEP_DISABLED_POLL_MS,
  RETENTION_SWEEP_FOREGROUND_RETRY_MS,
  RETENTION_SWEEP_INTERVAL_MS,
  runRetentionSweepTick,
  type RetentionSweepTickDeps,
} from "./retention-sweep-scheduler";
import type { RetentionSweepResult } from "./retention-sweep";

const config = {
  clientType: "builtin",
  host: "",
  maxStorageBytes: 100,
} as ClientConnectionConfig;
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

function result(over: Partial<RetentionSweepResult>): RetentionSweepResult {
  return {
    mode: over.mode ?? "preview",
    budgetBytes: over.budgetBytes ?? 20,
    usedBytes: over.usedBytes ?? 10,
    targetBytes: over.targetBytes ?? 0,
    reclaimedBytes: over.reclaimedBytes ?? 0,
    satisfied: over.satisfied ?? true,
    scanned: over.scanned ?? 0,
    wouldDelete: over.wouldDelete ?? [],
    deleted: over.deleted ?? [],
    skipped: over.skipped ?? [],
  };
}

function harness(over: Partial<RetentionSweepTickDeps> = {}) {
  const calls: Array<"preview" | "delete"> = [];
  const logs: string[] = [];
  const deps: RetentionSweepTickDeps = {
    userId: "local",
    isForeground: () => false,
    getConfig: async () => config,
    sweep: async ({ mode }) => {
      calls.push(mode);
      return mode === "preview"
        ? result({ mode: "preview", usedBytes: 10, budgetBytes: 20, satisfied: true })
        : result({ mode: "delete", usedBytes: 30, budgetBytes: 20, reclaimedBytes: 10, satisfied: true });
    },
    log: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    },
    ...over,
  };
  return { deps, calls, logs };
}

async function main(): Promise<void> {
  console.log("retention sweep scheduler\n");

  await checkAsync("under budget previews only and never deletes", async () => {
    // RED check: if the tick ran delete regardless of budget pressure, `calls`
    // would contain both preview and delete.
    const { deps, calls } = harness();
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, ["preview"]);
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "under-budget");
    assert.equal(o.delayMs, RETENTION_SWEEP_INTERVAL_MS);
  });

  await checkAsync("an unset storage cap disables automatic deletion", async () => {
    const { deps, calls } = harness({
      getConfig: async () => ({ ...config, maxStorageBytes: null }),
    });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, []);
    assert.equal(o.skipped, "unconfigured");
    assert.equal(o.delayMs, RETENTION_SWEEP_DISABLED_POLL_MS);
  });

  await checkAsync("foreground playback skips the whole pass", async () => {
    // RED check: dropping the foreground guard would call preview/delete while a
    // viewer is active, competing with playback.
    const { deps, calls } = harness({ isForeground: () => true });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, []);
    assert.equal(o.skipped, "foreground");
    assert.equal(o.delayMs, RETENTION_SWEEP_FOREGROUND_RETRY_MS);
  });

  await checkAsync("over budget preview triggers deletion and logs the result", async () => {
    // RED check: a capability-only scheduler would stop after preview; the delete
    // call proves the over-budget path actually invokes reclamation.
    const { deps, calls, logs } = harness({
      sweep: async ({ mode }) => {
        calls.push(mode);
        return mode === "preview"
          ? result({ mode, usedBytes: 30, budgetBytes: 20, targetBytes: 10, satisfied: false })
          : result({
              mode,
              usedBytes: 30,
              budgetBytes: 20,
              targetBytes: 10,
              reclaimedBytes: 10,
              satisfied: true,
              deleted: [
                {
                  id: "1",
                  hash: "abc",
                  name: "Old stream",
                  origin: "stream",
                  retentionPolicy: RETENTION_POLICY_EPHEMERAL,
                  sizeBytes: 10,
                  onDiskBytes: 10,
                  progress: 1,
                  status: "seeding",
                  kind: "watched",
                  lastUsedAt: new Date(0),
                  completedAt: new Date(0),
                  fullyWatched: true,
                },
              ],
              skipped: [{ hash: "def", reason: "watchlisted" }],
            });
      },
    });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, ["preview", "delete"]);
    assert.equal(o.ran, true);
    assert.equal(o.result?.reclaimedBytes, 10);
    assert.ok(logs.some((line) => line.includes("reclaimed 10 bytes")));
    assert.ok(logs.some((line) => line.includes("watchlisted=1")));
  });

  await checkAsync("foreground that starts after preview prevents deletion", async () => {
    let foreground = false;
    const { deps, calls } = harness({
      isForeground: () => foreground,
      sweep: async ({ mode }) => {
        calls.push(mode);
        if (mode === "preview") {
          foreground = true;
          return result({ mode, usedBytes: 30, budgetBytes: 20, satisfied: false });
        }
        return result({ mode, usedBytes: 30, budgetBytes: 20, reclaimedBytes: 10 });
      },
    });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, ["preview"]);
    assert.equal(o.skipped, "foreground");
    assert.equal(o.delayMs, RETENTION_SWEEP_FOREGROUND_RETRY_MS);
  });

  await checkAsync("a throwing pass reschedules instead of propagating", async () => {
    // RED check: without try/catch this rejection would escape the scheduler's
    // `.then(schedule)` chain and future passes would never be armed.
    const { deps, calls } = harness({
      sweep: async ({ mode }) => {
        calls.push(mode);
        throw new Error("disk temporarily unavailable");
      },
    });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, ["preview"]);
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "preview-error");
    assert.equal(o.delayMs, RETENTION_SWEEP_INTERVAL_MS);
  });

  await checkAsync("a delete-pass throw also reschedules", async () => {
    const { deps, calls } = harness({
      sweep: async ({ mode }) => {
        calls.push(mode);
        if (mode === "preview") {
          return result({ mode, usedBytes: 30, budgetBytes: 20, satisfied: false });
        }
        throw new Error("client disappeared");
      },
    });
    const o = await runRetentionSweepTick(deps);
    assert.deepEqual(calls, ["preview", "delete"]);
    assert.equal(o.ran, false);
    assert.equal(o.skipped, "delete-error");
    assert.equal(o.delayMs, RETENTION_SWEEP_INTERVAL_MS);
  });

  console.log(
    failures === 0
      ? "\nPASS — retention sweep scheduler invokes reclamation safely"
      : `\nFAIL — ${failures} failing check(s)`,
  );
  process.exit(failures ? 1 : 0);
}

void main();
