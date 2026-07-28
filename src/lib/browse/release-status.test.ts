/**
 * Unit checks for future-gating.
 * Run with: npx tsx --test src/lib/browse/release-status.test.ts
 * (or the repo runner: node scripts/run-unit-tests.mjs)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnreleased, releaseStatus } from "./release-status";

const NOW = new Date("2026-07-28T00:00:00.000Z");

test("treats unknown dates as released (never gated)", () => {
  for (const input of [null, undefined, "", "not-a-date"]) {
    const s = releaseStatus(input as never, NOW);
    assert.equal(s.unreleased, false);
    assert.equal(s.released, true);
    assert.equal(s.comingLabel, null);
  }
});

test("treats a past date as released", () => {
  const s = releaseStatus("2021-11-05", NOW);
  assert.equal(s.unreleased, false);
  assert.equal(s.released, true);
  assert.equal(s.comingLabel, null);
});

test("treats today (not future) as released", () => {
  assert.equal(releaseStatus("2026-07-28T00:00:00.000Z", NOW).unreleased, false);
});

test("gates a future dated day with a month+year label", () => {
  const s = releaseStatus("2026-12-25", NOW);
  assert.equal(s.unreleased, true);
  assert.equal(s.released, false);
  assert.equal(s.comingLabel, "Coming Dec 2026");
});

test("gates a future year-only placeholder with a year-only label", () => {
  // Jan 1 is how a bare year is stored — do not pretend to know the month.
  const s = releaseStatus("2027-01-01", NOW);
  assert.equal(s.unreleased, true);
  assert.equal(s.comingLabel, "Coming 2027");
});

test("accepts Date and epoch inputs", () => {
  assert.equal(isUnreleased(new Date("2030-01-01"), NOW), true);
  assert.equal(isUnreleased(new Date("2000-01-01"), NOW), false);
  assert.equal(isUnreleased(Date.parse("2030-06-01"), NOW), true);
});

test("holds across many titles (rule class, not one example)", () => {
  const cases: Array<[string, boolean]> = [
    ["2026-07-27", false], // yesterday
    ["2026-07-29", true], // tomorrow
    ["2025-01-01", false], // last year
    ["2028-03-15", true], // next-next year
  ];
  for (const [date, expected] of cases) {
    assert.equal(isUnreleased(date, NOW), expected);
  }
});
