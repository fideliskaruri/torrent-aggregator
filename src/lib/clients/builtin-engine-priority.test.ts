import assert from "node:assert/strict";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "./builtin-engine";
import {
  isMatroskaContainer,
  prefetchBuiltinFileEdges,
  prioritizeBuiltinStreamFile,
  resetBuiltinStreamPriorityForTests,
  resolveStreamTailPriority,
  seekIndexPlan,
} from "./builtin-engine";

type Selection = {
  start: number;
  end: number;
  priority: number | undefined;
  stream: boolean | undefined;
};

type FakeFile = BuiltinStreamFile & {
  offset: number;
  _startPiece: number;
  _endPiece: number;
  selectCalls: number[];
  deselectCalls: number;
};

function fakeFile(path: string, start: number, end: number, offset: number): FakeFile {
  return {
    name: path.split("/").pop() || path,
    path,
    length: (end - start + 1) * 1024,
    offset,
    _startPiece: start,
    _endPiece: end,
    selectCalls: [],
    deselectCalls: 0,
    select(priority?: number) {
      this.selectCalls.push(priority ?? 0);
    },
    deselect() {
      this.deselectCalls += 1;
    },
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    },
  } as FakeFile;
}

function fakeTorrent(files: FakeFile[], pieceLength = 1024 * 1024): BuiltinStreamTorrent & {
  pieceLength: number;
  pieces: unknown[];
  bitfield?: { get(index: number): boolean };
  selections: Selection[];
  deselections: Array<{ start: number; end: number; stream: boolean | undefined }>;
  publicDeselections: Array<{ start: number; end: number }>;
  criticalCalls: Array<{ start: number; end: number }>;
  deselect: (start: number, end: number) => void;
  _select: (
    start: number,
    end: number,
    priority?: number,
    notify?: (() => void) | null,
    stream?: boolean,
  ) => void;
  critical: (start: number, end: number) => void;
  _deselect: (start: number, end: number, stream?: boolean) => void;
} {
  return {
    infoHash: "abcdef1234567890abcdef1234567890abcdef12",
    name: "Season pack",
    progress: 0,
    downloadSpeed: 0,
    numPeers: 1,
    files,
    pieceLength,
    pieces: new Array(60).fill({}),
    bitfield: undefined,
    selections: [],
    deselections: [],
    publicDeselections: [],
    criticalCalls: [],
    deselect(start, end) {
      this.publicDeselections.push({ start, end });
    },
    _select(start, end, priority, _notify, stream) {
      this.selections.push({ start, end, priority, stream });
    },
    _deselect(start, end, stream) {
      this.deselections.push({ start, end, stream });
    },
    critical(start, end) {
      this.criticalCalls.push({ start, end });
    },
  };
}

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    resetBuiltinStreamPriorityForTests();
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

async function main() {
  await check("open marks the played file head critical while siblings are deselected", () => {
    const ep1 = fakeFile("Show/S01E01.mkv", 0, 9, 0);
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 49, 40 * 1024);
    const ep6 = fakeFile("Show/S01E06.mkv", 50, 59, 50 * 1024);
    const torrent = fakeTorrent([ep1, ep5, ep6]);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(ep1.selectCalls, []);
    assert.deepEqual(ep6.selectCalls, []);
    assert.equal(ep1.deselectCalls, 1);
    assert.equal(ep6.deselectCalls, 1);
    assert.deepEqual(torrent.publicDeselections, [{ start: 0, end: 59 }]);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 48, end: 49, priority: 1, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [{ start: 40, end: 41 }]);
  });

  await check("repeat open reasserts the critical head without reselecting pieces", () => {
    const ep1 = fakeFile("Show/S01E01.mkv", 0, 9, 0);
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 49, 40 * 1024);
    const torrent = fakeTorrent([ep1, ep5]);
    let prefetches = 0;

    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => {
        prefetches += 1;
      },
    });
    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => {
        prefetches += 1;
      },
    });

    assert.deepEqual(ep1.selectCalls, []);
    assert.equal(ep1.deselectCalls, 1);
    assert.deepEqual(torrent.publicDeselections, [{ start: 0, end: 59 }]);
    assert.equal(torrent.selections.length, 2);
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 41 },
      { start: 40, end: 41 },
    ]);
    assert.equal(prefetches, 1);
  });

  await check("switching files drops the old priority overlay and reclaims the swarm", () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 49, 40 * 1024);
    const ep6 = fakeFile("Show/S01E06.mkv", 50, 59, 50 * 1024);
    const torrent = fakeTorrent([ep5, ep6]);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => undefined,
    });
    prioritizeBuiltinStreamFile(torrent, ep6, {
      prefetchEdges: async () => undefined,
    });

    assert.equal(ep5.deselectCalls, 2);
    assert.equal(ep6.deselectCalls, 2);
    assert.deepEqual(torrent.publicDeselections, [
      { start: 0, end: 59 },
      { start: 0, end: 59 },
    ]);
    assert.deepEqual(torrent.deselections, [
      { start: 40, end: 41, stream: true },
      { start: 48, end: 49, stream: true },
    ]);
    assert.deepEqual(ep5.selectCalls, []);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 48, end: 49, priority: 1, stream: true },
      { start: 50, end: 51, priority: 3, stream: true },
      { start: 58, end: 59, priority: 1, stream: true },
    ]);
  });

  await check("seek offset marks the requested pieces urgent and keeps the MKV index", () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 60, 40 * 1024);
    const torrent = fakeTorrent([ep5], 1024);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      seekOffset: 5 * 1024,
      prefetchEdges: async () => undefined,
    });

    // The whole small file is its own head window here, so keeping the MKV head
    // index critical alongside the seek target is what a viewer needs to land
    // audio and video on the same cluster.
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 60, priority: 3, stream: true },
      { start: 45, end: 60, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 60 },
      { start: 45, end: 60 },
    ]);
  });

  await check("seek within the same MKV keeps the head index instead of dropping it", () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 60, 40 * 1024);
    const torrent = fakeTorrent([ep5], 1024);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => undefined,
    });
    prioritizeBuiltinStreamFile(torrent, ep5, {
      seekOffset: 8 * 1024,
      prefetchEdges: async () => undefined,
    });

    // The SeekHead lives in the head window; dropping it on every arrow-key seek
    // is what let the demuxer estimate cluster offsets and desync audio. The head
    // is unchanged across the seek, so it stays selected and is never deselected.
    assert.deepEqual(torrent.deselections, []);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 60, priority: 3, stream: true },
      { start: 48, end: 60, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 60 },
      { start: 48, end: 60 },
    ]);
  });

  await check("MKV seek holds head and Cues tail critical around the seek target", () => {
    const ep3 = fakeFile("Show/S01E03.mkv", 40, 79, 40 * 1024 * 1024);
    const torrent = fakeTorrent([ep3], 1024 * 1024);

    prioritizeBuiltinStreamFile(torrent, ep3, {
      seekOffset: 20 * 1024 * 1024,
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 78, end: 79, priority: 3, stream: true },
      { start: 60, end: 61, priority: 3, stream: true },
    ]);
    // Head (SeekHead), tail (Cues) and the seek target are all critical so the
    // index is on disk before the target cluster is decoded.
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 41 },
      { start: 78, end: 79 },
      { start: 60, end: 61 },
    ]);
  });

  await check("MKV seek promotes a previously deferred tail to critical", () => {
    const ep3 = fakeFile("Show/S01E03.mkv", 40, 79, 40 * 1024 * 1024);
    const torrent = fakeTorrent([ep3], 1024 * 1024);

    prioritizeBuiltinStreamFile(torrent, ep3, {
      prefetchEdges: async () => undefined,
    });
    prioritizeBuiltinStreamFile(torrent, ep3, {
      seekOffset: 20 * 1024 * 1024,
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(torrent.deselections, [{ start: 78, end: 79, stream: true }]);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 78, end: 79, priority: 1, stream: true },
      { start: 78, end: 79, priority: 3, stream: true },
      { start: 60, end: 61, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 41 },
      { start: 78, end: 79 },
      { start: 60, end: 61 },
    ]);
  });

  await check("non-Matroska seek drops the head and leaves the tail non-critical", () => {
    const movie = fakeFile("Movie/Movie.mp4", 40, 79, 40 * 1024 * 1024);
    const torrent = fakeTorrent([movie], 1024 * 1024);

    prioritizeBuiltinStreamFile(torrent, movie, {
      seekOffset: 20 * 1024 * 1024,
      prefetchEdges: async () => undefined,
    });

    // MP4 keeps its index parsed up front, so a seek should not pin the head or
    // escalate the tail: only the requested pieces are urgent. The non-critical
    // tail defers below the seek window (priority 1) until the window lands.
    assert.deepEqual(torrent.selections, [
      { start: 78, end: 79, priority: 1, stream: true },
      { start: 60, end: 61, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [{ start: 60, end: 61 }]);
  });

  await check("seekIndexPlan pins the index only for a Matroska seek", () => {
    assert.deepEqual(seekIndexPlan({ isMatroska: true, seeking: true }), {
      holdHeadIndex: true,
      tailCritical: true,
    });
    assert.deepEqual(seekIndexPlan({ isMatroska: true, seeking: false }), {
      holdHeadIndex: false,
      tailCritical: false,
    });
    assert.deepEqual(seekIndexPlan({ isMatroska: false, seeking: true }), {
      holdHeadIndex: false,
      tailCritical: false,
    });
    assert.deepEqual(seekIndexPlan({ isMatroska: false, seeking: false }), {
      holdHeadIndex: false,
      tailCritical: false,
    });
  });

  await check("isMatroskaContainer recognises MKV and WebM only", () => {
    assert.equal(isMatroskaContainer("Show/S01E05.mkv"), true);
    assert.equal(isMatroskaContainer("Clips\\clip.WEBM"), true);
    assert.equal(isMatroskaContainer("Movie/Movie.mp4"), false);
    assert.equal(isMatroskaContainer("noext"), false);
  });

  await check("head priority is bounded instead of selecting the whole episode", () => {
    const ep1 = fakeFile("Show/S01E01.mkv", 0, 19, 0);
    const ep3 = fakeFile("Show/S01E03.mkv", 40, 59, 40 * 1024);
    const torrent = fakeTorrent([ep1, ep3]);

    prioritizeBuiltinStreamFile(torrent, ep3, {
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(
      torrent.selections,
      [
        { start: 40, end: 41, priority: 3, stream: true },
        { start: 58, end: 59, priority: 1, stream: true },
      ],
      "opening S01E03 must request only bounded head and tail windows",
    );
  });

  await check("selected pack file also prioritises its own tail for MKV cues", () => {
    const ep1 = fakeFile("Show/S01E01.mkv", 0, 19, 0);
    const ep3 = fakeFile("Show/S01E03.mkv", 40, 79, 40 * 1024);
    const ep4 = fakeFile("Show/S01E04.mkv", 80, 119, 80 * 1024);
    const torrent = fakeTorrent([ep1, ep3, ep4], 1024 * 1024);

    prioritizeBuiltinStreamFile(torrent, ep3, {
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(
      torrent.selections,
      [
        { start: 40, end: 41, priority: 3, stream: true },
        { start: 78, end: 79, priority: 1, stream: true },
      ],
      "S01E03 must prioritise S01E03's tail pieces, not the torrent tail or a sibling",
    );
  });

  await check("resolveStreamTailPriority holds the tail below the head until the window lands", () => {
    // Incomplete primary window: the tail must sit below the head priority so it
    // cannot race the first frame for peer bandwidth.
    assert.equal(resolveStreamTailPriority(false), 1);
    // Once the head/seek window is verified, the tail is promoted to the head
    // priority so the moov/cues finish without a second stall.
    assert.equal(resolveStreamTailPriority(true), 3);
    assert.ok(
      resolveStreamTailPriority(false) < resolveStreamTailPriority(true),
      "the deferred tail priority must be strictly below the head priority",
    );
  });

  await check("the tail is deferred at open, then promoted once the head window is verified", () => {
    const ep3 = fakeFile("Show/S01E03.mkv", 40, 79, 40 * 1024);
    const torrent = fakeTorrent([ep3], 1024 * 1024);

    // At open nothing is verified: head {40,41} owns the swarm and the tail
    // {78,79} waits at the deferred priority.
    prioritizeBuiltinStreamFile(torrent, ep3, {
      prefetchEdges: async () => undefined,
    });
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 78, end: 79, priority: 1, stream: true },
    ]);

    // The head pieces land. The next priority pass promotes the tail to the head
    // priority, dropping the stale deferred selection first. The head is not
    // re-selected because its range is unchanged (headChanged guard), matching
    // the deselection assertion above.
    torrent.bitfield = { get: (index: number) => index === 40 || index === 41 };
    prioritizeBuiltinStreamFile(torrent, ep3, {
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(torrent.deselections, [{ start: 78, end: 79, stream: true }]);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 41, priority: 3, stream: true },
      { start: 78, end: 79, priority: 1, stream: true },
      { start: 78, end: 79, priority: 3, stream: true },
    ]);
  });

  await check("edge prefetch defers tail drain until head drain finishes", async () => {
    const started: Array<{ start: number; end: number }> = [];
    const releases: Array<() => void> = [];
    const file = {
      name: "Show/S01E03.mkv",
      path: "Show/S01E03.mkv",
      length: 30,
      stream(range: { start: number; end: number }) {
        started.push(range);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            releases.push(() => controller.close());
          },
        });
      },
    } as BuiltinStreamFile;
    const torrent = { emit() {} } as unknown as BuiltinStreamTorrent;

    const prefetch = prefetchBuiltinFileEdges(torrent, file, { bytes: 10, timeoutMs: 1_000 });
    await Promise.resolve();
    assert.deepEqual(started, [{ start: 0, end: 9 }]);

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, [
      { start: 0, end: 9 },
      { start: 20, end: 29 },
    ]);

    releases.shift()?.();
    await prefetch;
  });

  await check("failed edge prefetch is retried on a later priority call", async () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 49, 40 * 1024);
    const torrent = fakeTorrent([ep5]);
    let attempts = 0;
    const opts = {
      prefetchEdges: async () => {
        attempts += 1;
        throw new Error("prefetch stalled");
      },
    };

    prioritizeBuiltinStreamFile(torrent, ep5, opts);
    await Promise.resolve();
    await Promise.resolve();
    prioritizeBuiltinStreamFile(torrent, ep5, opts);
    await Promise.resolve();

    assert.equal(attempts, 2);
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} builtin engine priority test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll builtin engine priority tests passed.");
});
