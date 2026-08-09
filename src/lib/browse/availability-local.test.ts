import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveLocalOnly } from "./availability";

const query = { title: "Moon Knight", season: 1, episode: 1 };
const downloaded = {
  hash: "abc",
  name: "Moon Knight S01E01 1080p",
  progress: 1,
  status: "downloaded",
  savePath: "D:\\Media",
  verifiedBitfield: "AQ==",
  verifiedFilesJson: '[{"path":"Moon Knight S01E01.mkv"}]',
};

assert.deepEqual(
  resolveLocalOnly(
    query,
    [downloaded],
    () => "absent",
    () => "present",
  ),
  { state: "ready", infoHash: "abc" },
  "a verified local file is Ready without a live WebTorrent session",
);

assert.equal(
  resolveLocalOnly(
    query,
    [downloaded],
    () => "absent",
    () => "absent",
  ),
  null,
  "a confirmed missing file cannot advertise Ready",
);

assert.deepEqual(
  resolveLocalOnly(
    query,
    [{ ...downloaded, progress: 0.4, status: "downloading" }],
    () => "absent",
    () => "present",
  ),
  { state: null },
  "partial content still requires a live engine",
);

const source = readFileSync(new URL("./availability.ts", import.meta.url), "utf8");
const singleStart = source.indexOf("export async function resolveAvailability(");
const batchStart = source.indexOf("export async function resolveAvailabilityBatch(");
const localBatchStart = source.indexOf("export async function resolveLocalAvailabilityBatch(");
const singleSource = source.slice(singleStart, batchStart);
const batchSource = source.slice(batchStart, localBatchStart);

assert.ok(
  singleSource.indexOf("resolveLocalOnly(") < singleSource.indexOf("getCached(cacheKey)"),
  "single availability must re-check local state before using a search-derived memo",
);
assert.match(
  batchSource,
  /const local = resolveLocalOnly\([\s\S]*?if \(local !== null\) return local;[\s\S]*?return getCached\(/,
  "batch availability must let newly local content override cached search state",
);
