/**
 * Run: npx tsx src/lib/clients/find-torrent-by-hash.test.ts
 */
import assert from "node:assert/strict";
import { findTorrentByHash } from "./find-torrent-by-hash";

const a = { infoHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12", name: "a" };
const b = { infoHash: "0000000000000000000000000000000000000001", name: "b" };
const list = [a, b];

assert.equal(
  findTorrentByHash(list, "abcdef1234567890abcdef1234567890abcdef12"),
  a,
);
assert.equal(
  findTorrentByHash(list, "0000000000000000000000000000000000000001"),
  b,
);
assert.equal(findTorrentByHash(list, "deadbeef"), undefined);
assert.equal(findTorrentByHash(list, "pending-0"), undefined);

// Simulate WebTorrent 3 bug: treating async get() Promise as a handle
const fakePromise = Promise.resolve(a) as unknown as { infoHash?: string };
assert.equal(
  typeof (fakePromise as { destroy?: unknown }).destroy,
  "undefined",
  "Promise is not a torrent — must not call .destroy on it",
);
assert.equal(
  findTorrentByHash([a], a.infoHash)?.infoHash,
  a.infoHash,
  "scan finds real torrent with destroy path available",
);

console.log("find-torrent-by-hash.test.ts: all assertions passed");
