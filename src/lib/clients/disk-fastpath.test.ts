import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BuiltinStreamFile,
  BuiltinStreamTorrent,
} from "@/lib/clients/builtin-engine";
import { makeScratchDir } from "@/lib/test-support/scratch-dir";
import {
  diskFileLengthByPath,
  isTorrentFileFullyVerifiedOnDisk,
  isTorrentRangeVerifiedOnDisk,
  openDiskFileByPath,
  readDiskFileByPath,
  resolveCompletedPersistedDiskFile,
  resolvePersistedDiskFile,
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
  /** Aggregate torrent-level progress, independent of `verified` pieces — a
   *  season pack can report 0.5 overall while one file's own pieces (set via
   *  `verified`) are all in. */
  progress?: number;
} = {}): FakeTorrent {
  const verified = new Set(opts.verified ?? []);
  return {
    infoHash: "abcdef1234567890abcdef1234567890abcdef12",
    name: "Fake torrent",
    progress: opts.progress ?? 0,
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

  await check(
    "a fully verified file is complete even while the season pack's aggregate progress is under 1",
    () => {
      // A two-episode pack: pieces 0-3 back episode one, pieces 4-7 back
      // episode two. Episode one finished (and hash-verified) first — the
      // torrent as a whole is still only half done.
      const packTorrent = torrent({
        pieceLength: 1024,
        pieceCount: 8,
        verified: [0, 1, 2, 3],
        progress: 0.5,
      });
      const episodeOne = file(4096, 0); // pieces 0-3, all verified
      const episodeTwo = file(4096, 4096); // pieces 4-7, still missing

      assert.equal(packTorrent.progress < 1, true, "the pack itself is not done");
      assert.equal(
        isTorrentFileFullyVerifiedOnDisk(packTorrent, episodeOne),
        true,
        "episode one's own pieces are all verified, independent of the pack's aggregate progress",
      );
      assert.equal(
        isTorrentFileFullyVerifiedOnDisk(packTorrent, episodeTwo),
        false,
        "episode two is still missing pieces even though episode one is done",
      );
    },
  );

  await check("a zero-length file is trivially fully verified", () => {
    assert.equal(
      isTorrentFileFullyVerifiedOnDisk(torrent({ verified: [] }), file(0, 0)),
      true,
    );
  });

  await check("a partially verified file is not fully verified", () => {
    const f = file(4096, 0); // pieces 0-3
    assert.equal(
      isTorrentFileFullyVerifiedOnDisk(torrent({ verified: [0, 1, 2] }), f),
      false,
      "piece 3 is still missing",
    );
    assert.equal(
      isTorrentFileFullyVerifiedOnDisk(torrent({ verified: [0, 1, 2, 3] }), f),
      true,
    );
  });

  await check("persisted verified files resolve by torrent-relative path", () => {
    const savePath = "D:\\Media\\TV";
    const resolved = resolvePersistedDiskFile(
      savePath,
      JSON.stringify([
        {
          path: "D:\\Media\\TV\\Show\\Season 01\\Show S01E01.mkv",
          size: 1234,
          mtimeMs: 1,
        },
      ]),
      "Show/Season 01/Show S01E01.mkv",
    );
    assert.deepEqual(resolved, {
      path: "D:\\Media\\TV\\Show\\Season 01\\Show S01E01.mkv",
      rootPath: path.resolve(savePath),
      length: 1234,
      mtimeMs: 1,
    });
  });

  await check("persisted path resolution requires an exact save-root-relative path", () => {
    const resolved = resolvePersistedDiskFile(
      null,
      JSON.stringify([
        { path: "D:\\Media\\A\\Movie.mkv", size: 100, mtimeMs: 1 },
        { path: "D:\\Media\\B\\Movie.mkv", size: 200, mtimeMs: 2 },
      ]),
      "Movie.mkv",
    );
    assert.equal(resolved, null);
    assert.equal(
      resolvePersistedDiskFile(
        "D:\\Media\\TV",
        JSON.stringify([
          {
            path: "D:\\Media\\TV\\Show\\Season 01\\Show S01E01.mkv",
            size: 1234,
            mtimeMs: 1,
          },
        ]),
        "Other/Season 01/Show S01E01.mkv",
      ),
      null,
    );
    assert.equal(
      resolvePersistedDiskFile(
        "D:\\Media\\TV",
        JSON.stringify([
          { path: "D:\\Media\\secret.mkv", size: 1234, mtimeMs: 1 },
        ]),
        "../secret.mkv",
      ),
      null,
    );
  });

  await check("only completed rows can resolve persisted disk files", () => {
    const files = JSON.stringify([
      {
        path: "D:\\Media\\TV\\Movie.mkv",
        size: 1234,
        mtimeMs: 1,
      },
    ]);
    assert.equal(
      resolveCompletedPersistedDiskFile(
        0.99,
        "D:\\Media\\TV",
        files,
        "Movie.mkv",
      ),
      null,
    );
    assert.ok(
      resolveCompletedPersistedDiskFile(
        1,
        "D:\\Media\\TV",
        files,
        "movie.MKV",
      ),
      "Windows path matching should be case-insensitive",
    );
  });

  await check("top-level torrent folders resolve with Windows separators", () => {
    const root = "D:\\Media\\TV";
    const resolved = resolvePersistedDiskFile(
      root,
      JSON.stringify([
        {
          path: "D:\\Media\\TV\\Release Folder\\Season 09\\Episode.mkv",
          size: 4321,
          mtimeMs: 2,
        },
      ]),
      "Release Folder/Season 09/Episode.mkv",
    );
    assert.equal(
      resolved?.path,
      "D:\\Media\\TV\\Release Folder\\Season 09\\Episode.mkv",
    );
  });

  await check("a disk file opens by absolute path without a torrent handle", async () => {
    const root = makeScratchDir("disk-file-by-path");
    const filePath = path.join(root, "Movie.mkv");
    try {
      await fs.writeFile(filePath, Uint8Array.from([10, 20, 30, 40, 50]));
      const fileStat = await fs.stat(filePath);
      assert.equal(
        await diskFileLengthByPath(filePath, 5, fileStat.mtimeMs, root),
        5,
      );
      const opened = await openDiskFileByPath(
        filePath,
        5,
        { start: 1, end: 3 },
        { expectedMtimeMs: fileStat.mtimeMs, rootPath: root },
      );
      assert.ok(opened);
      assert.equal(opened.path, filePath);
      assert.deepEqual(
        Array.from(new Uint8Array(await new Response(opened.body).arrayBuffer())),
        [20, 30, 40],
      );
      const whole = await readDiskFileByPath(
        filePath,
        5,
        fileStat.mtimeMs,
        10,
        root,
      );
      assert.ok(whole);
      assert.deepEqual(Array.from(whole), [10, 20, 30, 40, 50]);
      assert.equal(
        await readDiskFileByPath(filePath, 5, fileStat.mtimeMs + 1, 10),
        null,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  await check("a symlinked path cannot escape the persisted save root", async () => {
    const base = makeScratchDir("disk-file-symlink");
    const root = path.join(base, "library");
    const outside = path.join(base, "outside");
    const link = path.join(root, "linked");
    const escapedFile = path.join(link, "Movie.mkv");
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(
        path.join(outside, "Movie.mkv"),
        Uint8Array.from([1, 2, 3]),
      );
      await fs.symlink(outside, link, "junction");
      const s = await fs.stat(escapedFile);
      assert.equal(
        await diskFileLengthByPath(escapedFile, s.size, s.mtimeMs, root),
        null,
      );
      assert.equal(
        await openDiskFileByPath(
          escapedFile,
          s.size,
          { start: 0, end: 0 },
          { expectedMtimeMs: s.mtimeMs, rootPath: root },
        ),
        null,
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  await check("cancelling a path-based stream closes its handle once", async () => {
    const root = makeScratchDir("disk-file-cancel");
    const filePath = path.join(root, "Movie.mkv");
    const closes: string[] = [];
    try {
      await fs.writeFile(filePath, new Uint8Array(256 * 1024));
      const s = await fs.stat(filePath);
      const opened = await openDiskFileByPath(
        filePath,
        s.size,
        { start: 0, end: s.size - 1 },
        {
          expectedMtimeMs: s.mtimeMs,
          rootPath: root,
          onClose(reason) {
            closes.push(reason);
          },
        },
      );
      assert.ok(opened);
      const reader = opened.body.getReader();
      await reader.read();
      await reader.cancel("seek");
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(closes.length, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  await check("a size mismatch never serves persisted disk bytes", async () => {
    const root = makeScratchDir("disk-file-size-mismatch");
    const filePath = path.join(root, "Movie.mkv");
    try {
      await fs.writeFile(filePath, Uint8Array.from([1, 2, 3]));
      assert.equal(await diskFileLengthByPath(filePath, 4), null);
      assert.equal(
        await openDiskFileByPath(filePath, 4, { start: 0, end: 2 }),
        null,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} disk fast path test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll disk fast path tests passed.");
});
