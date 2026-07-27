import assert from "node:assert/strict";

import {
  evaluateStall,
  STALL_MIN_DELIVERED_BYTES,
  STALL_WINDOW_MS,
  type TransferSample,
} from "./stall";

const MB = 1024 * 1024;

/** Build a series from `[secondsFromStart, downloadedBytes]` pairs. */
function series(
  points: Array<[number, number]>,
  state = "downloading",
  progressOf: (bytes: number) => number = (b) => b / (1000 * MB),
): TransferSample[] {
  const t0 = 1_000_000;
  return points.map(([sec, bytes]) => ({
    atMs: t0 + sec * 1000,
    downloadedBytes: bytes,
    progress: progressOf(bytes),
    state,
  }));
}

interface Case {
  name: string;
  samples: TransferSample[];
  expectStalled: boolean;
  expectReason: string;
}

const cases: Case[] = [
  {
    // The exact observed failure: six peers, downloading, progress frozen. Peer
    // count is not even a field — bytes are flat across a full window.
    name: "frozen download over a full window is stalled",
    samples: series([
      [0, 11_257_000],
      [10, 11_257_000],
      [20, 11_257_000],
      [35, 11_257_000],
    ]),
    expectStalled: true,
    expectReason: "stalled",
  },
  {
    // THE REGRESSION THAT MATTERS MOST: slow but real. ~120 KB/s is well under
    // any playable bitrate yet an order of magnitude over the floor, so it must
    // NOT be abandoned.
    name: "slow-but-progressing download is not stalled",
    samples: series([
      [0, 0],
      [10, 1_200_000],
      [20, 2_400_000],
      [35, 4_200_000],
    ]),
    expectStalled: false,
    expectReason: "progressing",
  },
  {
    // Delivered exactly the floor across the window → alive, not stalled.
    name: "exactly the delivered-bytes floor is not stalled",
    samples: series([
      [0, 0],
      [35, STALL_MIN_DELIVERED_BYTES],
    ]),
    expectStalled: false,
    expectReason: "progressing",
  },
  {
    // One byte under the floor across the window → stalled.
    name: "just under the floor is stalled",
    samples: series([
      [0, 0],
      [35, STALL_MIN_DELIVERED_BYTES - 1],
    ]),
    expectStalled: true,
    expectReason: "stalled",
  },
  {
    // Frozen but only 15s of history: still warming up, do not abandon yet.
    name: "frozen but inside the window is still warming up",
    samples: series([
      [0, 500_000],
      [8, 500_000],
      [15, 500_000],
    ]),
    expectStalled: false,
    expectReason: "insufficient-history",
  },
  {
    name: "a single sample is undetermined",
    samples: series([[0, 500_000]]),
    expectStalled: false,
    expectReason: "insufficient-history",
  },
  {
    // Zero content bytes but still fetching metadata is not a stall.
    name: "metadata phase is never stalled",
    samples: series([[0, 0], [35, 0]], "metaDL"),
    expectStalled: false,
    expectReason: "not-downloading",
  },
  {
    // Hash-checking existing data delivers no *new* content bytes; not a stall.
    name: "hash-check phase is never stalled",
    samples: series([[0, 0], [35, 0]], "checkingDL"),
    expectStalled: false,
    expectReason: "not-downloading",
  },
  {
    name: "paused is never stalled",
    samples: series([[0, 100], [35, 100]], "paused"),
    expectStalled: false,
    expectReason: "not-downloading",
  },
  {
    // Finished download that happens to be frozen (nothing left) is complete.
    name: "complete download is never stalled",
    samples: series([[0, 999 * MB], [35, 1000 * MB]], "downloading", () => 1),
    expectStalled: false,
    expectReason: "complete",
  },
  {
    // A one-tick backwards dip (piece-race guard substituting a prior reading)
    // must not, on its own, read as delivery — but real net gain over the
    // window still counts as progressing.
    name: "a transient backwards dip does not fake progress",
    samples: series([
      [0, 5_000_000],
      [10, 4_900_000],
      [35, 5_000_050],
    ]),
    expectStalled: true,
    expectReason: "stalled",
  },
];

function run() {
  for (const tc of cases) {
    const v = evaluateStall(tc.samples);
    assert.equal(v.stalled, tc.expectStalled, `${tc.name}: stalled`);
    assert.equal(v.reason, tc.expectReason, `${tc.name}: reason`);
  }

  // The window is honored: the same frozen data judged with a longer window has
  // no old-enough baseline and is undetermined rather than stalled.
  const frozen = series([[0, 0], [20, 0]]);
  assert.equal(evaluateStall(frozen, { windowMs: STALL_WINDOW_MS }).reason, "insufficient-history");
  assert.equal(evaluateStall(frozen, { windowMs: 15_000 }).stalled, true);

  console.log(`stall.test.ts: PASS (${cases.length} cases)`);
}

try {
  run();
} catch (err) {
  console.error("stall.test.ts: FAIL");
  console.error(err);
  process.exit(1);
}
