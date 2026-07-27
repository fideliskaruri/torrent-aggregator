import assert from "node:assert/strict";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import {
  isTorrentRangeVerifiedOnDisk,
  torrentPieceRangeForFileRange,
  type ByteRange,
} from "./disk-fastpath";

type FakeTorrent = BuiltinStreamTorrent & {
  pieceLength: number;
  pieces: unknown[];
  ready: boolean;
  bitfield: { get: (index: number) => boolean };
};

type FakeFile = BuiltinStreamFile & { offset: number };

function torrent(opts: {
  pieceLength?: number;
  pieceCount?: number;
  verified?: number[];
  ready?: boolean;
} = {}): FakeTorrent {
  const verified = new Set(opts.verified ?? []);
  return {
    infoHash: "abcdef1234567890abcdef1234567890abcdef12",
    name: "Fake torrent",
    progress: 0,
    downloadSpeed: 0,
    numPeers: 0,
    files: [],
    pieceLength: opts.pieceLength ?? 1024,
    pieces: Array.from({ length: opts.pieceCount ?? 4 }, () => ({})),
    ready: opts.ready ?? true,
    bitfield: { get: (index) => verified.has(index) },
  };
}

function file(length: number, offset: number): FakeFile {
  return {
    name: "Movie.mkv",
    path: "Folder/Movie.mkv",
    length,
    offset,
    stream() {
      throw new Error("not used");
    },
  };
}

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

let failures = 0;

async function main() {
  await check("file ranges map to inclusive torrent piece ranges", () => {
    const cases: Array<{
      name: string;
      fileOffset: number;
      fileLength: number;
      range: ByteRange;
      expected: { start: number; end: number };
    }> = [
      {
        name: "range entirely inside one piece",
        fileOffset: 0,
        fileLength: 4096,
        range: { start: 100, end: 200 },
        expected: { start: 0, end: 0 },
      },
      {
        name: "range spanning a piece boundary",
        fileOffset: 0,
        fileLength: 4096,
        range: { start: 1000, end: 1024 },
        expected: { start: 0, end: 1 },
      },
      {
        name: "range at byte zero",
        fileOffset: 0,
        fileLength: 4096,
        range: { start: 0, end: 0 },
        expected: { start: 0, end: 0 },
      },
      {
        name: "range at the final byte",
        fileOffset: 0,
        fileLength: 2000,
        range: { start: 1999, end: 1999 },
        expected: { start: 1, end: 1 },
      },
      {
        name: "unaligned file start before a piece boundary",
        fileOffset: 100,
        fileLength: 2000,
        range: { start: 923, end: 923 },
        expected: { start: 0, end: 0 },
      },
      {
        name: "unaligned file start crossing a piece boundary",
        fileOffset: 100,
        fileLength: 2000,
        range: { start: 924, end: 950 },
        expected: { start: 1, end: 1 },
      },
      {
        name: "unaligned file start straddling two pieces",
        fileOffset: 100,
        fileLength: 2000,
        range: { start: 900, end: 950 },
        expected: { start: 0, end: 1 },
      },
    ];

    for (const c of cases) {
      assert.deepEqual(
        torrentPieceRangeForFileRange(
          torrent({ pieceLength: 1024, pieceCount: 8 }),
          file(c.fileLength, c.fileOffset),
          c.range,
        ),
        c.expected,
        c.name,
      );
    }
  });

  await check("verification requires every covered piece in the bitfield", () => {
    const f = file(4096, 0);
    assert.equal(
      isTorrentRangeVerifiedOnDisk(
        torrent({ verified: [0, 1] }),
        f,
        { start: 900, end: 1100 },
      ),
      true,
    );
    assert.equal(
      isTorrentRangeVerifiedOnDisk(
        torrent({ verified: [0] }),
        f,
        { start: 900, end: 1100 },
      ),
      false,
    );
  });

  await check("uncertain torrent state is never treated as disk-ready", () => {
    const f = file(4096, 0);
    const noBitfield = torrent({ verified: [0] }) as BuiltinStreamTorrent & {
      bitfield?: unknown;
    };
    delete noBitfield.bitfield;
    assert.equal(
      isTorrentRangeVerifiedOnDisk(noBitfield, f, { start: 0, end: 1 }),
      false,
    );
    assert.equal(
      isTorrentRangeVerifiedOnDisk(
        torrent({ verified: [0], ready: false }),
        f,
        { start: 0, end: 1 },
      ),
      false,
    );
    assert.equal(
      isTorrentRangeVerifiedOnDisk(
        torrent({ pieceCount: 1, verified: [0, 1] }),
        f,
        { start: 1024, end: 1025 },
      ),
      false,
    );
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} disk fast path test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll disk fast path tests passed.");
});
