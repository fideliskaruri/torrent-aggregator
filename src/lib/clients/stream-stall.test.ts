import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStreamStall,
  readWithStallGuard,
  sampleStreamTransfer,
  streamStallOptions,
  type StallSampleSource,
} from "./stream-stall";
import type { TransferSample } from "@/lib/playback/stall";

/**
 * The stall verdict is the heart of I45: a slow-but-progressing stream must
 * NEVER be declared stalled, and only a genuinely byte-frozen one must. Tested
 * as a rule across a table of sample series, not a single case.
 */
function series(
  points: Array<{ tMs: number; bytes: number; progress?: number }>,
): TransferSample[] {
  return points.map((p) => ({
    atMs: p.tMs,
    downloadedBytes: p.bytes,
    progress: p.progress ?? 0.1,
    state: "downloading",
    peerCount: 3,
  }));
}

const WINDOW = streamStallOptions().windowMs!;

test("progressing streams are never stalled, however slow", () => {
  const rows: Array<{ name: string; samples: TransferSample[] }> = [
    {
      name: "steady fast",
      samples: series([
        { tMs: 0, bytes: 0 },
        { tMs: WINDOW, bytes: 5_000_000 },
      ]),
    },
    {
      name: "trickle above floor",
      samples: series([
        { tMs: 0, bytes: 0 },
        { tMs: WINDOW, bytes: 300 * 1024 },
      ]),
    },
    {
      name: "bytes creeping the whole window",
      samples: series([
        { tMs: 0, bytes: 0 },
        { tMs: WINDOW / 2, bytes: 200 * 1024 },
        { tMs: WINDOW, bytes: 500 * 1024 },
      ]),
    },
  ];
  for (const row of rows) {
    const verdict = evaluateStreamStall(row.samples);
    assert.equal(verdict.stalled, false, row.name);
    assert.equal(verdict.reason, "progressing", row.name);
  }
});

test("only a genuinely byte-frozen stream is stalled", () => {
  const rows: Array<{ name: string; samples: TransferSample[]; stalled: boolean }> = [
    {
      name: "frozen with peers, some prior bytes",
      samples: series([
        { tMs: 0, bytes: 1_000_000 },
        { tMs: WINDOW + 1, bytes: 1_000_000 },
      ]),
      stalled: true,
    },
    {
      name: "below the delivery floor over the window",
      samples: series([
        { tMs: 0, bytes: 1_000_000 },
        { tMs: WINDOW + 1, bytes: 1_000_000 + 1024 },
      ]),
      stalled: true,
    },
    {
      name: "not enough history yet",
      samples: series([{ tMs: 0, bytes: 0 }]),
      stalled: false,
    },
  ];
  for (const row of rows) {
    const verdict = evaluateStreamStall(row.samples);
    assert.equal(verdict.stalled, row.stalled, row.name);
  }
});

test("sampleStreamTransfer derives bytes from downloaded or progress*length", () => {
  const withDownloaded: StallSampleSource = { downloaded: 4096, length: 8192, progress: 0.5 };
  assert.equal(sampleStreamTransfer(withDownloaded, 10).downloadedBytes, 4096);

  const fromProgress: StallSampleSource = { progress: 0.25, length: 8192 };
  assert.equal(sampleStreamTransfer(fromProgress, 10).downloadedBytes, 2048);

  const unknown: StallSampleSource = { progress: 0.5 };
  assert.equal(sampleStreamTransfer(unknown, 10).downloadedBytes, 0);
});

test("readWithStallGuard resolves ok when read wins", async () => {
  const signal = new AbortController().signal;
  const result = await readWithStallGuard(
    () => Promise.resolve("chunk"),
    signal,
    { sample: () => sampleStreamTransfer({ downloaded: 0, length: 100 }, Date.now()) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "chunk");
});

test("readWithStallGuard reports stalled on a frozen torrent and clears its timer", async () => {
  const controller = new AbortController();
  const bytes = 1_000_000; // static: no progress ever
  const start = 1_000_000;
  let clock = start;
  const result = await readWithStallGuard<string>(
    () => new Promise<string>(() => {}), // never resolves — the parked read
    controller.signal,
    {
      // A synthetic clock advances a full window per tick so the second sample
      // is old enough to reach a verdict deterministically.
      sample: () => {
        clock += 6_000;
        return sampleStreamTransfer({ downloaded: bytes, length: 2_000_000 }, clock);
      },
      options: streamStallOptions(),
      sampleIntervalMs: 1,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "stalled");
  // A stall verdict must carry diagnostics for the classifier.
  assert.ok(result.ok === false && result.verdict);
});

test("readWithStallGuard reports aborted when the signal fires first", async () => {
  const controller = new AbortController();
  const pending = readWithStallGuard<string>(
    () => new Promise<string>(() => {}),
    controller.signal,
    {
      sample: () => sampleStreamTransfer({ downloaded: 500, length: 1000 }, Date.now()),
      sampleIntervalMs: 10_000,
    },
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "aborted");
});

test("a throwing sampler cannot crash the guard", async () => {
  const controller = new AbortController();
  const result = await readWithStallGuard<string>(
    () => Promise.resolve("ok"),
    controller.signal,
    {
      sample: () => {
        throw new Error("sampler boom");
      },
    },
  );
  // read() still wins; the sampler throw was swallowed on the baseline push.
  assert.equal(result.ok, true);
});
