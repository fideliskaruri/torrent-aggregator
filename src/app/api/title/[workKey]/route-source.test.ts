import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "src/app/api/title/[workKey]/route.ts",
  "utf8",
);

assert.match(source, /trackScopedTransfer = trackTransfer && scope\.scope !== "season"/);
assert.match(source, /seedSeasonEpisodeTargets\(\{/);
assert.match(source, /settleSeasonEpisodeTargets\(\{/);
assert.match(source, /failQueuedSeasonEpisodeTargets\(\{/);
assert.match(source, /scope: "episode"/);
// A settle must never let a failed episode clobber a row that already
// succeeded, while a success may recover a row left "failed" by an earlier
// attempt. Pinned as intent, not as one exact spelling, so the branch can be
// reworded but not quietly widened.
assert.match(
  source,
  /transfer\.status === "failed"\s*\?\s*"queued"\s*:\s*\{ in: \["queued", "failed"\] \}/,
);
assert.match(source, /const \{ episodeTransfers: _episodeTransfers, \.\.\.publicResult \}/);
assert.match(source, /instanceof SearchThrottledError/);
assert.match(source, /retryAfterSeconds: err\.retryAfterSeconds/);

console.log("PASS season route persists exact episode targets without season-state bleed");
