/**
 * The piece-race patch must swallow exactly WebTorrent's nulled-piece throw and
 * nothing else. Getting this wrong in either direction is bad: too narrow and
 * the log floods again, too broad and we silently eat real bugs in the download
 * scheduler.
 */
import assert from "node:assert/strict";
import {
  isNullPieceError,
  patchTorrentPieceRace,
  repairedPieceCount,
  resetSwallowedPieceRaces,
  swallowedPieceRaces,
} from "@/lib/clients/webtorrent-piece-race";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log("isNullPieceError: the real production messages…");

// Captured verbatim from prod-server.log.
const REAL = [
  "Cannot read properties of null (reading 'reserve')",
  "Cannot read properties of null (reading 'missing')",
  "Cannot read properties of null (reading 'length')",
  "Cannot read properties of null (reading 'reserveRemaining')",
];
for (const msg of REAL) {
  check(msg, () => assert.equal(isNullPieceError(new TypeError(msg)), true));
}

console.log("isNullPieceError: must NOT swallow…");

const NOT_OURS: [string, unknown][] = [
  ["a different null property", new TypeError("Cannot read properties of null (reading 'magnetURI')")],
  ["undefined rather than null", new TypeError("Cannot read properties of undefined (reading 'reserve')")],
  ["a non-TypeError with the same text", new Error("Cannot read properties of null (reading 'reserve')")],
  ["an unrelated TypeError", new TypeError("x is not a function")],
  ["a thrown string", "Cannot read properties of null (reading 'reserve')"],
  ["null itself", null],
];
for (const [name, err] of NOT_OURS) {
  check(name, () => assert.equal(isNullPieceError(err), false));
}

console.log("patchTorrentPieceRace: behaviour…");

type Proto = {
  _request: (...a: unknown[]) => unknown;
  _updateWire: (...a: unknown[]) => unknown;
  calls: number;
};

function makeProto(thrower: () => never | void): Proto {
  return {
    calls: 0,
    _request(this: Proto, ...args: unknown[]) {
      this.calls += 1;
      thrower();
      return args[0];
    },
    _updateWire(this: Proto) {
      this.calls += 1;
      thrower();
      return "ok";
    },
  };
}

check("a healthy call is passed through untouched, with args and `this`", () => {
  const proto = makeProto(() => {});
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as Proto;
  assert.equal(inst._request("wire", 3), "wire");
  assert.equal(inst._updateWire(), "ok");
  assert.equal(inst.calls, 2, "`this` did not reach the original method");
});

check("_request returns false on the race so callers move to the next piece", () => {
  resetSwallowedPieceRaces();
  const proto = makeProto(() => {
    throw new TypeError("Cannot read properties of null (reading 'reserve')");
  });
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as Proto;
  assert.equal(inst._request("wire", 3), false);
  assert.equal(swallowedPieceRaces(), 1);
});

check("_updateWire swallows the race and returns undefined", () => {
  resetSwallowedPieceRaces();
  const proto = makeProto(() => {
    throw new TypeError("Cannot read properties of null (reading 'missing')");
  });
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as Proto;
  assert.equal(inst._updateWire(), undefined);
  assert.equal(swallowedPieceRaces(), 1);
});

check("an unrelated error still propagates", () => {
  resetSwallowedPieceRaces();
  const boom = new RangeError("out of range");
  const proto = makeProto(() => {
    throw boom;
  });
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as Proto;
  assert.throws(() => inst._request(), (e: unknown) => e === boom);
  assert.equal(swallowedPieceRaces(), 0, "an unrelated error was counted");
});

check("patching twice does not double-wrap", () => {
  resetSwallowedPieceRaces();
  const proto = makeProto(() => {
    throw new TypeError("Cannot read properties of null (reading 'reserve')");
  });
  patchTorrentPieceRace(proto);
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as Proto;
  inst._request();
  assert.equal(swallowedPieceRaces(), 1, "the race was counted twice");
  assert.equal(inst.calls, 1, "the original ran twice");
});

check("a prototype missing the methods is tolerated", () => {
  assert.doesNotThrow(() => patchTorrentPieceRace({}));
});

check("a verified piece short-circuits without ever calling the original", () => {
  resetSwallowedPieceRaces();
  let called = 0;
  const proto = {
    pieces: [] as unknown[],
    _request() {
      called += 1;
      return true;
    },
  };
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as {
    pieces: unknown[];
    bitfield: { get: (i: number) => boolean };
    _request: (w: unknown, i: number, h: boolean) => boolean;
  };
  inst.pieces = [null, { reserve: () => 0 }];
  // Piece 0 is null *and* its bit is set: verified and complete.
  inst.bitfield = { get: (i: number) => i === 0 };

  assert.equal(inst._request({}, 0, false), false, "verified piece returns false");
  assert.equal(called, 0, "the original must not run for a verified piece");
  assert.equal(
    swallowedPieceRaces(),
    0,
    "the fast path must not construct an exception at all",
  );

  assert.equal(inst._request({}, 1, false), true, "a live piece is passed through");
  assert.equal(called, 1);
});

check("a leaked piece is reinstated and then requested", () => {
  resetSwallowedPieceRaces();
  let called = 0;
  const proto = {
    pieces: [] as unknown[],
    _request() {
      called += 1;
      return true;
    },
  };
  patchTorrentPieceRace(proto);
  const marked: number[] = [];
  const inst = Object.create(proto) as {
    pieces: unknown[];
    bitfield: { get: (i: number) => boolean };
    _markUnverified: (i: number) => void;
    _request: (w: unknown, i: number, h: boolean) => boolean;
  };
  // Null piece with its bit *unset*: leaked, unreachable by the scheduler.
  inst.pieces = [null];
  inst.bitfield = { get: () => false };
  inst._markUnverified = (i: number) => {
    marked.push(i);
    inst.pieces[i] = { reserve: () => 0 };
  };

  assert.equal(inst._request({}, 0, false), true, "the repaired piece is requested");
  assert.deepEqual(marked, [0], "upstream repair ran for the leaked piece");
  assert.equal(called, 1, "the original runs once the piece exists again");
  assert.equal(repairedPieceCount(), 1, "the repair is counted");
});

check("a leaked piece is skipped when upstream repair is unavailable", () => {
  resetSwallowedPieceRaces();
  let called = 0;
  const proto = {
    pieces: [] as unknown[],
    _request() {
      called += 1;
      return true;
    },
  };
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as {
    pieces: unknown[];
    bitfield: { get: (i: number) => boolean };
    _request: (w: unknown, i: number, h: boolean) => boolean;
  };
  inst.pieces = [null];
  inst.bitfield = { get: () => false };

  assert.equal(inst._request({}, 0, false), false, "falls back to skipping");
  assert.equal(called, 0, "the original must not run on a null piece");
  assert.equal(repairedPieceCount(), 0);
});

check("a missing bitfield is treated as nothing to request", () => {
  resetSwallowedPieceRaces();
  let called = 0;
  const proto = {
    pieces: [] as unknown[],
    _request() {
      called += 1;
      return true;
    },
  };
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as {
    pieces: unknown[];
    _request: (w: unknown, i: number, h: boolean) => boolean;
  };
  inst.pieces = [null];

  assert.equal(inst._request({}, 0, false), false);
  assert.equal(called, 0, "no bitfield means no safe repair decision");
  assert.equal(repairedPieceCount(), 0);
});

console.log("patchTorrentPieceRace: the downloaded getter…");

/**
 * Mimics the real `Torrent.prototype` shape the getter reads: a bitfield of
 * verified pieces plus a `pieces[]` whose entries are nulled on verify.
 */
function makeTorrentProto() {
  const proto = {
    pieceLength: 10,
    lastPieceLength: 4,
    bitfield: undefined as undefined | { get: (i: number) => boolean },
    pieces: [] as ({ length: number; missing: number } | null)[],
    get downloaded(): number {
      throw new Error("upstream getter should have been replaced");
    },
  };
  patchTorrentPieceRace(proto);
  return proto;
}

type Inst = {
  pieces: ({ length: number; missing: number } | null)[];
  bitfield?: { get: (i: number) => boolean };
  downloaded: number;
};

function bits(set: number[]) {
  return { get: (i: number) => set.includes(i) };
}

check("verified pieces count as whole pieces, the last one shorter", () => {
  const inst = Object.create(makeTorrentProto()) as Inst;
  inst.pieces = [null, null, null];
  inst.bitfield = bits([0, 1, 2]);
  // 10 + 10 + lastPieceLength(4)
  assert.equal(inst.downloaded, 24);
});

check("partially received pieces count their received bytes", () => {
  const inst = Object.create(makeTorrentProto()) as Inst;
  inst.pieces = [null, { length: 10, missing: 6 }, { length: 4, missing: 4 }];
  inst.bitfield = bits([0]);
  // 10 verified + (10-6) in flight + (4-4) untouched
  assert.equal(inst.downloaded, 14);
});

/**
 * The regression this whole patch exists for. `_markVerified` nulls the piece
 * one line *before* it sets the bitfield bit, so this exact state occurs on
 * every verified piece. It must not throw, and it must not freeze.
 */
check("a piece nulled before its bit is set does not throw and does not freeze", () => {
  const inst = Object.create(makeTorrentProto()) as Inst;
  inst.pieces = [null, { length: 10, missing: 0 }];
  inst.bitfield = bits([]); // mid-_markVerified: nulled, bit not yet set
  assert.equal(
    inst.downloaded,
    10,
    "the nulled piece contributes 0 rather than throwing",
  );

  // One tick later the bit is set — and the number must move.
  inst.bitfield = bits([0]);
  assert.equal(inst.downloaded, 20, "progress must advance, not stay frozen");
});

check("progress advances across a long run instead of pinning to one value", () => {
  const inst = Object.create(makeTorrentProto()) as Inst;
  inst.pieces = [null, null, null];
  const seen: number[] = [];
  for (const set of [[], [0], [0, 1], [0, 1, 2]]) {
    inst.bitfield = bits(set);
    seen.push(inst.downloaded);
  }
  assert.deepEqual(seen, [0, 10, 20, 24]);
});

check("a torrent with no bitfield yet reports zero rather than throwing", () => {
  const inst = Object.create(makeTorrentProto()) as Inst;
  inst.pieces = [null];
  inst.bitfield = undefined;
  assert.equal(inst.downloaded, 0);
});

check("a prototype without the getter is tolerated", () => {
  assert.doesNotThrow(() => patchTorrentPieceRace({ foo: 1 }));
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll piece-race tests passed.");
