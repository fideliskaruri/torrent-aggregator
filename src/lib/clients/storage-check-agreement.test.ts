/**
 * The two storage checks must agree.
 *
 * A send passes through storage policy **twice**:
 *
 *   1. `library/storage-gate.checkSendStorage` — the route-level gate. Reclaims
 *      cache for a Play, and is the one that produces the "you are over your
 *      cap, proceed anyway?" facts.
 *   2. `clients/builtin-engine.checkStoragePolicy` — the engine's own check,
 *      immediately before the add. It exists because callers can reach the
 *      engine directly, so it cannot simply be deleted.
 *
 * ## The bug
 *
 * The second check knew nothing about the first. Measured live against the
 * running server: `POST /api/torrent/send {overrideStorageCap: true}` with a
 * 1 GB cap passed the gate (the response carried no `storage` facts, so the
 * gate had allowed it) and then came back **502 still carrying the cap
 * message** — refused by the engine for the very thing the owner had just
 * confirmed. "Download anyway" did not download anyway.
 *
 * This is a rule-agreement bug, not a copy bug, so these tests assert the two
 * checks reach the SAME verdict for the same facts rather than checking one
 * screen. The dangerous direction is asymmetric:
 *
 *   - gate allows, engine refuses → a confirmed action silently fails (the bug)
 *   - gate refuses, engine allows → the gate is the only thing standing between
 *     an unconfigured install and a runaway, so this must never happen either
 *
 * Run: npx tsx src/lib/clients/storage-check-agreement.test.ts
 */
import assert from "node:assert/strict";
import type { ClientConnectionConfig } from "./types";
import { checkStoragePolicyForTests } from "./builtin-engine";
import { isOverridableLimit } from "@/lib/library/storage-override";
import { assertStorageBudget, type StorageLimitKind } from "@/lib/library/disk-space";
import { withScratchDir } from "@/lib/test-support/scratch-dir";

let failures = 0;

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

function configWith(root: string, capBytes: number | null): ClientConnectionConfig {
  return {
    clientType: "builtin",
    host: "",
    savePath: root,
    baseDownloadPath: root,
    maxStorageBytes: capBytes,
  } as ClientConnectionConfig;
}

async function main() {
  console.log("storage-check-agreement.test.ts");

  await withScratchDir("storage-agreement", async (root) => {
    // Each row is a situation, not a screen. `override` is what the owner
    // decided; `limit` is what the policy says refused them.
    const table: Array<{
      name: string;
      cap: number | null;
      override: boolean;
      expectAllowed: boolean;
      expectLimit: StorageLimitKind | null;
    }> = [
      {
        name: "a send well inside the cap is allowed by both",
        cap: 500 * GB,
        override: false,
        expectAllowed: true,
        expectLimit: null,
      },
      {
        name: "an over-cap send with no override is refused by both",
        cap: 1 * GB,
        override: false,
        expectAllowed: false,
        expectLimit: "cap",
      },
      {
        // The measured defect. Before the fix the engine refused this while
        // the gate allowed it.
        name: "an over-cap send the owner CONFIRMED is allowed by both",
        cap: 1 * GB,
        override: true,
        expectAllowed: true,
        expectLimit: "cap",
      },
      {
        name: "an unconfigured cap is refused by both, override or not",
        cap: null,
        override: true,
        expectAllowed: false,
        expectLimit: "setup",
      },
      {
        name: "a zero cap is unconfigured, not a cap of zero",
        cap: 0,
        override: true,
        expectAllowed: false,
        expectLimit: "setup",
      },
    ];

    for (const row of table) {
      await checkAsync(row.name, async () => {
        const config = configWith(root, row.cap);

        // What the policy itself says, and therefore what BOTH checks must
        // derive their answer from.
        const policy = await assertStorageBudget({
          root,
          maxStorageBytes: row.cap,
          incomingBytes: null,
        });
        const limit = policy.ok ? null : policy.limit;
        assert.equal(limit, row.expectLimit, "the policy verdict itself");

        const gateAllows =
          policy.ok || (row.override && isOverridableLimit(limit));
        const engine = await checkStoragePolicyForTests(
          config,
          root,
          null,
          row.override,
        );

        assert.equal(
          gateAllows,
          row.expectAllowed,
          `gate should ${row.expectAllowed ? "allow" : "refuse"}`,
        );
        assert.equal(
          engine.ok,
          row.expectAllowed,
          `engine should ${row.expectAllowed ? "allow" : "refuse"}` +
            (engine.ok ? "" : ` — got: ${engine.message}`),
        );
        // The invariant, stated directly: they agree.
        assert.equal(
          engine.ok,
          gateAllows,
          "the engine check and the route gate disagreed about the same facts",
        );
      });
    }

    await checkAsync(
      "the override can never talk the engine past an unconfigured cap",
      async () => {
        // Belt and braces on the direction that would be catastrophic: an
        // override flag arriving from a stale client or a forged request must
        // not turn "no cap set" into "download freely".
        const engine = await checkStoragePolicyForTests(
          configWith(root, null),
          root,
          null,
          true,
        );
        assert.equal(engine.ok, false);
        assert.match(engine.message, /setup/i);
      },
    );

    await checkAsync("an absent override behaves exactly like a false one", async () => {
      const config = configWith(root, 1 * GB);
      const omitted = await checkStoragePolicyForTests(config, root, null);
      const explicit = await checkStoragePolicyForTests(config, root, null, false);
      assert.deepEqual(omitted, explicit);
      assert.equal(omitted.ok, false, "and both still refuse an over-cap send");
    });
  });

  if (failures > 0) {
    console.error(`storage-check-agreement.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("storage-check-agreement.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
