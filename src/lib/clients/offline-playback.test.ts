/**
 * RULE: a fully-downloaded episode plays with no network available.
 *
 * WHAT WAS ACTUALLY WRONG
 * -----------------------
 * The disk fast path in `clients/disk-fastpath.ts` had NOT regressed. It works,
 * it hashes pieces straight off the file, and it never touches the swarm. It was
 * simply unreachable from a cold start:
 *
 *   GET /api/stream/<hash>/<file>
 *     → findBuiltinTorrentFile → ensureClientAndRehydrate → rehydrateFromDb
 *     → client.add(**magnet**)
 *
 * A magnet is a *request to the swarm* for the info dictionary. With the owner's
 * network restricted the metadata never arrives, `ready` never fires, the
 * rehydrate timeout destroys the handle, and the route answers 404 — for a file
 * sitting complete on disk. The fast path lives further down the same handler and
 * never got a chance to run. So: not a regression, never covered.
 *
 * Metadata is a fact about the release, not about the swarm. Once cached, the add
 * resolves locally and the fast path becomes reachable offline. These tests pin
 * both halves: the cache round-trip, and that a cached-metadata add + a complete
 * file yields real bytes with every network primitive rigged to throw.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { makeScratchDir } from "@/lib/test-support/scratch-dir";
import path from "node:path";
import {
  MAX_METADATA_BYTES,
  METADATA_CACHE_DIRNAME,
  forgetTorrentMetadata,
  loadTorrentMetadata,
  metadataCacheDir,
  normalizeMetadataHash,
  preferredAddInput,
  saveTorrentMetadata,
  torrentMetadataPath,
  type MetadataFs,
} from "./torrent-metadata-cache";
import { openVerifiedDiskStream } from "./disk-fastpath";
import type { BuiltinStreamFile, BuiltinStreamTorrent } from "./builtin-engine";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

const HASH = "abcdef1234567890abcdef1234567890abcdef12";

function memFs(): MetadataFs & {
  files: Map<string, Uint8Array>;
  /** Directories cleanup asked to remove, so the test can assert the pruning. */
  removedDirs: string[];
} {
  const files = new Map<string, Uint8Array>();
  const removedDirs: string[] = [];
  return {
    files,
    removedDirs,
    mkdir: () => undefined,
    writeFile: (file, bytes) => {
      files.set(path.resolve(file), bytes);
    },
    readFile: (file) => files.get(path.resolve(file)) ?? null,
    removeFile: (file) => {
      files.delete(path.resolve(file));
    },
    removeEmptyDir: (dir) => {
      const resolved = path.resolve(dir);
      // Mirror the real fs: refuse when anything still lives under it.
      const occupied = [...files.keys()].some((f) =>
        f.startsWith(resolved + path.sep),
      );
      if (occupied) return;
      removedDirs.push(resolved);
    },
  };
}

async function main() {
  // ── 1. Hash handling: a cache key must never become a path ────────────────
  await check("only a real 40-hex info hash becomes a cache file name", () => {
    const cases: Array<[string | null | undefined, string | null]> = [
      [HASH, HASH],
      [HASH.toUpperCase(), HASH],
      [`  ${HASH}  `, HASH],
      ["abc", null],
      ["", null],
      [null, null],
      [undefined, null],
      ["../../../../etc/passwd", null],
      [`${HASH}/../../evil`, null],
      ["g".repeat(40), null],
      [`${HASH}0`, null],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeMetadataHash(input), expected, `hash ${String(input)}`);
    }
    assert.equal(
      torrentMetadataPath("D:\\leech", "../evil"),
      null,
      "a traversal never resolves to a cache path",
    );
    assert.equal(torrentMetadataPath("", HASH), null, "no root, no path");
    assert.equal(metadataCacheDir("  "), null);
    assert.equal(
      torrentMetadataPath("D:\\leech", HASH),
      path.join(path.resolve("D:\\leech"), METADATA_CACHE_DIRNAME, `${HASH}.torrent`),
    );
  });

  // ── 2. Round-trip, and what must be refused ──────────────────────────────
  await check("metadata round-trips through the cache", () => {
    const io = memFs();
    const bytes = new Uint8Array([100, 56, 58, 97, 110, 110, 111, 117, 110, 99, 101]);
    assert.equal(saveTorrentMetadata("D:\\leech", HASH, bytes, io), true);
    assert.deepEqual(loadTorrentMetadata("D:\\leech", HASH, io), bytes);
    forgetTorrentMetadata("D:\\leech", HASH, io);
    assert.equal(loadTorrentMetadata("D:\\leech", HASH, io), null);
  });

  // ── The leak: cleanup that existed but was never called ──────────────────
  //
  // `forgetTorrentMetadata` was written, unit-tested, and wired into exactly
  // nothing. Measured live: deleting an album with "delete files" reported
  // "Removed torrent and files" and left a 17 KB `.torrent` on disk. Every user
  // delete leaked one, and so did every stream-cache eviction — which the
  // retention sweep performs continuously.
  //
  // Worst of all it was invisible: `disk-inventory` files dot-prefixed entries
  // as app-internal, so these never reached the orphan list the owner can see.
  await check("forgetting metadata also clears the folders it created", () => {
    const io = memFs();
    saveTorrentMetadata("D:\\leech\\Music", HASH, new Uint8Array([1, 2, 3]), io);
    forgetTorrentMetadata("D:\\leech\\Music", HASH, io);

    assert.equal(io.files.size, 0, "the .torrent itself must be gone");
    const root = path.resolve("D:\\leech\\Music");
    assert.ok(
      io.removedDirs.some((d) => d === path.join(root, METADATA_CACHE_DIRNAME)),
      `metadata dir not cleaned: ${JSON.stringify(io.removedDirs)}`,
    );
    assert.ok(
      io.removedDirs.some((d) => d === path.join(root, ".torrentflow")),
      `.torrentflow not cleaned: ${JSON.stringify(io.removedDirs)}`,
    );
  });

  await check("cleanup never removes a folder another release still uses", () => {
    // The dangerous direction. Two releases share one category folder; deleting
    // one must not take the other's metadata with it.
    const io = memFs();
    const other = "b".repeat(40);
    saveTorrentMetadata("D:\\leech\\Music", HASH, new Uint8Array([1]), io);
    saveTorrentMetadata("D:\\leech\\Music", other, new Uint8Array([2]), io);

    forgetTorrentMetadata("D:\\leech\\Music", HASH, io);

    assert.equal(loadTorrentMetadata("D:\\leech\\Music", HASH, io), null);
    assert.deepEqual(
      loadTorrentMetadata("D:\\leech\\Music", other, io),
      new Uint8Array([2]),
      "the sibling's metadata must survive",
    );
    assert.deepEqual(io.removedDirs, [], "a shared folder must not be removed");
  });

  await check("forgetting is safe when there was nothing cached", () => {
    // Delete paths call this unconditionally; a torrent added before the cache
    // existed, or one whose cache was already pruned, must not throw.
    const io = memFs();
    forgetTorrentMetadata("D:\\leech\\Music", HASH, io);
    forgetTorrentMetadata("", HASH, io);
    forgetTorrentMetadata("D:\\leech", "not-a-hash", io);
    assert.equal(io.files.size, 0);
  });

  await check("a delete that KEEPS files must keep the metadata", () => {
    // The rule stated as its inverse, because getting this backwards is the
    // expensive mistake: metadata follows the FILES. A torrent removed from the
    // engine while its media stays on disk is still playable offline, and
    // throwing its metadata away would put that release back on the network.
    const engine = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "clients", "builtin-engine.ts"),
      "utf8",
    );
    const calls = [...engine.matchAll(/forgetTorrentMetadata\s*\(/g)];
    assert.ok(calls.length > 0, "the delete path must call forgetTorrentMetadata");
    for (const call of calls) {
      // Look back for the nearest guard; every call site must sit under one.
      const before = engine.slice(Math.max(0, call.index - 400), call.index);
      assert.ok(
        /deleteFiles\s*&&/.test(before),
        `a forgetTorrentMetadata call is not guarded by deleteFiles:\n...${before.slice(-160)}`,
      );
    }
  });

  await check("junk is never cached", () => {
    const io = memFs();
    const cases: Array<{ name: string; bytes: Uint8Array | null | undefined }> = [
      { name: "null", bytes: null },
      { name: "undefined", bytes: undefined },
      { name: "empty", bytes: new Uint8Array(0) },
      { name: "absurdly large", bytes: new Uint8Array(MAX_METADATA_BYTES + 1) },
    ];
    for (const c of cases) {
      assert.equal(saveTorrentMetadata("D:\\leech", HASH, c.bytes, io), false, c.name);
    }
    assert.equal(io.files.size, 0);
    assert.equal(
      saveTorrentMetadata("D:\\leech", "not-a-hash", new Uint8Array([1]), io),
      false,
    );
  });

  await check("a write failure is survivable — it costs a future offline start only", () => {
    const io: MetadataFs = {
      ...memFs(),
      writeFile: () => {
        throw new Error("EACCES");
      },
    };
    assert.equal(saveTorrentMetadata("D:\\leech", HASH, new Uint8Array([1]), io), false);
  });

  // ── 3. THE RULE: cached metadata beats the magnet ────────────────────────
  await check("preferredAddInput prefers cached metadata over the magnet", () => {
    const io = memFs();
    const magnet = `magnet:?xt=urn:btih:${HASH}`;

    const cold = preferredAddInput("D:\\leech", HASH, magnet, io);
    assert.equal(cold.source, "uri", "first ever add has no cache and must use the magnet");
    assert.equal(cold.input, magnet);

    const meta = new Uint8Array([1, 2, 3, 4]);
    saveTorrentMetadata("D:\\leech", HASH, meta, io);

    const warm = preferredAddInput("D:\\leech", HASH, magnet, io);
    assert.equal(
      warm.source,
      "metadata",
      "THE RULE: once we know the info dictionary we never ask the swarm for it again",
    );
    assert.deepEqual(warm.input, meta);

    forgetTorrentMetadata("D:\\leech", HASH, io);
    assert.equal(
      preferredAddInput("D:\\leech", HASH, magnet, io).source,
      "uri",
      "a pruned cache degrades to the old behaviour rather than failing",
    );
  });

  await check("a truncated or unreadable cache entry falls back to the magnet", () => {
    const base = makeScratchDir("tf-meta");
    try {
      const file = torrentMetadataPath(base, HASH);
      assert.ok(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(0));
      assert.equal(
        preferredAddInput(base, HASH, "magnet:?xt=urn:btih:x").source,
        "uri",
        "a zero-byte .torrent must not be handed to client.add",
      );
      fs.writeFileSync(file, Buffer.alloc(MAX_METADATA_BYTES + 1));
      assert.equal(
        preferredAddInput(base, HASH, "magnet:?xt=urn:btih:x").source,
        "uri",
        "an oversized file is not a .torrent",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  await check("the real writer is atomic — no .tmp is left behind", () => {
    const base = makeScratchDir("tf-meta-atomic");
    try {
      saveTorrentMetadata(base, HASH, new Uint8Array([9, 9, 9]));
      const dir = metadataCacheDir(base);
      assert.ok(dir);
      const entries = fs.readdirSync(dir);
      assert.deepEqual(entries, [`${HASH}.torrent`]);
      assert.deepEqual([...loadTorrentMetadata(base, HASH)!], [9, 9, 9]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // ── 4. ACCEPTANCE: a complete file plays with the network unplugged ──────
  await check(
    "ACCEPTANCE: a fully-downloaded episode streams from disk with no network",
    async () => {
      const base = makeScratchDir("tf-offline");
      try {
        const pieceLength = 1024;
        const pieceCount = 4;
        const total = pieceLength * pieceCount;
        const content = Buffer.alloc(total);
        for (let i = 0; i < total; i += 1) content[i] = i % 251;

        const rel = "Silo/S01E01.mkv";
        const filePath = path.join(base, "Silo", "S01E01.mkv");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);

        const hashes: string[] = [];
        for (let p = 0; p < pieceCount; p += 1) {
          hashes.push(
            createHash("sha1")
              .update(content.subarray(p * pieceLength, (p + 1) * pieceLength))
              .digest("hex"),
          );
        }

        // Every network primitive a WebTorrent stream would reach for throws.
        // If the response contains bytes, they came off the disk.
        const netDead = () => {
          throw new Error(
            "offline acceptance: the disk fast path must not touch the swarm",
          );
        };

        const file: BuiltinStreamFile & { offset: number } = {
          name: "S01E01.mkv",
          path: rel,
          length: total,
          offset: 0,
          stream: netDead,
        };
        const torrent = {
          infoHash: HASH,
          name: "Silo S01E01",
          progress: 1,
          downloadSpeed: 0,
          numPeers: 0,
          ready: true,
          done: true,
          path: base,
          length: total,
          pieceLength,
          lastPieceLength: pieceLength,
          pieces: Array.from({ length: pieceCount }, () => ({})),
          _hashes: hashes,
          // Deliberately NOT trusting the in-memory bitfield: force the fast path
          // to prove completeness by hashing the file itself. That is the state a
          // freshly rehydrated torrent is in, and it is the harder case.
          bitfield: { get: () => false },
          files: [file],
          select: netDead,
          critical: netDead,
        } as unknown as BuiltinStreamTorrent;

        const disk = await openVerifiedDiskStream(torrent, file, {
          start: 0,
          end: total - 1,
        });
        assert.ok(disk, "THE ACCEPTANCE TEST: a complete file must open from disk");
        assert.equal(disk.path, filePath);

        const reader = disk.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value) chunks.push(next.value);
        }
        const got = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        assert.equal(got.length, total, "the whole episode was served");
        assert.ok(got.equals(content), "the bytes are the file's own bytes");

        // And a seek into the middle works, which is the other half of the app's
        // "Plays instantly and seeks anywhere" claim.
        const seek = await openVerifiedDiskStream(torrent, file, {
          start: 2048,
          end: 3071,
        });
        assert.ok(seek, "a mid-file seek also resolves from disk");
        const seekReader = seek.body.getReader();
        const seekChunks: Uint8Array[] = [];
        for (;;) {
          const next = await seekReader.read();
          if (next.done) break;
          if (next.value) seekChunks.push(next.value);
        }
        assert.ok(
          Buffer.concat(seekChunks.map((c) => Buffer.from(c))).equals(
            content.subarray(2048, 3072),
          ),
          "the seeked range is correct",
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  await check(
    "a file that is NOT complete on disk does not get the offline fast path",
    async () => {
      const base = makeScratchDir("tf-offline-partial");
      try {
        const pieceLength = 1024;
        const content = Buffer.alloc(pieceLength * 2);
        const rel = "Half/Ep.mkv";
        const filePath = path.join(base, "Half", "Ep.mkv");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // Full-length preallocation of zeroes: same size, no real content.
        fs.writeFileSync(filePath, content);

        const realHashes = [
          createHash("sha1").update(Buffer.alloc(pieceLength, 1)).digest("hex"),
          createHash("sha1").update(Buffer.alloc(pieceLength, 2)).digest("hex"),
        ];
        const file: BuiltinStreamFile & { offset: number } = {
          name: "Ep.mkv",
          path: rel,
          length: content.length,
          offset: 0,
          stream: () => {
            throw new Error("not used");
          },
        };
        const torrent = {
          infoHash: HASH,
          name: "Half",
          progress: 0,
          downloadSpeed: 0,
          numPeers: 0,
          ready: true,
          path: base,
          length: content.length,
          pieceLength,
          lastPieceLength: pieceLength,
          pieces: [{}, {}],
          _hashes: realHashes,
          // An incomplete torrent's bitfield reports nothing verified, so the
          // fast path must fall through to hashing — and the hashes will not
          // match a zero-filled placeholder.
          bitfield: { get: () => false },
          files: [file],
        } as unknown as BuiltinStreamTorrent;

        const disk = await openVerifiedDiskStream(torrent, file, {
          start: 0,
          end: content.length - 1,
        });
        assert.equal(
          disk,
          null,
          "a preallocated placeholder must never be served as if it were the episode",
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  console.log(
    failures === 0
      ? "\nPASS offline-playback: cached metadata makes the disk fast path reachable with no network"
      : `\n${failures} offline-playback test(s) failed`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
