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
assert.match(source, /status:\s*transfer\.status === "downloading"\s*\?\s*\{ in: \["queued", "failed"\] \}\s*:\s*"queued"/);
assert.match(source, /const \{ episodeTransfers: _episodeTransfers, \.\.\.publicResult \}/);

console.log("PASS season route persists exact episode targets without season-state bleed");
