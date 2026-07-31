/**
 * The storage cap is the one setting that gates every download — so reading it
 * off the wire has to be exact.
 *
 * The failure this pins was found by accident, live: a single
 * `PUT {maxStorageGb: "1"}` returned 200 and left the install with
 * `setupComplete: false`, refusing every download with "finish setup first".
 * `Number.isFinite` does not coerce, so the string took the "clear the cap"
 * branch — and the old parser could not tell "the owner unset it" apart from
 * "I could not read that".
 *
 * The rule class, which is what these tests defend:
 *
 *   - absent            → leave the stored cap alone
 *   - null / 0          → deliberately unset (0 means unset in the UI)
 *   - finite number > 0 → a cap
 *   - anything else     → REJECTED, and nothing is written
 *
 * The last row is the whole point. Destroying configuration is never the right
 * answer to input you could not parse.
 *
 * Run: npx tsx src/lib/library/storage-cap-input.test.ts
 */
import assert from "node:assert/strict";
import { readStorageCapInput, type StorageCapInput } from "./storage-cap-input";

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

const GB = 1e9;

function main() {
  console.log("storage-cap-input.test.ts");

  const table: Array<{
    name: string;
    value: unknown;
    expect: StorageCapInput;
  }> = [
    // ── Leave alone ────────────────────────────────────────────────────────
    {
      name: "absent means this update is not about the cap",
      value: undefined,
      expect: { ok: true, action: "keep" },
    },

    // ── Deliberately unset ─────────────────────────────────────────────────
    {
      name: "null clears the cap",
      value: null,
      expect: { ok: true, action: "clear" },
    },
    {
      name: "0 clears the cap — that is what 0 means in the UI",
      value: 0,
      expect: { ok: true, action: "clear" },
    },

    // ── Real caps ──────────────────────────────────────────────────────────
    {
      name: "a whole number of GB becomes bytes",
      value: 20,
      expect: { ok: true, action: "set", bytes: 20 * GB },
    },
    {
      name: "a fractional cap is kept, rounded to whole bytes",
      value: 0.5,
      expect: { ok: true, action: "set", bytes: 500_000_000 },
    },
    {
      name: "a tiny cap is still a cap, not a clear",
      // The boundary that matters: anything above zero is a deliberate choice.
      value: 0.000_000_001,
      expect: { ok: true, action: "set", bytes: 1 },
    },

    // ── Malformed: must reject, must not clear ─────────────────────────────
    {
      // The measured bug. An <input> hands you a string; nothing may treat
      // that as permission to wipe the setting.
      name: "a numeric STRING is rejected, not treated as a clear",
      value: "20",
      expect: { ok: false, reason: "" },
    },
    {
      name: "an empty string is rejected",
      value: "",
      expect: { ok: false, reason: "" },
    },
    {
      name: "NaN is rejected",
      value: Number.NaN,
      expect: { ok: false, reason: "" },
    },
    {
      name: "Infinity is rejected",
      value: Number.POSITIVE_INFINITY,
      expect: { ok: false, reason: "" },
    },
    {
      name: "a negative cap is rejected rather than silently clamped",
      value: -5,
      expect: { ok: false, reason: "" },
    },
    {
      name: "a boolean is rejected",
      value: true,
      expect: { ok: false, reason: "" },
    },
    {
      name: "an object is rejected",
      value: { gb: 20 },
      expect: { ok: false, reason: "" },
    },
    {
      name: "an array is rejected",
      value: [20],
      expect: { ok: false, reason: "" },
    },
    {
      name: "a cap too large to hold as an exact integer is rejected",
      value: Number.MAX_SAFE_INTEGER,
      expect: { ok: false, reason: "" },
    },
  ];

  for (const row of table) {
    check(row.name, () => {
      const got = readStorageCapInput(row.value, "maxStorageGb", GB);
      if (!row.expect.ok) {
        assert.equal(got.ok, false, `expected a rejection, got ${JSON.stringify(got)}`);
        // A rejection the caller cannot act on is only half a fix.
        assert.ok(
          !got.ok && got.reason.trim().length > 0,
          "a rejection must explain itself",
        );
        assert.ok(
          !got.ok && got.reason.includes("maxStorageGb"),
          "and must name the field it rejected",
        );
        return;
      }
      assert.deepEqual(got, row.expect);
    });
  }

  // ── The invariant behind the whole module ────────────────────────────────
  check("no malformed input can ever produce a clear", () => {
    // Stated as its own assertion because this is the actual guarantee. A
    // future edit that adds a lenient branch would keep every row above green
    // if it mapped the bad value to `clear` — this is what catches that.
    const malformed: unknown[] = [
      "20",
      "",
      " ",
      "abc",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -0.5,
      true,
      false,
      {},
      [],
      () => 20,
      Symbol("20"),
      BigInt(20),
    ];
    for (const value of malformed) {
      const got = readStorageCapInput(value, "maxStorageGb", GB);
      assert.equal(
        got.ok,
        false,
        `${String(value)} was accepted as ${JSON.stringify(got)}`,
      );
    }
  });

  check("only the two explicit signals clear the cap", () => {
    for (const value of [null, 0]) {
      const got = readStorageCapInput(value, "maxStorageGb", GB);
      assert.deepEqual(got, { ok: true, action: "clear" });
    }
  });

  check("a raw byte cap uses a scale of 1", () => {
    assert.deepEqual(readStorageCapInput(1_500, "maxStorageBytes", 1), {
      ok: true,
      action: "set",
      bytes: 1_500,
    });
  });

  if (failures > 0) {
    console.error(`storage-cap-input.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("storage-cap-input.test.ts: all assertions passed");
}

main();
