import assert from "node:assert/strict";
import { defaultDownloadDir } from "./defaults";

const previous = process.env.DOWNLOAD_DIR;
try {
  process.env.DOWNLOAD_DIR =
    "D:\\code\\torrent-aggregator\\.e2e-instant-play\\run\\leech";
  assert.equal(
    defaultDownloadDir(),
    "",
    "download folder defaults to unset even in an inherited test environment",
  );
} finally {
  if (previous === undefined) delete process.env.DOWNLOAD_DIR;
  else process.env.DOWNLOAD_DIR = previous;
}

console.log("defaults.test.ts: all assertions passed");
