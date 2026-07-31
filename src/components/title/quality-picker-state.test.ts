/**
 * Table-driven tests for `quality-picker-state.ts`.
 *
 * Rules encoded here:
 *  - Download (keep) prompts for quality, unless the user has set "always
 *    preferred".
 *  - Play (stream) never prompts, regardless of "always preferred".
 *  - nearestQuality maps arbitrary resolution numbers to the defined choices.
 *  - QUALITY_VALUES are the four supported values, ascending.
 *
 * Run: npx tsx src/components/title/quality-picker-state.test.ts
 */
import { strict as assert } from "node:assert";
import {
  shouldAskForQuality,
  nearestQuality,
  QUALITY_VALUES,
  QUALITY_CHOICES,
} from "./quality-picker-state.js";

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

console.log("\nquality-picker-state");

// ---------------------------------------------------------------------------
// shouldAskForQuality — the primary invariant
//
// Play is NEVER prompted. Download is prompted unless the user has opted out.
// This is the rule the whole Task 4 feature rests on: "Only Download asks.
// Play must stay instant and never prompt."
// ---------------------------------------------------------------------------

type AskCase = {
  name: string;
  retention: "keep" | "stream";
  alwaysPreferred: boolean;
  expected: boolean;
};

const ASK_CASES: AskCase[] = [
  {
    name: "keep + alwaysPreferred=false → ask (default Download behavior)",
    retention: "keep",
    alwaysPreferred: false,
    expected: true,
  },
  {
    name: "keep + alwaysPreferred=true → skip (user opted out)",
    retention: "keep",
    alwaysPreferred: true,
    expected: false,
  },
  // Play is ALWAYS instant — never prompts regardless of preference.
  {
    name: "stream + alwaysPreferred=false → never ask",
    retention: "stream",
    alwaysPreferred: false,
    expected: false,
  },
  {
    name: "stream + alwaysPreferred=true → never ask",
    retention: "stream",
    alwaysPreferred: true,
    expected: false,
  },
];

for (const c of ASK_CASES) {
  check(`shouldAskForQuality: ${c.name}`, () => {
    assert.equal(shouldAskForQuality(c.retention, c.alwaysPreferred), c.expected);
  });
}

// ---------------------------------------------------------------------------
// nearestQuality — maps settings integers to supported resolution choices
// ---------------------------------------------------------------------------

type NearestCase = { name: string; input: number; expected: number };

const NEAREST_CASES: NearestCase[] = [
  // Exact matches.
  { name: "480  → 480 (exact)", input: 480, expected: 480 },
  { name: "720  → 720 (exact)", input: 720, expected: 720 },
  { name: "1080 → 1080 (exact)", input: 1080, expected: 1080 },
  { name: "2160 → 2160 (exact)", input: 2160, expected: 2160 },
  // Below minimum.
  { name: "0    → 480", input: 0, expected: 480 },
  { name: "240  → 480", input: 240, expected: 480 },
  // Mid-range.
  { name: "540  → 480 (closer to 480 than 720 by 60px)", input: 540, expected: 480 },
  { name: "900  → 720 (equidistant 720↔1080 — ties resolve DOWN)", input: 900, expected: 720 },
  { name: "1440 → 1080 (equidistant 1080↔2160 — ties resolve DOWN)", input: 1440, expected: 1080 },
  // Above maximum.
  { name: "4320 → 2160", input: 4320, expected: 2160 },
  { name: "9999 → 2160", input: 9999, expected: 2160 },
];

for (const c of NEAREST_CASES) {
  check(`nearestQuality: ${c.name}`, () => {
    assert.equal(nearestQuality(c.input), c.expected);
  });
}

// ---------------------------------------------------------------------------
// QUALITY_VALUES
// ---------------------------------------------------------------------------

check("QUALITY_VALUES: four values in ascending order", () => {
  assert.deepEqual(QUALITY_VALUES, [480, 720, 1080, 2160]);
});

// ---------------------------------------------------------------------------
// QUALITY_CHOICES
// ---------------------------------------------------------------------------

check("each QUALITY_CHOICES entry has a non-empty label and hint", () => {
  for (const choice of QUALITY_CHOICES) {
    assert.ok(
      typeof choice.label === "string" && choice.label.length > 0,
      `quality ${choice.value} must have a label`,
    );
    assert.ok(
      typeof choice.hint === "string" && choice.hint.length > 0,
      `quality ${choice.value} must have a hint`,
    );
  }
});

check("QUALITY_CHOICES values match QUALITY_VALUES", () => {
  const choiceValues = QUALITY_CHOICES.map((c) => c.value);
  assert.deepEqual(choiceValues, QUALITY_VALUES);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\nquality-picker-state: ${failures} FAIL`);
  process.exit(1);
} else {
  console.log("\nquality-picker-state: all ok");
}
