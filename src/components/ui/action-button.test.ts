/**
 * ActionButton status-slot logic tests.
 *
 * The JSX itself needs a DOM, but the rules the reserved status slot depends on
 * are pure: how a raw status is normalised (trim, default variant) and which
 * tone class each variant maps to. Those are asserted here; the no-layout-shift
 * rendering is proven separately by scripts/probes/action-button-no-shift.mts.
 *
 * Run: npx tsx src/components/ui/action-button.test.ts
 */
import assert from "node:assert/strict";
import {
  actionStatusTone,
  resolveActionStatus,
  type ActionButtonStatus,
  type ActionButtonStatusVariant,
} from "./action-button";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// resolveActionStatus — normalisation the reserved slot renders
// ---------------------------------------------------------------------------

const NORMALISE_CASES: Array<{
  name: string;
  input: ActionButtonStatus | null | undefined;
  text: string;
  variant: ActionButtonStatusVariant;
}> = [
  { name: "null → empty/info", input: null, text: "", variant: "info" },
  {
    name: "undefined → empty/info",
    input: undefined,
    text: "",
    variant: "info",
  },
  {
    name: "whitespace-only message stays blank but reserved",
    input: { message: "   ", variant: "error" },
    text: "",
    variant: "error",
  },
  {
    name: "trims surrounding whitespace",
    input: { message: "  Starting playback  ", variant: "success" },
    text: "Starting playback",
    variant: "success",
  },
  {
    name: "missing variant defaults to info",
    input: { message: "Sent · built-in" },
    text: "Sent · built-in",
    variant: "info",
  },
  {
    name: "error message preserved with error variant",
    input: { message: "Failed · qBittorrent", variant: "error" },
    text: "Failed · qBittorrent",
    variant: "error",
  },
];

for (const c of NORMALISE_CASES) {
  check(`resolveActionStatus: ${c.name}`, () => {
    const out = resolveActionStatus(c.input);
    assert.equal(out.text, c.text);
    assert.equal(out.variant, c.variant);
  });
}

// ---------------------------------------------------------------------------
// actionStatusTone — variant → colour token
// ---------------------------------------------------------------------------

const TONE_CASES: Array<{ variant: ActionButtonStatusVariant; token: string }> =
  [
    { variant: "error", token: "--destructive" },
    { variant: "success", token: "--success" },
    { variant: "info", token: "--text-tertiary" },
  ];

for (const c of TONE_CASES) {
  check(`actionStatusTone: ${c.variant} → ${c.token}`, () => {
    const cls = actionStatusTone(c.variant);
    assert.ok(
      cls.includes(c.token),
      `expected tone for ${c.variant} to reference ${c.token}, got "${cls}"`,
    );
  });
}

check("actionStatusTone: every variant maps to a text colour class", () => {
  for (const v of ["error", "success", "info"] as ActionButtonStatusVariant[]) {
    assert.match(actionStatusTone(v), /^text-\[var\(--[a-z-]+\)\]$/);
  }
});

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll action-button tests passed");
