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
  resolveBuiltinAddSelection,
  selectBuiltinAddUriForTests,
  STREAMING_STORE_CACHE_SLOTS,
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
  assert.equal(
    client.calls[0].opts.storeCacheSlots,
    STREAMING_STORE_CACHE_SLOTS,
    "playback keeps the streaming piece cache",
  );
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
  assert.equal(builtinAddOptions.storeCacheSlots, STREAMING_STORE_CACHE_SLOTS);
}

{
  const torrentUrl = "https://example.test/release.torrent";
  const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
  assert.equal(
    selectBuiltinAddUriForTests({
      magnet,
      torrentUrl,
    }),
    torrentUrl,
    ".torrent metadata is preferred when both inputs are available",
  );
  const client = fakeClient();
  addTorrentWithEngineDefaults(
    client,
    selectBuiltinAddUriForTests({ magnet, torrentUrl })!,
    "D:\\downloads",
  );
  assert.equal(
    client.calls[0].input,
    torrentUrl,
    "the add path feeds WebTorrent the .torrent URL instead of the magnet round-trip",
  );
  assert.equal(
    selectBuiltinAddUriForTests({
      magnet,
    }),
    magnet,
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

// Stream-only must add deselected (fetch only what is played), Download must
// select every file, and prewarm stays deselected + peer-capped. This is the
// decision the send path threads into the WebTorrent add.
{
  const stream = resolveBuiltinAddSelection({ streamOnly: true });
  assert.equal(stream.deselect, true, "stream-only adds with no whole-file selection");
  assert.equal(stream.selectAll, false, "stream-only must NOT select every file");
  assert.equal(stream.capPeers, false, "stream-only is a live stream, not peer-capped");

  const download = resolveBuiltinAddSelection({ streamOnly: false });
  assert.equal(download.deselect, false, "Download adds normally");
  assert.equal(download.selectAll, true, "Download selects every file so the whole file downloads");

  const noFlags = resolveBuiltinAddSelection({});
  assert.equal(noFlags.selectAll, true, "an unflagged send defaults to Download (select-all)");

  const prewarm = resolveBuiltinAddSelection({ connectOnly: true });
  assert.equal(prewarm.deselect, true, "prewarm stays deselected");
  assert.equal(prewarm.selectAll, false, "prewarm must NOT select every file");
  assert.equal(prewarm.capPeers, true, "prewarm speculation stays peer-capped");
}

// The stream-only decision reaches the real add: a deselected add is issued, so
// WebTorrent selects no pieces until the stream route explicitly does.
{
  const streamClient = fakeClient();
  const streamSel = resolveBuiltinAddSelection({ streamOnly: true });
  addTorrentWithEngineDefaults(
    streamClient,
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    "D:\\downloads",
    undefined,
    streamSel.deselect ? { deselect: true } : {},
  );
  assert.equal(
    streamClient.calls[0].opts.deselect,
    true,
    "stream-only reaches WebTorrent as a deselected add",
  );

  const dlClient = fakeClient();
  const dlSel = resolveBuiltinAddSelection({ streamOnly: false });
  addTorrentWithEngineDefaults(
    dlClient,
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    "D:\\downloads",
    undefined,
    dlSel.deselect ? { deselect: true } : {},
  );
  assert.notEqual(
    dlClient.calls[0].opts.deselect,
    true,
    "Download reaches WebTorrent with pieces selected (no deselect)",
  );
}

checkClientListeningTimeoutContinues()
  .then(() => {
    console.log("builtin-engine-trackers.test.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });