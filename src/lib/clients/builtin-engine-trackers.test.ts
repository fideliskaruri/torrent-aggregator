import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addTorrentWithEngineDefaults,
  applyForegroundUploadThrottleForTests,
  builtinAddOptions,
  PUBLIC_TRACKERS,
  withPublicTrackers,
} from "./builtin-engine";

type Added = {
  input: string | Uint8Array;
  opts: { path?: string; announce?: string[]; strategy?: string };
};

function fakeClient() {
  const calls: Added[] = [];
  return {
    calls,
    add(
      input: string | Uint8Array,
      opts?: { path?: string; announce?: string[]; strategy?: string },
    ) {
      calls.push({ input, opts: opts ?? {} });
      return { on() {} } as never;
    },
  };
}

function trackersFromMagnet(uri: string): string[] {
  return new URL(uri).searchParams.getAll("tr");
}

function assertNoDuplicateTrackers(trackers: string[]) {
  assert.equal(
    new Set(trackers.map((x) => x.toLowerCase().replace(/\/+$/, ""))).size,
    trackers.length,
    "normalised trackers must not be announced twice",
  );
}

{
  const own = "udp://release.tracker.example:6969/announce";
  const magnet = `magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=${encodeURIComponent(own)}`;
  const rewritten = withPublicTrackers(magnet);
  const trackers = trackersFromMagnet(rewritten);
  assert.ok(trackers.includes(own), "the release tracker must be kept");
  for (const tracker of PUBLIC_TRACKERS) {
    assert.ok(trackers.includes(tracker), `fallback tracker added: ${tracker}`);
  }
}

{
  const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
  const trackers = trackersFromMagnet(withPublicTrackers(magnet));
  assert.deepEqual(trackers, PUBLIC_TRACKERS, "bare magnets gain the public list");
}

{
  const magnet =
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789" +
    "&tr=udp%3A%2F%2FTRACKER.OPENTRACKR.ORG%3A1337%2Fannounce%2F";
  const trackers = trackersFromMagnet(withPublicTrackers(magnet));
  assertNoDuplicateTrackers(trackers);
}

for (const tracker of [
  "http://127.0.0.1:12345/announce",
  "http://localhost:12345/announce",
  "http://[::1]:12345/announce",
  "http://10.1.2.3:12345/announce",
  "http://192.168.1.20:12345/announce",
  "http://172.16.0.1:12345/announce",
  "http://172.31.255.254:12345/announce",
]) {
  const magnet = `magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=${encodeURIComponent(tracker)}`;
  const trackers = trackersFromMagnet(withPublicTrackers(magnet));
  assert.deepEqual(trackers, [tracker], `local-only swarm stays private: ${tracker}`);

  const client = fakeClient();
  addTorrentWithEngineDefaults(client, magnet, "D:\\downloads");
  assert.deepEqual(
    client.calls[0].opts.announce,
    [],
    `client.add does not add public trackers for local-only swarm: ${tracker}`,
  );
}

{
  const local = "http://127.0.0.1:12345/announce";
  const publicTracker = "udp://release.tracker.example:6969/announce";
  const magnet =
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789" +
    `&tr=${encodeURIComponent(local)}` +
    `&tr=${encodeURIComponent(publicTracker)}`;
  const trackers = trackersFromMagnet(withPublicTrackers(magnet));
  assert.ok(trackers.includes(local), "a local mirror is kept");
  assert.ok(trackers.includes(publicTracker), "the release public tracker is kept");
  for (const tracker of PUBLIC_TRACKERS) {
    assert.ok(
      trackers.includes(tracker),
      `mixed local+public magnet still gains public breadth: ${tracker}`,
    );
  }
}

{
  const own = "udp://release.tracker.example:6969/announce";
  const client = fakeClient();
  addTorrentWithEngineDefaults(
    client,
    `magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=${encodeURIComponent(own)}`,
    "D:\\downloads",
  );
  assert.deepEqual(client.calls[0].opts.announce, PUBLIC_TRACKERS);
  assert.deepEqual(trackersFromMagnet(client.calls[0].input.toString()), [own]);
}

{
  const client = fakeClient();
  addTorrentWithEngineDefaults(client, "D:\\torrents\\release.torrent", "D:\\downloads");
  assert.deepEqual(
    client.calls[0].opts.announce,
    PUBLIC_TRACKERS,
    ".torrent and other non-magnet inputs gain the same fallback announce list",
  );
}

{
  assert.deepEqual(
    builtinAddOptions.announce,
    PUBLIC_TRACKERS,
    "the exported probe options and engine options must agree on trackers",
  );
}

{
  const calls: number[] = [];
  const client = {
    throttleUpload(rate: number) {
      calls.push(rate);
    },
    throttleDownload() {
      throw new Error("download must never be throttled");
    },
  };
  applyForegroundUploadThrottleForTests(client, true);
  applyForegroundUploadThrottleForTests(client, false);
  assert.ok(calls[0] > 0, "foreground upload cap must be a non-zero floor");
  assert.equal(calls[1], -1, "idle restores unlimited upload");
}

{
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin-engine.ts"),
    "utf8",
  );
  const liveAddCalls = source
    .split(/\r?\n/)
    .filter((line) => line.includes("client.add("))
    .filter((line) => !line.trimStart().startsWith("*"))
    .filter((line) => !line.trimStart().startsWith("//"));
  assert.equal(
    liveAddCalls.length,
    1,
    "all WebTorrent add calls must flow through addTorrentWithEngineDefaults",
  );
}

console.log("builtin-engine-trackers.test.ts: all assertions passed");
