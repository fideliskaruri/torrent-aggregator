/**
 * Download row numbers, shared with `/downloads`.
 *
 * Run: npx tsx src/components/tf/active-row-state.test.ts
 *
 * The cases worth writing are the ones where a plausible number lies: a
 * rounded 100% on an incomplete file, or a zero speed presented as a
 * measurement.
 */
import assert from "node:assert/strict";
import { progressPercent, speedLabel } from "./active-row-state";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

check("an almost-finished file never rounds up to 100%", () => {
  assert.equal(
    progressPercent(0.996),
    99,
    "100% on a file still being written sends someone to open it",
  );
  assert.equal(progressPercent(0.999999), 99);
  assert.equal(progressPercent(1), 100);
});

check("a barely-started file is not floored away into nothing visible", () => {
  assert.equal(progressPercent(0.00068), 0);
  assert.equal(progressPercent(0.011), 1);
});

check("junk progress reads as zero rather than NaN%", () => {
  for (const bad of [NaN, Infinity, -1, -0.5]) {
    assert.equal(progressPercent(bad), 0, `for ${bad}`);
  }
  assert.equal(progressPercent(5), 100, "over-unity clamps rather than lies");
});

check("no speed is absent, not zero", () => {
  assert.equal(
    speedLabel(0),
    null,
    "'0 B/s' reads as a measurement of failure; the absence of one is the truth",
  );
  assert.equal(speedLabel(-5), null);
  assert.equal(speedLabel(NaN), null);
});

check("speed scales into units a person reads", () => {
  assert.equal(speedLabel(512), "512 B/s");
  assert.equal(speedLabel(1536), "1.5 KB/s");
  assert.equal(speedLabel(5 * 1024 * 1024), "5 MB/s");
});

if (failures) {
  console.error(`\n${failures} active-row test(s) failed.`);
  process.exit(1);
}
console.log("\nAll active-row state tests passed.");
