/**
 * Retention → visible-progress rule tests.
 *
 * The one classification rule every Play/browse/downloads surface must agree
 * on: a `kept` download (and legacy/`unknown` rows we cannot classify) is a
 * download and may show progress; a `stream` or `prewarm` never is and never
 * exposes a "% downloaded". Table-driven over the whole state space so a
 * regression that lets a stream leak a percentage fails here.
 *
 * Run: npx tsx src/lib/streaming/retention-view.test.ts
 */
import assert from "node:assert/strict";
import {
  isDownloadRetention,
  visibleDownloadProgress,
  type RetentionState,
} from "./retention";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// isDownloadRetention — kept/unknown are downloads; stream/prewarm are not
// ---------------------------------------------------------------------------

const DOWNLOAD_CASES: Array<{
  state: RetentionState | null | undefined;
  isDownload: boolean;
}> = [
  { state: "kept", isDownload: true },
  { state: "unknown", isDownload: true },
  { state: null, isDownload: true },
  { state: undefined, isDownload: true },
  { state: "stream", isDownload: false },
  { state: "prewarm", isDownload: false },
];

for (const tc of DOWNLOAD_CASES) {
  check(`isDownloadRetention(${tc.state}) === ${tc.isDownload}`, () => {
    assert.equal(isDownloadRetention(tc.state), tc.isDownload);
  });
}

// ---------------------------------------------------------------------------
// visibleDownloadProgress — % only for a download-retention row
// ---------------------------------------------------------------------------

// The rule must hold across every progress value, so a stream that is 99%
// through pulling its watched pieces still reports nothing.
const PROGRESS_SAMPLES = [0, 0.01, 0.14, 0.16, 0.5, 0.99, 1];

for (const state of ["kept", "unknown"] as const) {
  for (const p of PROGRESS_SAMPLES) {
    check(`visible progress for ${state} at ${p} → ${p}`, () => {
      assert.equal(visibleDownloadProgress(state, p), p);
    });
  }
}

for (const state of ["stream", "prewarm"] as const) {
  for (const p of PROGRESS_SAMPLES) {
    check(`visible progress for ${state} at ${p} → null`, () => {
      assert.equal(visibleDownloadProgress(state, p), null);
    });
  }
}

check("null/undefined state defaults to download (legacy row) and shows %", () => {
  assert.equal(visibleDownloadProgress(null, 0.42), 0.42);
  assert.equal(visibleDownloadProgress(undefined, 0.42), 0.42);
});

check("a kept row with no progress value returns null, not NaN", () => {
  assert.equal(visibleDownloadProgress("kept", null), null);
  assert.equal(visibleDownloadProgress("kept", undefined), null);
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? "retention-view: all tests passed ✓" : `retention-view: ${failures} FAILED`}`,
);
if (failures > 0) process.exit(1);
