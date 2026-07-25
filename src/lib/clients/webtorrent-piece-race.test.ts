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

console.log("patchTorrentPieceRace: guarded getters…");

/**
 * Mimics `Torrent.prototype.downloaded`: walks pieces and throws once a piece
 * has been nulled. The tracker announce reads this on an interval, so no guard
 * on our request path can ever see the throw.
 */
function makeGetterProto() {
  const proto = {
    pieces: [] as ({ length: number } | null)[],
    get downloaded(): number {
      let total = 0;
      for (const p of (this as unknown as { pieces: ({ length: number } | null)[] }).pieces) {
        total += (p as { length: number }).length;
      }
      return total;
    },
  };
  patchTorrentPieceRace(proto);
  return proto;
}

check("a healthy getter is untouched", () => {
  resetSwallowedPieceRaces();
  const inst = Object.create(makeGetterProto()) as { pieces: unknown[]; downloaded: number };
  inst.pieces = [{ length: 10 }, { length: 5 }];
  assert.equal(inst.downloaded, 15);
  assert.equal(swallowedPieceRaces(), 0);
});

check("a nulled piece yields the last good value, not a jump to zero", () => {
  resetSwallowedPieceRaces();
  const inst = Object.create(makeGetterProto()) as { pieces: unknown[]; downloaded: number };
  inst.pieces = [{ length: 10 }, { length: 5 }];
  assert.equal(inst.downloaded, 15, "warm up the memo");
  inst.pieces = [{ length: 10 }, null];
  assert.equal(
    inst.downloaded,
    15,
    "progress must not visibly rewind while a piece is being nulled",
  );
  assert.equal(swallowedPieceRaces(), 1);
  // Recovers on its own once the race passes.
  inst.pieces = [{ length: 10 }, { length: 5 }, { length: 7 }];
  assert.equal(inst.downloaded, 22);
});

check("with no prior reading the fallback is used", () => {
  resetSwallowedPieceRaces();
  const inst = Object.create(makeGetterProto()) as { pieces: unknown[]; downloaded: number };
  inst.pieces = [null];
  assert.equal(inst.downloaded, 0);
  assert.equal(swallowedPieceRaces(), 1);
});

check("the memo is per-instance, so torrents cannot read each other's value", () => {
  resetSwallowedPieceRaces();
  const proto = makeGetterProto();
  const a = Object.create(proto) as { pieces: unknown[]; downloaded: number };
  const b = Object.create(proto) as { pieces: unknown[]; downloaded: number };
  a.pieces = [{ length: 99 }];
  assert.equal(a.downloaded, 99);
  b.pieces = [null];
  assert.equal(b.downloaded, 0, "b picked up a's cached value");
});

check("an unrelated getter error still propagates", () => {
  resetSwallowedPieceRaces();
  const proto = {
    get downloaded(): number {
      throw new RangeError("nope");
    },
  };
  patchTorrentPieceRace(proto);
  const inst = Object.create(proto) as { downloaded: number };
  assert.throws(() => inst.downloaded, RangeError);
  assert.equal(swallowedPieceRaces(), 0);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll piece-race tests passed.");
