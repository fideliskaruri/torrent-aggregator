/**
 * The storage gate: Play reclaims, Download obeys the cap.
 *
 * A storage cap bounds how much media the app *keeps*. The stream cache is
 * reclaimable by design, so pressing Play is exactly the moment the app may
 * throw away a finished stream or a stalled allocation to make room. Refusing
 * Play because the cache is full is refusing to do the one thing that would
 * fix it — which is how the live install reached "every Play refused, forever".
 *
 * Asking for a *kept* download is a different request, and the cap still
 * answers it: a permanent file is not cache, and the shelf the owner sized is
 * the shelf they get.
 *
 * These tests pin that asymmetry, the deficit arithmetic the gate turns on, and
 * the honesty of each refusal — including that a refusal never claims space was
 * freed when it was not, and never sends the viewer to a tab that does not
 * exist.
 *
 * Table-driven per AGENTS.md.
 * Run: npx tsx src/lib/library/storage-gate.test.ts
 */
import assert from "node:assert/strict";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import type { StoragePolicyResult } from "./disk-space";
import { storageCapMessage } from "./disk-space";
import type { RetentionSweepResult } from "./retention-sweep";
import {
  checkSendStorage,
  reclaimRefusalMessage,
  storageDeficitBytes,
} from "./storage-gate";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const GB = 1_000_000_000;

const config = {
  clientType: "builtin",
  host: "",
  savePath: "D:\\Downloads",
  maxStorageBytes: 20 * GB,
} as ClientConnectionConfig;

/** The live measurement: 38.5 GB held under a 20 GB cap. */
function overCap(usedBytes = 38.5 * GB): StoragePolicyResult {
  return {
    ok: false,
    limit: "cap",
    message: storageCapMessage(usedBytes, 20 * GB),
    usedBytes,
    maxStorageBytes: 20 * GB,
    freeBytes: 500 * GB,
  } as StoragePolicyResult;
}

function underCap(usedBytes = 3 * GB): StoragePolicyResult {
  return {
    ok: true,
    usedBytes,
    maxStorageBytes: 20 * GB,
    freeBytes: 500 * GB,
    remainingBudgetBytes: 20 * GB - usedBytes,
  } as StoragePolicyResult;
}

function sweepResult(input: {
  reclaimedBytes?: number;
  deleted?: string[];
  skipped?: Array<{ hash: string; reason: string }>;
}): RetentionSweepResult {
  return {
    mode: "delete",
    budgetBytes: 0,
    usedBytes: 0,
    targetBytes: 0,
    reclaimedBytes: input.reclaimedBytes ?? 0,
    satisfied: false,
    scanned: 0,
    wouldDelete: [],
    deleted: (input.deleted ?? []).map((hash) => ({ hash, name: hash, freedBytes: 0 })),
    skipped: input.skipped ?? [],
  } as unknown as RetentionSweepResult;
}

/**
 * An assert stub that refuses until `freeAfter` bytes have been reclaimed —
 * the behaviour the real one has once `resetDirectorySizeCache` drops the memo.
 */
function assertStub(input: {
  usedBytes: number;
  freedByReclaim?: number;
  calls?: string[];
}) {
  let used = input.usedBytes;
  return {
    reclaimed(bytes: number) {
      used -= bytes;
    },
    fn: async (args: { root: string; maxStorageBytes?: number | null; incomingBytes?: number | null }) => {
      input.calls?.push("assert");
      const cap = args.maxStorageBytes ?? null;
      const incoming = args.incomingBytes ?? 0;
      if (cap == null || used + incoming <= cap) return underCap(used);
      return overCap(used);
    },
  };
}

// ---------------------------------------------------------------------------
// Deficit arithmetic
// ---------------------------------------------------------------------------

interface DeficitCase {
  name: string;
  space: StoragePolicyResult;
  incomingBytes: number | null;
  expect: number;
}

const DEFICIT_CASES: DeficitCase[] = [
  {
    name: "under the cap needs nothing freed",
    space: underCap(),
    incomingBytes: 2 * GB,
    expect: 0,
  },
  {
    name: "38.5 GB against a 20 GB cap needs 18.5 GB freed",
    space: overCap(),
    incomingBytes: null,
    expect: 18.5 * GB,
  },
  {
    name: "a known incoming size is part of the deficit",
    space: overCap(21 * GB),
    incomingBytes: 4 * GB,
    expect: 5 * GB,
  },
  {
    name: "an unknown incoming size does not inflate the deficit",
    space: overCap(24 * GB),
    incomingBytes: null,
    expect: 4 * GB,
  },
  {
    name: "a negative incoming size is ignored, not subtracted",
    space: overCap(24 * GB),
    incomingBytes: -5 * GB,
    expect: 4 * GB,
  },
  {
    // No cap configured means the refusal came from the free-space floor.
    // Deleting cache would not change a full disk's free space by the same
    // rule, so the gate must not treat this as a reclaimable deficit.
    name: "no configured cap yields no deficit — this refusal is not about the cap",
    space: { ...overCap(), maxStorageBytes: null } as StoragePolicyResult,
    incomingBytes: null,
    expect: 0,
  },
  {
    name: "a zero cap yields no deficit rather than a nonsense target",
    space: { ...overCap(), maxStorageBytes: 0 } as StoragePolicyResult,
    incomingBytes: null,
    expect: 0,
  },
];

// ---------------------------------------------------------------------------
// Gate behaviour
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("storageDeficitBytes");
  for (const testCase of DEFICIT_CASES) {
    check(testCase.name, () => {
      assert.equal(
        storageDeficitBytes(testCase.space, testCase.incomingBytes),
        testCase.expect,
      );
    });
  }

  console.log("checkSendStorage");

  await checkAsync("Play proceeds once reclamation makes room", async () => {
    const calls: string[] = [];
    const stub = assertStub({ usedBytes: 38.5 * GB, calls });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      _assert: stub.fn as never,
      _reclaim: async (opts) => {
        calls.push(`reclaim:${opts.neededBytes}`);
        stub.reclaimed(opts.neededBytes);
        return sweepResult({ reclaimedBytes: opts.neededBytes, deleted: ["a"] });
      },
      _resetDirectorySizeCache: () => calls.push("reset"),
    });
    assert.equal(decision.ok, true, "Play was allowed after reclaiming");
    assert.equal(decision.message, "");
    assert.deepEqual(
      calls,
      ["assert", `reclaim:${18.5 * GB}`, "reset", "assert"],
      "reclaim runs between the two checks, and the size memo is dropped first",
    );
  });

  await checkAsync("Download over the same cap is still refused, and reclaims nothing", async () => {
    const calls: string[] = [];
    const stub = assertStub({ usedBytes: 38.5 * GB, calls });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "keep",
      _assert: stub.fn as never,
      _reclaim: async () => {
        throw new Error("Download must never trigger reclamation");
      },
      _resetDirectorySizeCache: () => calls.push("reset"),
    });
    assert.equal(decision.ok, false, "the cap still bounds kept media");
    assert.equal(decision.reclaim, null, "nothing was deleted on this path");
    assert.match(decision.message, /Storage cap reached/);
    assert.deepEqual(calls, ["assert"], "one check, no reclaim, no second look");
  });

  await checkAsync("an absent retention is treated as a keep, not a Play", async () => {
    const stub = assertStub({ usedBytes: 38.5 * GB });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      _assert: stub.fn as never,
      _reclaim: async () => {
        throw new Error("an unspecified send must not delete cache");
      },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reclaim, null);
  });

  await checkAsync("a send that already fits never reclaims anything", async () => {
    const calls: string[] = [];
    const stub = assertStub({ usedBytes: 3 * GB, calls });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      _assert: stub.fn as never,
      _reclaim: async () => {
        throw new Error("must not reclaim when there is already room");
      },
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.reclaim, null);
    assert.deepEqual(calls, ["assert"]);
  });

  await checkAsync("a non-cap refusal is passed through untouched, with nothing deleted", async () => {
    // Setup incomplete / free-space floor: `maxStorageBytes` is not the reason,
    // so deleting cache is not the remedy and must not be attempted.
    const decision = await checkSendStorage({
      userId: "u1",
      config: { ...config, maxStorageBytes: null } as ClientConnectionConfig,
      root: "D:\\Downloads",
      retention: "stream",
      _assert: async () =>
        ({
          ok: false,
          message: "Set a download folder in Settings first.",
          usedBytes: 0,
          maxStorageBytes: null,
          freeBytes: 0,
        }) as never,
      _reclaim: async () => {
        throw new Error("must not delete cache to fix a setup problem");
      },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reclaim, null);
    assert.equal(decision.message, "Set a download folder in Settings first.");
  });

  await checkAsync("Play is refused honestly when reclamation freed some but not enough", async () => {
    const stub = assertStub({ usedBytes: 38.5 * GB });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      _assert: stub.fn as never,
      _reclaim: async () => {
        stub.reclaimed(4 * GB);
        return sweepResult({ reclaimedBytes: 4 * GB, deleted: ["a"] });
      },
    });
    assert.equal(decision.ok, false);
    assert.match(decision.message, /Freed 4/, "says what it actually managed to free");
    // The reclaim button was just pressed on the viewer's behalf and it was not
    // enough. Sending them to press it again is advice that has already failed.
    assert.doesNotMatch(
      decision.message,
      /Delete reclaimable stream-only files/,
      "does not send the viewer back to the control that just ran",
    );
    assert.ok(decision.reclaim, "the attempt is reported back to the caller");
  });

  await checkAsync("Play is refused honestly when nothing on disk was reclaimable", async () => {
    const stub = assertStub({ usedBytes: 38.5 * GB });
    const decision = await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      _assert: stub.fn as never,
      _reclaim: async () =>
        sweepResult({
          reclaimedBytes: 0,
          skipped: [
            { hash: "a", reason: "kept" },
            { hash: "b", reason: "partial" },
          ],
        }),
    });
    assert.equal(decision.ok, false);
    assert.match(decision.message, /nothing on disk can be freed automatically/);
    assert.doesNotMatch(decision.message, /Freed/, "never claims a reclaim that did not happen");
  });

  await checkAsync("the protected stream is passed through to reclamation", async () => {
    const stub = assertStub({ usedBytes: 38.5 * GB });
    let seen: readonly string[] | undefined;
    await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      protectHashes: ["watching-now"],
      _assert: stub.fn as never,
      _reclaim: async (opts) => {
        seen = opts.protectHashes;
        stub.reclaimed(opts.neededBytes);
        return sweepResult({ reclaimedBytes: opts.neededBytes, deleted: ["a"] });
      },
    });
    assert.deepEqual(seen, ["watching-now"]);
  });

  await checkAsync("reclamation is never asked to free the thing being sent", async () => {
    // The viewer pressing Play on a stalled allocation is the common case:
    // freeing it to make room for itself would delete the request out from
    // under the request.
    const stub = assertStub({ usedBytes: 38.5 * GB });
    let seen: readonly string[] | undefined;
    await checkSendStorage({
      userId: "u1",
      config,
      root: "D:\\Downloads",
      retention: "stream",
      protectHashes: ["the-one-being-played"],
      _assert: stub.fn as never,
      _reclaim: async (opts) => {
        seen = opts.protectHashes;
        stub.reclaimed(opts.neededBytes);
        return sweepResult({ reclaimedBytes: opts.neededBytes, deleted: ["other"] });
      },
    });
    assert.ok(seen?.includes("the-one-being-played"));
  });

  // ── Refusal copy ────────────────────────────────────────────────────────
  console.log("refusal copy");

  const CAP_MESSAGE = storageCapMessage(38.5 * GB, 20 * GB);
  const COPY_CASES: Array<{ name: string; message: string }> = [
    { name: "the cap refusal", message: CAP_MESSAGE },
    {
      name: "the reclaim-fell-short refusal",
      message: reclaimRefusalMessage(
        sweepResult({ reclaimedBytes: 2 * GB, deleted: ["a"] }),
        CAP_MESSAGE,
      ),
    },
    {
      name: "the nothing-was-reclaimable refusal",
      message: reclaimRefusalMessage(
        sweepResult({ skipped: [{ hash: "a", reason: "kept" }] }),
        CAP_MESSAGE,
      ),
    },
  ];

  for (const testCase of COPY_CASES) {
    check(`${testCase.name} points at a Settings tab that exists`, () => {
      // The tabs are Connection / Downloads / Categories. "Folders" is the
      // internal tab id and has never been on screen.
      assert.doesNotMatch(testCase.message, /Settings\s*(→|->)\s*Folders/i);
      assert.match(testCase.message, /Settings\s*(→|->)\s*Downloads/);
    });
    check(`${testCase.name} names an action the viewer can actually take`, () => {
      assert.match(
        testCase.message,
        /Delete reclaimable stream-only files|remove a download|Raise the cap/,
      );
    });
  }

  check("the cap refusal still states the measurement", () => {
    assert.match(CAP_MESSAGE, /38\.5 GB/);
    assert.match(CAP_MESSAGE, /20(\.0)? GB/);
  });

  check("an unknown reclaim outcome falls back to the caller's message", () => {
    const fallback = "some other refusal";
    assert.equal(reclaimRefusalMessage(sweepResult({}), fallback), fallback);
  });

  if (failures > 0) {
    console.error(`storage-gate.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("storage-gate.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
