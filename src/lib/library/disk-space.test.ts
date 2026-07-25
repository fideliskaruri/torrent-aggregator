/**
 * Run: npx tsx src/lib/library/disk-space.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertStorageBudget,
  canFitEstimate,
  DEFAULT_MAX_STORAGE_BYTES,
  estimateBackfillBytes,
  formatBytesShort,
  getDirectorySizeBytes,
  getDirectorySizeBytesAsync,
  gbToBytes,
  resetDirectorySizeCache,
} from "./disk-space";

async function main() {
  {
    const e = estimateBackfillBytes({ fromSeason: 9, toSeason: 11 });
    assert.equal(e.seasons, 3);
    assert.equal(e.episodes, 66);
    assert.ok(e.estimatedBytes > 50e9);
  }

  {
    const ok = canFitEstimate(500e9, 100e9, 0, DEFAULT_MAX_STORAGE_BYTES);
    assert.equal(ok.canFit, true);
    const no = canFitEstimate(20e9, 100e9, 0, DEFAULT_MAX_STORAGE_BYTES);
    assert.equal(no.canFit, false);
  }

  {
    assert.match(formatBytesShort(1.5e9), /GB/);
    assert.equal(gbToBytes(100), 100e9);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stor-"));
  try {
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(1024));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(2048));
    const used = getDirectorySizeBytes(dir);
    assert.equal(used, 1024 + 2048);

    const blocked = await assertStorageBudget({
      root: dir,
      maxStorageBytes: 1000,
      incomingBytes: 500,
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /cap|Storage/i);

    const allowed = await assertStorageBudget({
      root: dir,
      maxStorageBytes: 50 * 1024 * 1024 * 1024,
      incomingBytes: 1024,
    });
    assert.equal(allowed.ok, true);
    assert.ok(allowed.usedBytes >= 3072);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The async walk must agree with the sync one on every tree shape, since it
  // is what the server actually uses.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-async-"));
    const cases: { name: string; build: (d: string) => void }[] = [
      { name: "empty", build: () => {} },
      {
        name: "flat files",
        build: (d) => {
          fs.writeFileSync(path.join(d, "a"), Buffer.alloc(10));
          fs.writeFileSync(path.join(d, "b"), Buffer.alloc(20));
        },
      },
      {
        name: "nested dirs",
        build: (d) => {
          fs.mkdirSync(path.join(d, "x", "y"), { recursive: true });
          fs.writeFileSync(path.join(d, "x", "y", "deep"), Buffer.alloc(64));
          fs.writeFileSync(path.join(d, "top"), Buffer.alloc(1));
        },
      },
      {
        name: "empty nested dirs only",
        build: (d) => fs.mkdirSync(path.join(d, "p", "q"), { recursive: true }),
      },
    ];

    try {
      for (const c of cases) {
        const dir = path.join(root, c.name.replace(/\s+/g, "-"));
        fs.mkdirSync(dir, { recursive: true });
        c.build(dir);
        resetDirectorySizeCache();
        const sync = getDirectorySizeBytes(dir);
        const async_ = await getDirectorySizeBytesAsync(dir);
        assert.equal(async_, sync, `async walk disagreed on: ${c.name}`);
      }

      // Missing paths are 0, not a throw.
      resetDirectorySizeCache();
      assert.equal(
        await getDirectorySizeBytesAsync(path.join(root, "nope")),
        0,
      );

      // A single file measures as itself.
      const lone = path.join(root, "lone.bin");
      fs.writeFileSync(lone, Buffer.alloc(77));
      resetDirectorySizeCache();
      assert.equal(await getDirectorySizeBytesAsync(lone), 77);

      // Memoised within the TTL, fresh once reset — this is what stops an
      // automation run re-walking the library once per torrent.
      const cached = path.join(root, "cached");
      fs.mkdirSync(cached, { recursive: true });
      fs.writeFileSync(path.join(cached, "f1"), Buffer.alloc(100));
      resetDirectorySizeCache();
      assert.equal(await getDirectorySizeBytesAsync(cached), 100);
      fs.writeFileSync(path.join(cached, "f2"), Buffer.alloc(100));
      assert.equal(
        await getDirectorySizeBytesAsync(cached),
        100,
        "expected the memoised size within the TTL",
      );
      assert.equal(
        await getDirectorySizeBytesAsync(cached, { ttlMs: 0 }),
        200,
        "expected a fresh walk when the TTL is zero",
      );
      resetDirectorySizeCache();
      assert.equal(await getDirectorySizeBytesAsync(cached), 200);

      // Concurrent callers collapse onto one walk and all see the same answer.
      resetDirectorySizeCache();
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => getDirectorySizeBytesAsync(cached)),
      );
      assert.deepEqual(answers, [200, 200, 200, 200, 200]);
    } finally {
      resetDirectorySizeCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("disk-space.test.ts: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
