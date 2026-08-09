import assert from "node:assert/strict";
import {
  classifyPieceVerification,
  completionVerificationGapHashes,
  enginePressureSnapshot,
  liveEnginePressure,
  noteCompletionVerificationGap,
  redactEnginePressureDetails,
  resetCompletionVerificationNotices,
  type PressureTorrentLike,
} from "./engine-pressure";

/** Minimal fixture builder: only the fields a test actually cares about. */
function torrent(over: Partial<PressureTorrentLike> = {}): PressureTorrentLike {
  return {
    infoHash: "aa",
    name: "fixture",
    progress: 0.5,
    done: false,
    paused: false,
    ready: true,
    numPeers: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    ...over,
  };
}

/** A bitfield where the listed indexes are held. */
function bitfield(pieces: number, held: number[]): PressureTorrentLike {
  const set = new Set(held);
  return {
    pieces: Array.from({ length: pieces }, (_, i) => i),
    bitfield: { get: (index: number) => set.has(index) },
  };
}

// --- piece verification classification -------------------------------------

// A full bitfield is the only thing that counts as verified.
assert.equal(
  classifyPieceVerification({ ...torrent(), ...bitfield(3, [0, 1, 2]) }),
  "verified",
  "every piece held classifies as verified",
);
assert.equal(
  classifyPieceVerification({ ...torrent(), ...bitfield(3, [0, 2]) }),
  "incomplete",
  "a hole in the bitfield classifies as incomplete",
);

// "No bitfield to read" is NOT evidence of missing data — it must stay a third
// state, or a torrent that has not fetched metadata yet looks corrupt.
assert.equal(
  classifyPieceVerification(torrent()),
  "unknown",
  "absent pieces classify as unknown, not incomplete",
);
assert.equal(
  classifyPieceVerification({ ...torrent(), pieces: [], bitfield: { get: () => true } }),
  "unknown",
  "an empty piece list classifies as unknown",
);
assert.equal(
  classifyPieceVerification({ ...torrent(), pieces: [1, 2], bitfield: {} }),
  "unknown",
  "a bitfield without a getter classifies as unknown",
);

// A half-destroyed torrent throws from its own getters; diagnostics must not.
assert.equal(
  classifyPieceVerification({
    pieces: [1, 2],
    bitfield: {
      get: () => {
        throw new Error("destroyed");
      },
    },
  }),
  "unknown",
  "a throwing bitfield getter is tolerated as unknown",
);

// --- defensive tolerance ---------------------------------------------------

const hostile = enginePressureSnapshot({
  torrents: [
    // Throwing getters everywhere.
    {
      get infoHash(): string {
        throw new Error("boom");
      },
      get progress(): number {
        throw new Error("boom");
      },
      get numPeers(): number {
        throw new Error("boom");
      },
      get wires(): never {
        throw new Error("boom");
      },
    } as unknown as PressureTorrentLike,
    // Nonsense numbers.
    torrent({ infoHash: "bb", progress: Number.NaN, numPeers: -5 }),
    // Out-of-range progress.
    torrent({ infoHash: "cc", progress: 42 }),
    // Non-objects mixed into the list.
    null as unknown as PressureTorrentLike,
    undefined as unknown as PressureTorrentLike,
  ],
});
assert.equal(hostile.totals.torrents, 3, "non-object entries are skipped");
assert.equal(hostile.torrents[0].progress, 0, "a throwing getter falls back");
assert.equal(hostile.torrents[0].peers, 0, "a throwing peer count falls back");
assert.equal(hostile.torrents[1].progress, 0, "NaN progress falls back to 0");
assert.equal(hostile.torrents[1].peers, 0, "negative peers clamp to 0");
assert.equal(hostile.torrents[2].progress, 1, "progress clamps to 1");
assert.deepEqual(
  enginePressureSnapshot(null).totals.torrents,
  0,
  "a null input yields an empty snapshot",
);
assert.equal(
  enginePressureSnapshot(null).clientPresent,
  false,
  "no input means no client",
);
assert.doesNotThrow(() => liveEnginePressure(), "live read never throws");

// --- no mutation -----------------------------------------------------------

const leases = new Map<string, number>([["aa", 2]]);
const parking = new Map<string, unknown>([["user1:aa", Promise.resolve(true)]]);
const retries = new Map<string, unknown>([["user1:bb", 1]]);
const subject = { ...torrent({ infoHash: "aa" }), ...bitfield(2, [0, 1]) };
const before = JSON.stringify({
  keys: Object.keys(subject),
  leases: [...leases],
  parking: [...parking.keys()],
  retries: [...retries.keys()],
});
enginePressureSnapshot({
  torrents: [subject],
  streamLeases: leases,
  parking,
  parkingRetryTimers: retries,
  clientPresent: true,
});
assert.equal(
  JSON.stringify({
    keys: Object.keys(subject),
    leases: [...leases],
    parking: [...parking.keys()],
    retries: [...retries.keys()],
  }),
  before,
  "snapshotting mutates neither the torrent nor the engine maps",
);

// --- per-torrent reporting and totals --------------------------------------

const snapshot = enginePressureSnapshot({
  torrents: [
    // Complete and genuinely verified, pinned open by two stream readers.
    {
      ...torrent({
        infoHash: "AA",
        progress: 1,
        done: true,
        numPeers: 4,
        downloadSpeed: 100,
        uploadSpeed: 10,
      }),
      ...bitfield(2, [0, 1]),
      wires: [{ destroyed: false }, { destroyed: true }, {}],
    },
    // Claims 100% but the bitfield disagrees — the completion mismatch.
    {
      ...torrent({ infoHash: "bb", progress: 1, done: true, numPeers: 3 }),
      ...bitfield(4, [0, 1, 2]),
      wires: [{ destroyed: false }],
    },
    // Paused, no metadata yet: verification unknown.
    torrent({ infoHash: "cc", progress: 0.2, paused: true, numPeers: 1 }),
  ],
  streamLeases: new Map([["aa", 2]]),
  parking: new Map([["user1:bb", Promise.resolve(true)]]),
  parkingRetryTimers: new Map([["user1:cc", 1]]),
  clientPresent: true,
});

assert.equal(snapshot.clientPresent, true, "client presence is reported");

const [first, second, third] = snapshot.torrents;
assert.equal(first.infoHash, "aa", "info hashes are normalised to lower case");
assert.equal(first.pieceVerification, "verified");
assert.equal(first.completionMismatch, false, "verified completion is no mismatch");
assert.equal(first.wires, 2, "destroyed wires are not counted as live");
assert.equal(first.streamLeases, 2, "stream lease count is reported per torrent");
assert.equal(first.parking, false);

assert.equal(second.pieceVerification, "incomplete");
assert.equal(
  second.completionMismatch,
  true,
  "complete progress with an incomplete bitfield is a mismatch",
);
assert.equal(second.done, true, "the latched done flag is reported as-is");
assert.equal(second.parking, true, "userId-prefixed park keys match by hash");

assert.equal(third.paused, true);
assert.equal(third.pieceVerification, "unknown");
assert.equal(third.parkRetryPending, true, "pending detach retry is reported");
assert.equal(
  third.completionMismatch,
  false,
  "unknown verification is never reported as a mismatch",
);

assert.deepEqual(
  snapshot.totals,
  {
    torrents: 3,
    active: 2,
    paused: 1,
    complete: 1,
    peers: 8,
    wires: 3,
    downloadSpeed: 100,
    uploadSpeed: 10,
    streamLeases: 2,
    leasedTorrents: 1,
    parking: 1,
    parkRetryPending: 1,
    completionMismatch: 1,
    verificationUnknown: 1,
  },
  "totals aggregate every per-torrent fact",
);

const redacted = redactEnginePressureDetails(snapshot);
assert.deepEqual(redacted.torrents, [], "redacted diagnostics expose no torrent identities");
assert.deepEqual(redacted.totals, snapshot.totals, "redaction preserves aggregate pressure");
assert.notEqual(redacted.totals, snapshot.totals, "redaction does not alias mutable totals");
assert.equal(snapshot.torrents.length, 3, "redaction does not mutate the source snapshot");

// --- once-per-hash completion notice ---------------------------------------

resetCompletionVerificationNotices();
const logged: string[] = [];
const log = (message: string) => logged.push(message);

assert.equal(
  noteCompletionVerificationGap("HASH1", true, false, log),
  true,
  "the first sighting of a gap warns",
);
assert.equal(
  noteCompletionVerificationGap("hash1", true, false, log),
  false,
  "the same hash never warns twice, whatever its casing",
);
assert.equal(logged.length, 1, "a 5s poll cannot flood the log");
assert.equal(
  logged[0].includes("hash1"),
  true,
  "the warning names the offending hash",
);

assert.equal(
  noteCompletionVerificationGap("hash2", true, true, log),
  false,
  "a verified torrent at complete progress is not a gap",
);
assert.equal(
  noteCompletionVerificationGap("hash3", false, false, log),
  false,
  "an unverified torrent below complete progress is just downloading",
);
assert.equal(
  noteCompletionVerificationGap("", true, false, log),
  false,
  "a missing hash is not recorded",
);
assert.deepEqual(
  completionVerificationGapHashes(),
  ["hash1"],
  "only genuine gaps are remembered",
);
assert.doesNotThrow(
  () =>
    noteCompletionVerificationGap("hash9", true, false, () => {
      throw new Error("log sink down");
    }),
  "a failing log sink cannot break the engine read path",
);
resetCompletionVerificationNotices();

console.log(
  "PASS engine pressure: classification, tolerance, no mutation, totals, once-per-hash notice",
);
