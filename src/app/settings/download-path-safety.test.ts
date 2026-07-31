import assert from "node:assert/strict";
import {
  detectUnsafeDownloadPath,
  unsafeDownloadPathMessage,
} from "./download-path-safety";

const repoRoot = "D:\\code\\torrent-aggregator";
const tempRoot = "C:\\Users\\owner\\AppData\\Local\\Temp";

const unsafeCases: Array<{
  name: string;
  path: string;
  reason:
    | "test-directory"
    | "dependencies"
    | "temporary-directory"
    | "inside-repository";
}> = [
  {
    name: "e2e scratch tree",
    path: "D:\\code\\torrent-aggregator\\.e2e-instant-play\\run-1\\leech",
    reason: "test-directory",
  },
  {
    name: "embedded e2e marker",
    path: "D:\\scratch\\media.e2e-cache\\leech",
    reason: "test-directory",
  },
  {
    name: "dependency tree",
    path: "D:\\apps\\node_modules\\torrentflow-cache",
    reason: "dependencies",
  },
  {
    name: "named temp segment",
    path: "/srv/tmp/torrentflow",
    reason: "temporary-directory",
  },
  {
    name: "operating-system temp root",
    path: "C:\\Users\\owner\\AppData\\Local\\Temp\\tf-downloads",
    reason: "temporary-directory",
  },
  {
    name: "ordinary folder inside repository",
    path: "D:\\code\\torrent-aggregator\\downloads",
    reason: "inside-repository",
  },
];

for (const testCase of unsafeCases) {
  const result = detectUnsafeDownloadPath(testCase.path, {
    repoRoot,
    tempRoots: [tempRoot],
  });
  assert.equal(result.unsafe, true, testCase.name);
  assert.ok(result.reasons.includes(testCase.reason), testCase.name);
  assert.match(unsafeDownloadPathMessage(result.reasons), /will not move/i);
}

for (const safePath of [
  "D:\\Media\\TorrentFlow",
  "/mnt/media/torrentflow",
  "D:\\code\\torrent-aggregator-media",
  "",
]) {
  assert.deepEqual(
    detectUnsafeDownloadPath(safePath, { repoRoot, tempRoots: [tempRoot] }),
    { unsafe: false, reasons: [] },
    safePath || "empty path",
  );
}

console.log("download-path-safety.test.ts: all assertions passed");
