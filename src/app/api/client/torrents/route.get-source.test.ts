import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const getStart = source.indexOf("export async function GET(");
const postStart = source.indexOf("export async function POST(", getStart);
assert.ok(getStart >= 0 && postStart > getStart, "GET source block exists");
const getSource = source.slice(getStart, postStart);

assert.doesNotMatch(
  getSource,
  /acquisitionTarget\.(?:update|updateMany|create|delete)/,
  "torrent-list GET cannot reconcile acquisition state",
);
assert.doesNotMatch(
  getSource,
  /engineTorrent\.(?:update|updateMany|create|delete)/,
  "torrent-list GET cannot mutate durable torrent state",
);
assert.match(
  getSource,
  /acquisitionWorksForUser\(session\.user\.id,\s*hashes\)/,
  "torrent-list GET carries canonical acquisition identity into Downloads",
);
assert.match(getSource, /workId:\s*target\.workId/);
assert.match(getSource, /workKey:\s*target\.workKey/);
assert.match(getSource, /season:\s*target\.season/);
assert.match(getSource, /episode:\s*target\.episode/);
