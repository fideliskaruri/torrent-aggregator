import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addTorrentWithEngineDefaults,
  applyForegroundUploadThrottleForTests,
  builtinAddOptions,
  configureBuiltinClientListeningWaitForTests,
  PUBLIC_TRACKERS,
  rehydrateFailureDataForTests,
  selectBuiltinAddUriForTests,
  waitForClientListeningForTests,
  withPublicTrackers,
} from "./builtin-engine";

type Added = {
  input: string | Uint8Array;
  opts: {
    path?: string;
    announce?: string[];
    strategy?: string;
    storeCacheSlots?: number;
    deselect?: boolean;
  };
};

function fakeClient() {
  const calls: Added[] = [];
  return {
    calls,
    add(
      input: string | Uint8Array,
      opts?: Added["opts"],
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
  assert.equal(client.calls[0].opts.storeCacheSlots, 200, "playback keeps a larger piece cache");
}

{
  const client = fakeClient();
  addTorrentWithEngineDefaults(
    client,
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    "D:\\downloads",
    undefined,
    { deselect: true },
  );
  assert.equal(client.calls[0].opts.deselect, true, "prewarm starts with no selected pieces");
}

{
  assert.deepEqual(
    builtinAddOptions.announce,
    PUBLIC_TRACKERS,
    "the exported probe options and engine options must agree on trackers",
  );
  assert.equal(builtinAddOptions.storeCacheSlots, 200);
}

{
  assert.equal(
    selectBuiltinAddUriForTests({
      magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
      torrentUrl: "https://example.test/release.torrent",
    }),
    "https://example.test/release.torrent",
    ".torrent metadata is preferred when both inputs are available",
  );
  assert.equal(
    selectBuiltinAddUriForTests({
      magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    }),
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    "magnet remains the fallback when no .torrent URL is available",
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

async function checkClientListeningTimeoutContinues() {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const fakeClient = {
      torrents: [],
      listening: false,
      add(_input: string | Uint8Array) {
        return { on() {} };
      },
      get() {},
      destroy() {},
      on(event: string, fn: (...args: unknown[]) => void) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(fn);
      },
      once(event: string, fn: (...args: unknown[]) => void) {
        this.on(event, fn);
      },
      removeListener(event: string, fn: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(fn);
      },
    };

    configureBuiltinClientListeningWaitForTests({ timeoutMs: 1 });
    await waitForClientListeningForTests(fakeClient as never);
    await waitForClientListeningForTests(fakeClient as never);
    assert.equal(warnings.length, 1, "peer-listener timeout warning is emitted once");
    assert.match(
      warnings[0],
      /peer listener did not open.*continuing anyway/i,
      "timeout warning must say the engine continues",
    );
    assert.equal(
      listeners.get("listening")?.size ?? 0,
      0,
      "timed-out wait removes its listening listener",
    );
    const usable = fakeClient.add("magnet:?xt=urn:btih:0123456789012345678901234567890123456789");
    assert.equal(typeof usable.on, "function", "client remains usable after listener timeout");
  } finally {
    configureBuiltinClientListeningWaitForTests(null);
    console.warn = originalWarn;
  }
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
  assert.ok(
    !source.includes("Download started (") &&
      !source.includes("Downloading in built-in engine"),
    "the engine must return structured transfer details, not product copy",
  );
}

for (const err of [
  new Error("malformed magnet URI"),
  "Timed out restoring torrent metadata",
  "",
]) {
  const data = rehydrateFailureDataForTests(err);
  assert.equal(data.status, "error");
  assert.ok(data.error.length > 0, "rehydrate failures must leave an explainable row");
}

checkClientListeningTimeoutContinues()
  .then(() => {
    console.log("builtin-engine-trackers.test.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
