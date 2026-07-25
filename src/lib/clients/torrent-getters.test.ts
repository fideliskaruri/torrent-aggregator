/**
 * Run: node_modules/.bin/tsx src/lib/clients/torrent-getters.test.ts
 *
 * Regression cover for a real outage: WebTorrent's `get downloaded()` walks
 * `pieces[]` and dereferences entries the library nulls out as pieces verify,
 * so `progress`/`timeRemaining`/`downloaded` throw
 * "Cannot read properties of null (reading 'length'|'missing')" on an otherwise
 * healthy torrent. We read those getters both to render /client and from a
 * background persist, so a single wobbly torrent 502'd the whole Client page
 * and spammed uncaughtException from a timer.
 */
import assert from "node:assert/strict";
import { mapTorrent, readProp, torrentStatus } from "./builtin-engine";

/** A getter that blows up exactly the way WebTorrent's does. */
function exploding(prop: string): never {
  throw new TypeError(`Cannot read properties of null (reading '${prop}')`);
}

type AnyTorrent = Parameters<typeof mapTorrent>[0];

function torrent(overrides: Record<string, unknown>): AnyTorrent {
  const base: Record<string, unknown> = {
    infoHash: "abc123",
    name: "Some Release",
    path: "/downloads",
    length: 100,
    progress: 0.5,
    downloadSpeed: 10,
    uploadSpeed: 5,
    timeRemaining: 60_000,
    numPeers: 3,
    paused: false,
    done: false,
  };
  return { ...base, ...overrides } as unknown as AnyTorrent;
}

/** Define `prop` as a throwing getter, like a live WebTorrent instance. */
function withThrowingGetter(
  overrides: Record<string, unknown>,
  prop: string,
): AnyTorrent {
  const t = torrent(overrides) as unknown as Record<string, unknown>;
  Object.defineProperty(t, prop, {
    get: () => exploding(prop === "progress" ? "length" : "missing"),
    enumerable: true,
  });
  return t as unknown as AnyTorrent;
}

function main() {
  // readProp: substitutes the fallback for throws, null/undefined and non-finite
  {
    const cases: {
      name: string;
      read: () => unknown;
      fallback: unknown;
      expected: unknown;
    }[] = [
      { name: "plain value", read: () => 7, fallback: 0, expected: 7 },
      { name: "zero is kept", read: () => 0, fallback: 9, expected: 0 },
      {
        name: "false is kept",
        read: () => false,
        fallback: true,
        expected: false,
      },
      {
        name: "empty string is kept",
        read: () => "",
        fallback: "x",
        expected: "",
      },
      { name: "throws", read: () => exploding("length"), fallback: 0, expected: 0 },
      { name: "null", read: () => null, fallback: 0, expected: 0 },
      { name: "undefined", read: () => undefined, fallback: 0, expected: 0 },
      { name: "NaN", read: () => Number.NaN, fallback: 0, expected: 0 },
      { name: "Infinity", read: () => Infinity, fallback: 0, expected: 0 },
    ];
    for (const c of cases) {
      assert.equal(
        readProp(c.read as () => unknown, c.fallback),
        c.expected,
        `readProp: ${c.name}`,
      );
    }
  }

  // Every getter mapTorrent touches must be survivable on its own.
  {
    const props = [
      "progress",
      "length",
      "name",
      "path",
      "downloadSpeed",
      "uploadSpeed",
      "timeRemaining",
      "numPeers",
      "paused",
      "done",
    ];
    for (const prop of props) {
      const t = withThrowingGetter({}, prop);
      const row = mapTorrent(t);
      assert.ok(row, `mapTorrent threw on: ${prop}`);
      assert.equal(typeof row.progress, "number", `progress NaN-free: ${prop}`);
      assert.equal(typeof row.sizeBytes, "number", `sizeBytes: ${prop}`);
      assert.ok(row.name, `name should fall back to the hash: ${prop}`);
      assert.ok(
        ["downloading", "paused", "seeding", "stalledDL"].includes(row.state),
        `state should stay valid: ${prop}`,
      );
    }
  }

  // The exact production failure: progress throws while everything else works.
  {
    const t = withThrowingGetter({}, "progress");
    const row = mapTorrent(t);
    assert.equal(row.progress, 0);
    assert.equal(row.sizeBytes, 100);
    assert.equal(row.name, "Some Release");
  }

  // Status derivation stays correct for healthy torrents.
  {
    const cases: {
      name: string;
      t: AnyTorrent;
      expected: string;
    }[] = [
      { name: "paused wins", t: torrent({ paused: true, done: true }), expected: "paused" },
      { name: "done seeds", t: torrent({ done: true }), expected: "seeding" },
      {
        name: "no peers and incomplete stalls",
        t: torrent({ numPeers: 0, progress: 0.2 }),
        expected: "stalledDL",
      },
      {
        name: "peers means downloading",
        t: torrent({ numPeers: 2, progress: 0.2 }),
        expected: "downloading",
      },
      {
        name: "a torrent that cannot report progress is not called stalled",
        t: withThrowingGetter({ numPeers: 4 }, "progress"),
        expected: "downloading",
      },
    ];
    for (const c of cases) {
      assert.equal(torrentStatus(c.t), c.expected, `torrentStatus: ${c.name}`);
    }
  }

  // A non-finite timeRemaining (WebTorrent returns Infinity at 0 B/s) must not
  // become an absurd ETA.
  {
    assert.equal(mapTorrent(torrent({ timeRemaining: Infinity })).eta, undefined);
    assert.equal(mapTorrent(torrent({ timeRemaining: 0 })).eta, undefined);
    assert.equal(mapTorrent(torrent({ timeRemaining: 60_000 })).eta, 60);
  }

  console.log("torrent-getters.test.ts: all assertions passed");
}

main();
