import assert from "node:assert/strict";

import { shouldRecordHuntMiss } from "./quality-floor";

assert.equal(shouldRecordHuntMiss("no_results"), true);
assert.equal(shouldRecordHuntMiss("no_match"), true);
assert.equal(
  shouldRecordHuntMiss("below_resolution_floor"),
  false,
  "an episode with only lower-quality releases stays pinned for a future retry",
);

console.log("quality-floor.test.ts: PASS");
