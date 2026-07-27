import assert from "node:assert/strict";
import {
  LOADING_MIN_VISIBLE_MS,
  LOADING_SHOW_DELAY_MS,
  loadingEvidenceState,
} from "./loading-state";

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

console.log("loading-state: evidence and timing…");

check("delays visible loaders long enough to suppress sub-frame flicker", () => {
  assert.equal(LOADING_SHOW_DELAY_MS >= 120, true);
  assert.equal(LOADING_SHOW_DELAY_MS <= 220, true);
});

check("keeps a shown loader stable without making data wait", () => {
  assert.equal(LOADING_MIN_VISIBLE_MS >= 240, true);
  assert.equal(LOADING_MIN_VISIBLE_MS <= 400, true);
});

check("data is evidence that beats a stale loading boolean", () => {
  assert.equal(
    loadingEvidenceState({ loading: true, hasData: true, error: null }),
    "data",
  );
});

check("error and empty are terminal states, not forever-loading", () => {
  assert.equal(
    loadingEvidenceState({ loading: true, hasData: false, error: "nope" }),
    "error",
  );
  assert.equal(
    loadingEvidenceState({ loading: false, hasData: false, error: null }),
    "empty",
  );
});

if (failures) {
  console.error(`\nFAIL ${failures} loading-state check(s)`);
  process.exit(1);
}
console.log("PASS loading-state");
