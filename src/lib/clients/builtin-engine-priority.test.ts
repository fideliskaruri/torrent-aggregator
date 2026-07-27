import assert from "node:assert/strict";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "./builtin-engine";
import {
  prefetchBuiltinFileEdges,
  prioritizeBuiltinStreamFile,
  resetBuiltinStreamPriorityForTests,
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
  await check("played file owns the swarm while siblings are deselected", () => {
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
      { start: 48, end: 49, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [{ start: 40, end: 41 }]);
  });

  await check("repeat calls for the same file are a no-op", () => {
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
      { start: 48, end: 49, priority: 3, stream: true },
      { start: 50, end: 51, priority: 3, stream: true },
      { start: 58, end: 59, priority: 3, stream: true },
    ]);
  });

  await check("seek offset marks the requested pieces urgent", () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 60, 40 * 1024);
    const torrent = fakeTorrent([ep5], 1024);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      seekOffset: 5 * 1024,
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(torrent.selections, [
      { start: 45, end: 60, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [{ start: 45, end: 60 }]);
  });

  await check("seek within the same pack file drops the old head priority", () => {
    const ep5 = fakeFile("Show/S01E05.mkv", 40, 60, 40 * 1024);
    const torrent = fakeTorrent([ep5], 1024);

    prioritizeBuiltinStreamFile(torrent, ep5, {
      prefetchEdges: async () => undefined,
    });
    prioritizeBuiltinStreamFile(torrent, ep5, {
      seekOffset: 8 * 1024,
      prefetchEdges: async () => undefined,
    });

    assert.deepEqual(torrent.deselections, [{ start: 40, end: 60, stream: true }]);
    assert.deepEqual(torrent.selections, [
      { start: 40, end: 60, priority: 3, stream: true },
      { start: 48, end: 60, priority: 3, stream: true },
    ]);
    assert.deepEqual(torrent.criticalCalls, [
      { start: 40, end: 60 },
      { start: 48, end: 60 },
    ]);
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
        { start: 58, end: 59, priority: 3, stream: true },
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
        { start: 78, end: 79, priority: 3, stream: true },
      ],
      "S01E03 must prioritise S01E03's tail pieces, not the torrent tail or a sibling",
    );
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
