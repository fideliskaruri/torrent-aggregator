import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDownloadDir } from "./defaults";

// The function must return a non-empty, OS-derived path that the settings page
// can pre-fill. It must never return "" — the smoke test gates on this.
const result = defaultDownloadDir();
assert.ok(result.length > 0, "defaultDownloadDir should be non-empty");
assert.equal(
  result,
  join(homedir(), "Downloads", "TorrentFlow"),
  "defaultDownloadDir should be ~/Downloads/TorrentFlow",
);

console.log("defaults.test.ts: all assertions passed");
