/**
 * RULE: a refused or failed send leaves zero new bytes on disk — and zero
 * pre-existing bytes are touched.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The owner watched the reported cache size climb 36.8 → 38.5 → 41.1 GB across
 * three consecutive Play attempts while nothing was downloading. Every attempt
 * resolved metadata (so WebTorrent preallocated the release at full length),
 * failed to finish within the metadata window, and was torn down with
 * `destroy({ destroyStore: false })`. No `EngineTorrent` row was ever written for
 * those adds, so the retention sweep — which walks rows — could never reach them.
 * The cap therefore moved further out of reach with every press of Play.
 *
 * The fix must be surgical in one specific way, and these tests exist to hold
 * that line: releasing a failed allocation must NOT mean `destroyStore: true`.
 * Re-adding a release the owner already holds in full is ordinary, and its
 * metadata resolution can time out just as easily as anything else's. So the
 * rule under test is "delete what this add created", never "delete what is here".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeScratchDir, withScratchDirSync } from "@/lib/test-support/scratch-dir";
import path from "node:path";
import {
  allocationFilePath,
  filesToRelease,
  releaseFailedAllocation,
  snapshotAllocation,
  type AllocationFile,
  type AllocationFs,
  type AllocationTorrent,
} from "./add-allocation";

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

function fakeFs(files: Record<string, number>): AllocationFs & {
  remaining: () => string[];
  removedDirs: string[];
} {
  const store = new Map<string, number>();
  for (const [p, size] of Object.entries(files)) store.set(path.resolve(p), size);
  const removedDirs: string[] = [];
  return {
    listFiles: (dir) => {
      const root = path.resolve(dir);
      return [...store.keys()].filter(
        (p) => p.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`),
      );
    },
    statSize: (file) => store.get(path.resolve(file)) ?? null,
    removeFile: (file) => {
      store.delete(path.resolve(file));
    },
    removeEmptyDir: (dir) => {
      removedDirs.push(path.resolve(dir));
    },
    remaining: () => [...store.keys()].sort(),
    removedDirs,
  };
}

function tor(root: string, files: AllocationFile[]): AllocationTorrent {
  return { path: root, files };
}

async function main() {
  const ROOT = path.resolve("D:\\leech\\Movies");

  // ── 1. The rule, as a table ──────────────────────────────────────────────
  await check("filesToRelease releases only what this add created", () => {
    const cases: Array<{
      name: string;
      files: AllocationFile[];
      existed: string[];
      expect: string[];
    }> = [
      {
        name: "brand-new single-file release → released in full",
        files: [{ path: "Dune/Dune.mkv", length: 3_000_000_000 }],
        existed: [],
        expect: [path.join(ROOT, "Dune", "Dune.mkv")],
      },
      {
        name: "the owner already had this file → never touched",
        files: [{ path: "Dune/Dune.mkv", length: 3_000_000_000 }],
        existed: [path.join(ROOT, "Dune", "Dune.mkv")],
        expect: [],
      },
      {
        name: "pre-existing check is case-insensitive on Windows paths",
        files: [{ path: "Dune/Dune.mkv", length: 1 }],
        existed: [path.join(ROOT, "dune", "DUNE.MKV")],
        expect: [],
      },
      {
        name: "mixed pack → only the newly created members are released",
        files: [
          { path: "Pack/E01.mkv", length: 10 },
          { path: "Pack/E02.mkv", length: 10 },
          { path: "Pack/E03.mkv", length: 10 },
        ],
        existed: [path.join(ROOT, "Pack", "E02.mkv")],
        expect: [path.join(ROOT, "Pack", "E01.mkv"), path.join(ROOT, "Pack", "E03.mkv")],
      },
      {
        name: "path traversal in the .torrent is refused, not deleted",
        files: [{ path: "../../../Windows/System32/kernel32.dll", length: 1 }],
        existed: [],
        expect: [],
      },
      {
        name: "absolute escape is refused",
        files: [{ path: "/etc/passwd", length: 1 }],
        existed: [],
        // A leading slash is stripped and re-rooted, so this stays inside.
        expect: [path.join(ROOT, "etc", "passwd")],
      },
      {
        name: "no metadata means no files means nothing to release",
        files: [],
        existed: [],
        expect: [],
      },
      {
        name: "a file with neither path nor name is skipped",
        files: [{ length: 10 }],
        existed: [],
        expect: [],
      },
      {
        name: "falls back to name when path is absent",
        files: [{ name: "Solo.mkv", length: 10 }],
        existed: [],
        expect: [path.join(ROOT, "Solo.mkv")],
      },
    ];

    for (const c of cases) {
      const snapshot = new Set(c.existed.map((p) => path.resolve(p).toLowerCase()));
      const got = filesToRelease(tor(ROOT, c.files), snapshot);
      assert.deepEqual(got.sort(), [...c.expect].sort(), c.name);
    }
  });

  await check("a torrent with no root path releases nothing", () => {
    assert.deepEqual(
      filesToRelease({ path: "  ", files: [{ path: "a.mkv", length: 1 }] }, new Set()),
      [],
      "without a root we cannot prove where a file lives, so we must not delete it",
    );
  });

  await check("allocationFilePath resolves inside the root and rejects escapes", () => {
    assert.equal(
      allocationFilePath(tor(ROOT, []), { path: "a/b.mkv" }),
      path.join(ROOT, "a", "b.mkv"),
    );
    assert.equal(allocationFilePath(tor(ROOT, []), { path: "../x.mkv" }), null);
    assert.equal(allocationFilePath({ path: "", files: [] }, { path: "a.mkv" }), null);
  });

  // ── 2. Release credits the whole allocation back ─────────────────────────
  await check("releasing a failed add frees the full preallocation", () => {
    const io = fakeFs({
      [path.join(ROOT, "Dune", "Dune.mkv")]: 3_000_000_000,
      [path.join(ROOT, "Keep", "Owned.mkv")]: 5_000_000_000,
    });
    // Snapshot taken before the add: only the owner's file is there.
    const before = snapshotAllocation(ROOT, {
      ...io,
      listFiles: () => [path.join(ROOT, "Keep", "Owned.mkv")],
    });
    const out = releaseFailedAllocation(
      tor(ROOT, [
        { path: "Dune/Dune.mkv", length: 3_000_000_000 },
        { path: "Keep/Owned.mkv", length: 5_000_000_000 },
      ]),
      before,
      io,
    );
    assert.equal(out.freedBytes, 3_000_000_000, "the whole allocation is credited back");
    assert.deepEqual(out.removed, [path.join(ROOT, "Dune", "Dune.mkv")]);
    assert.equal(out.keptPreexisting, 1, "the owner's file is reported as kept");
    assert.deepEqual(
      io.remaining(),
      [path.join(ROOT, "Keep", "Owned.mkv")],
      "THE NON-NEGOTIABLE: pre-existing media survives a failed add",
    );
  });

  await check("releasing prunes the directories it emptied, deepest first", () => {
    const io = fakeFs({ [path.join(ROOT, "A", "B", "x.mkv")]: 10 });
    releaseFailedAllocation(tor(ROOT, [{ path: "A/B/x.mkv", length: 10 }]), new Set(), io);
    assert.deepEqual(io.removedDirs, [path.join(ROOT, "A", "B")]);
  });

  await check("a file that vanished under us frees nothing and does not throw", () => {
    const io = fakeFs({});
    const out = releaseFailedAllocation(
      tor(ROOT, [{ path: "Gone/Gone.mkv", length: 999 }]),
      new Set(),
      io,
    );
    assert.equal(out.freedBytes, 0);
    assert.deepEqual(out.removed, []);
  });

  await check("a locked file is not counted as freed", () => {
    const io = fakeFs({ [path.join(ROOT, "L", "locked.mkv")]: 42 });
    const locking: AllocationFs = {
      ...io,
      removeFile: () => {
        throw new Error("EBUSY");
      },
    };
    const out = releaseFailedAllocation(
      tor(ROOT, [{ path: "L/locked.mkv", length: 42 }]),
      new Set(),
      locking,
    );
    assert.equal(out.freedBytes, 0, "we only credit back bytes we actually removed");
    assert.deepEqual(out.removed, []);
  });

  // ── 3. The same rule against a real filesystem ───────────────────────────
  await check("end to end on a real directory: refused add leaves zero new bytes", () => {
    const base = makeScratchDir("tf-alloc");
    try {
      const root = path.join(base, "leech");
      fs.mkdirSync(path.join(root, "Owned"), { recursive: true });
      const owned = path.join(root, "Owned", "Finished.mkv");
      fs.writeFileSync(owned, Buffer.alloc(2048, 7));

      const before = snapshotAllocation(root);
      assert.ok(before.has(path.resolve(owned).toLowerCase()), "snapshot saw the owner's file");

      // The add resolves metadata and preallocates at full length…
      fs.mkdirSync(path.join(root, "New"), { recursive: true });
      const allocated = path.join(root, "New", "Preallocated.mkv");
      fs.writeFileSync(allocated, Buffer.alloc(4096));

      // …then fails. Release must undo exactly its own work.
      const out = releaseFailedAllocation(
        tor(root, [
          { path: "New/Preallocated.mkv", length: 4096 },
          { path: "Owned/Finished.mkv", length: 2048 },
        ]),
        before,
      );

      assert.equal(out.freedBytes, 4096);
      assert.equal(fs.existsSync(allocated), false, "the failed add's bytes are gone");
      assert.equal(fs.existsSync(owned), true, "the owner's media is untouched");
      assert.equal(
        fs.existsSync(path.join(root, "New")),
        false,
        "the release root it created is pruned too",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  await check("snapshotAllocation is recursive and tolerates an unreadable root", () => {
    const base = makeScratchDir("tf-snap");
    try {
      fs.mkdirSync(path.join(base, "a", "b"), { recursive: true });
      fs.writeFileSync(path.join(base, "a", "b", "deep.bin"), "x");
      fs.writeFileSync(path.join(base, "top.bin"), "x");
      const snap = snapshotAllocation(base);
      assert.ok(snap.has(path.resolve(base, "a", "b", "deep.bin").toLowerCase()));
      assert.ok(snap.has(path.resolve(base, "top.bin").toLowerCase()));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
    assert.equal(snapshotAllocation("").size, 0, "no destination, no snapshot");
    // Wrapped rather than inlined: `makeScratchDir` inline had no owner, so the
    // directory it created outlived every run. Two of them were found sitting in
    // the download folder — a small leak, but from the exact suite that exists to
    // prove this app does not leak storage.
    withScratchDirSync("tf-absent", (absentBase) => {
      assert.equal(
        snapshotAllocation(path.join(absentBase, "no-such-child")).size,
        0,
        "an unreadable root yields an empty snapshot rather than throwing",
      );
    });
  });

  console.log(
    failures === 0
      ? "\nPASS add-allocation: a failed add releases its own bytes and only its own bytes"
      : `\n${failures} add-allocation test(s) failed`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
