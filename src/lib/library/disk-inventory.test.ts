/**
 * Run: npx tsx src/lib/library/disk-inventory.test.ts
 *
 * Every case here pins a RULE CLASS, not the one folder from the complaint.
 * The reported symptom was a 2,835 MB Guardians file the app could not see, but
 * the defect is "no reconciliation between the rows and the volume", so the
 * tables below run diverse shapes: movies, multi-season TV, loose root files,
 * dot-prefixed internals of several names, tracked-by-verified-path and
 * tracked-by-savePath rows, junctions, traversal, and truncated walks.
 *
 * Directories come from the scratch-dir helper and nowhere else — this suite
 * runs on the machine holding the owner's media library, and a stray scratch
 * root is a real storage leak (see `test-support/scratch-dir.ts`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeScratchDir, removeScratchDir } from "@/lib/test-support/scratch-dir";
import {
  classifyDiskEntry,
  isSafeRelativeEntryPath,
  orphanGroupKey,
  resolveOrphanTarget,
  scanDiskInventory,
  trackedClaims,
  type DiskEntryKind,
  type TrackedTorrentRef,
} from "./disk-inventory";

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  })();
}

/** Write a file, creating parents. Size is filled with zero bytes. */
function writeFile(root: string, relative: string, bytes: number): string {
  const full = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
  return full;
}

// ---------------------------------------------------------------------------
// 1. Classification — each kind, by rule not by example
// ---------------------------------------------------------------------------

async function classificationTable() {
  await check("classification: every kind is decided by rule, not by name", () => {
    const root = "D:/lib";
    const claims = trackedClaims([
      // Tracked by exact verified path.
      {
        name: "Severance S02E05",
        savePath: "D:/lib/TV/Severance/Season 02",
        verifiedFilesJson: JSON.stringify([
          { path: "D:/lib/TV/Severance/Season 02/Severance S02E05.mkv" },
        ]),
      },
      // Tracked by savePath/name — a row at 0% has no verified files yet but is
      // absolutely holding a preallocated file. This was 8 of the 40 GB.
      {
        name: "Tracked Movie (2020)",
        savePath: "D:/lib/Movies",
        verifiedFilesJson: null,
      },
    ]);

    const cases: Array<{
      why: string;
      relativePath: string;
      expected: DiskEntryKind;
    }> = [
      {
        why: "verified path of a live row",
        relativePath: "TV/Severance/Season 02/Severance S02E05.mkv",
        expected: "tracked",
      },
      {
        why: "file inside a live row's own folder, before verification",
        relativePath: "Movies/Tracked Movie (2020)/movie.mkv",
        expected: "tracked",
      },
      {
        why: "the live row's folder itself as a single-file torrent",
        relativePath: "Movies/Tracked Movie (2020)",
        expected: "tracked",
      },
      {
        why: "test scratch root — dot-prefixed top-level entry",
        relativePath: ".tf-test/case-1/a.bin",
        expected: "internal",
      },
      {
        why: "a DIFFERENT dot-prefixed top-level entry: the rule is the dot",
        relativePath: ".torrent-cache/abc.torrent",
        expected: "internal",
      },
      {
        why: "dot-prefixed top-level FILE, not only directories",
        relativePath: ".torrentflow-layout.json",
        expected: "internal",
      },
      {
        why: "media in a release folder no row accounts for",
        relativePath: "Movies/Guardians of the Galaxy (2014)/guardians.mkv",
        expected: "orphan",
      },
      {
        why: "another show entirely — not a Guardians special case",
        relativePath: "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
        expected: "orphan",
      },
      {
        why: "loose file directly under the root",
        relativePath: "stray.mkv",
        expected: "orphan",
      },
      {
        why: "sibling of a tracked folder with a similar prefix must not be tracked",
        relativePath: "Movies/Tracked Movie (2020) EXTRAS/extra.mkv",
        expected: "orphan",
      },
      {
        why: "dot-prefixed BELOW the top level is just a stray file",
        relativePath: "Movies/Some Film/.nomedia",
        expected: "orphan",
      },
    ];

    for (const c of cases) {
      const actual = classifyDiskEntry({
        relativePath: c.relativePath,
        path: path.resolve(root, ...c.relativePath.split("/")),
        claims,
      });
      assert.equal(actual, c.expected, `${c.why}: ${c.relativePath}`);
    }
  });

  await check(
    "classification: savePath ALONE is never a claim (it would hide every orphan)",
    () => {
      const claims = trackedClaims([
        { name: "Tracked Movie (2020)", savePath: "D:/lib/Movies" },
      ]);
      assert.equal(
        classifyDiskEntry({
          relativePath: "Movies/Something Else/other.mkv",
          path: path.resolve("D:/lib/Movies/Something Else/other.mkv"),
          claims,
        }),
        "orphan",
        "a shared category folder must not launder unaccounted files into 'tracked'",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// 2. Grouping — release folder, loose files, impure folders
// ---------------------------------------------------------------------------

async function groupingTable() {
  await check("grouping: an orphan lands in the release folder the owner names", () => {
    const cases: Array<{
      why: string;
      relativePath: string;
      impure: string[];
      expected: string;
    }> = [
      {
        why: "movie release folder under a category",
        relativePath: "Movies/Guardians of the Galaxy (2014)/guardians.mkv",
        impure: [],
        expected: "Movies/Guardians of the Galaxy (2014)",
      },
      {
        why: "TV episode lifts to the show, not the season",
        relativePath: "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
        impure: [],
        expected: "TV/Rick and Morty",
      },
      {
        why: "a second show groups separately — one group per release",
        relativePath: "TV/The Bear/Season 01/bear.s01e01.mkv",
        impure: [],
        expected: "TV/The Bear",
      },
      {
        why: "file directly in a category folder",
        relativePath: "Movies/loose-in-category.mkv",
        impure: [],
        expected: "Movies",
      },
      {
        why: "loose file directly under the root is its own group",
        relativePath: "stray.mkv",
        impure: [],
        expected: "",
      },
      {
        why: "a show folder that still holds a tracked file descends to the season",
        relativePath: "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
        impure: ["TV", "TV/Rick and Morty"],
        expected: "TV/Rick and Morty/Season 01",
      },
      {
        why: "even the file's own parent may be impure — the group stops there",
        relativePath: "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
        impure: ["TV", "TV/Rick and Morty", "TV/Rick and Morty/Season 01"],
        expected: "TV/Rick and Morty/Season 01",
      },
      {
        why: "deeply nested extras still resolve to the release folder",
        relativePath: "Movies/Some Film (1999)/Subs/English/sub.srt",
        impure: [],
        expected: "Movies/Some Film (1999)",
      },
    ];

    for (const c of cases) {
      assert.equal(
        orphanGroupKey({
          relativePath: c.relativePath,
          impureDirs: new Set(c.impure),
        }),
        c.expected,
        c.why,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 3. The walk over a real tree: buckets, invariant, groups, loose files
// ---------------------------------------------------------------------------

interface TreeShape {
  why: string;
  files: Array<{ rel: string; bytes: number }>;
  tracked: (root: string) => TrackedTorrentRef[];
  expect: (report: Awaited<ReturnType<typeof scanDiskInventory>>) => void;
}

async function walkTable() {
  const shapes: TreeShape[] = [
    {
      why: "the reported shape: tracked rows, app internals, and invisible media",
      files: [
        { rel: "Movies/Tracked Movie (2020)/movie.mkv", bytes: 4096 },
        { rel: "Movies/Guardians of the Galaxy (2014)/guardians.mkv", bytes: 8192 },
        { rel: "Movies/Guardians of the Galaxy (2014)/poster.jpg", bytes: 512 },
        { rel: "TV/Rick and Morty/Season 01/rm.s01e01.mkv", bytes: 2048 },
        { rel: "TV/Rick and Morty/Season 02/rm.s02e01.mkv", bytes: 1024 },
        { rel: ".tf-test/leftover/junk.bin", bytes: 256 },
        { rel: ".torrent-cache/abc.torrent", bytes: 128 },
        { rel: "stray-download.mkv", bytes: 64 },
      ],
      tracked: (root) => [
        { name: "Tracked Movie (2020)", savePath: path.join(root, "Movies") },
      ],
      expect: (report) => {
        assert.equal(report.trackedBytes, 4096, "tracked bytes");
        assert.equal(report.internalBytes, 256 + 128, "internal bytes");
        assert.equal(
          report.orphanBytes,
          8192 + 512 + 2048 + 1024 + 64,
          "orphan bytes",
        );
        assert.equal(report.orphanFileCount, 5);
        assert.equal(report.truncated, false);

        const keys = report.orphans.map((g) => g.relativePath).sort();
        assert.deepEqual(
          keys,
          ["", "Movies/Guardians of the Galaxy (2014)", "TV/Rick and Morty"].sort(),
          "orphans group into release folders plus the loose bucket",
        );

        const guardians = report.orphans.find(
          (g) => g.relativePath === "Movies/Guardians of the Galaxy (2014)",
        )!;
        assert.equal(guardians.bytes, 8192 + 512);
        assert.equal(guardians.fileCount, 2);
        assert.equal(guardians.folderDeletable, true);
        assert.equal(guardians.name, "Guardians of the Galaxy (2014)");

        const rick = report.orphans.find((g) => g.relativePath === "TV/Rick and Morty")!;
        assert.equal(
          rick.fileCount,
          2,
          "both seasons of an untracked show are one release group",
        );

        const loose = report.orphans.find((g) => g.relativePath === "")!;
        assert.equal(loose.loose, true, "loose files under the root form their own group");
        assert.equal(loose.folderDeletable, false, "the download root is never a delete unit");
        assert.equal(loose.files[0]?.name, "stray-download.mkv");
      },
    },
    {
      why: "a folder holding BOTH a tracked and an untracked file stays impure",
      files: [
        { rel: "TV/Severance/Season 02/tracked.mkv", bytes: 1000 },
        { rel: "TV/Severance/Season 02/untracked.mkv", bytes: 2000 },
      ],
      tracked: (root) => [
        {
          name: "Severance S02E05",
          savePath: path.join(root, "TV", "Severance", "Season 02"),
          verifiedFilesJson: JSON.stringify([
            { path: path.join(root, "TV/Severance/Season 02/tracked.mkv") },
          ]),
        },
      ],
      expect: (report) => {
        assert.equal(report.trackedBytes, 1000);
        assert.equal(report.orphanBytes, 2000);
        const group = report.orphans[0]!;
        assert.equal(group.relativePath, "TV/Severance/Season 02");
        assert.equal(
          group.folderDeletable,
          false,
          "a folder a live transfer still writes into must never be a one-click delete",
        );
      },
    },
    {
      why: "everything tracked — the good state reports zero orphans, not zero bytes",
      files: [{ rel: "Movies/Tracked Movie (2020)/movie.mkv", bytes: 3333 }],
      tracked: (root) => [
        { name: "Tracked Movie (2020)", savePath: path.join(root, "Movies") },
      ],
      expect: (report) => {
        assert.equal(report.orphanBytes, 0);
        assert.equal(report.orphans.length, 0);
        assert.equal(report.diskBytes, 3333);
      },
    },
    {
      why: "an empty download folder is still a valid, reconciled answer",
      files: [],
      tracked: () => [],
      expect: (report) => {
        assert.equal(report.diskBytes, 0);
        assert.equal(report.orphans.length, 0);
        assert.equal(report.truncated, false);
      },
    },
  ];

  for (const shape of shapes) {
    await check(`walk: ${shape.why}`, async () => {
      const root = makeScratchDir("inv-walk");
      try {
        for (const file of shape.files) writeFile(root, file.rel, file.bytes);
        const report = await scanDiskInventory({
          root,
          tracked: shape.tracked(root),
        });

        // The invariant, on every shape: the headline number is exactly the
        // three buckets. An under-report here is the bug being fixed.
        assert.equal(
          report.diskBytes,
          report.trackedBytes + report.orphanBytes + report.internalBytes,
          `reconciliation invariant (${shape.why})`,
        );
        assert.equal(
          report.fileCount,
          report.trackedFileCount + report.internalFileCount + report.orphanFileCount,
          `file counts reconcile (${shape.why})`,
        );

        // The scan measures the same total the OS would.
        const expectedTotal = shape.files.reduce((sum, f) => sum + f.bytes, 0);
        assert.equal(
          report.diskBytes,
          expectedTotal,
          `disk total matches what was written (${shape.why})`,
        );

        shape.expect(report);

        // And it is read-only.
        for (const file of shape.files) {
          assert.ok(
            fs.existsSync(path.join(root, ...file.rel.split("/"))),
            `scanning must not remove ${file.rel}`,
          );
        }
      } finally {
        removeScratchDir(root);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Truncation is reported, never silent
// ---------------------------------------------------------------------------

async function truncationTable() {
  const cases: Array<{
    why: string;
    options: { maxEntries?: number; maxDepth?: number };
    reason: "entries" | "depth";
  }> = [
    {
      why: "breadth cap: more entries than the walk will look at",
      options: { maxEntries: 3 },
      reason: "entries",
    },
    {
      why: "depth cap: a tree deeper than the walk will descend",
      options: { maxDepth: 1 },
      reason: "depth",
    },
  ];

  for (const c of cases) {
    await check(`truncation: ${c.why}`, async () => {
      const root = makeScratchDir("inv-trunc");
      try {
        writeFile(root, "a/b/c/d/deep.mkv", 1000);
        writeFile(root, "a/b/other.mkv", 1000);
        writeFile(root, "Movies/One (2001)/one.mkv", 1000);
        writeFile(root, "Movies/Two (2002)/two.mkv", 1000);
        writeFile(root, "loose.mkv", 1000);

        const report = await scanDiskInventory({ root, ...c.options });
        assert.equal(report.truncated, true, "a capped walk must say so");
        assert.ok(
          report.truncatedBy.includes(c.reason),
          `expected reason ${c.reason}, got ${report.truncatedBy.join(",")}`,
        );
        assert.ok(
          report.diskBytes < 5000,
          "a truncated walk reports a floor, which is exactly why it must flag itself",
        );
        // Even truncated, the buckets still add up to the reported total.
        assert.equal(
          report.diskBytes,
          report.trackedBytes + report.orphanBytes + report.internalBytes,
          "the invariant holds over what was actually seen",
        );
      } finally {
        removeScratchDir(root);
      }
    });
  }

  await check("truncation: an uncapped walk of the same tree is complete", async () => {
    const root = makeScratchDir("inv-full");
    try {
      writeFile(root, "a/b/c/d/deep.mkv", 1000);
      writeFile(root, "Movies/One (2001)/one.mkv", 1000);
      const report = await scanDiskInventory({ root });
      assert.equal(report.truncated, false);
      assert.deepEqual(report.truncatedBy, []);
      assert.equal(report.diskBytes, 2000);
    } finally {
      removeScratchDir(root);
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Links: never followed out of the root, never double-counted
// ---------------------------------------------------------------------------

async function linkBehaviour() {
  await check("links: a junction inside the root is neither followed nor counted", async () => {
    const root = makeScratchDir("inv-link-root");
    const outside = makeScratchDir("inv-link-outside");
    try {
      writeFile(root, "Movies/Real (2001)/real.mkv", 1000);
      writeFile(outside, "secret.mkv", 9999);

      let linked = false;
      try {
        fs.symlinkSync(outside, path.join(root, "escape"), "junction");
        linked = true;
      } catch {
        // Some environments forbid reparse points; the rest of the suite still
        // proves the containment rule through resolveOrphanTarget.
      }

      const report = await scanDiskInventory({ root });
      assert.equal(
        report.diskBytes,
        1000,
        "bytes behind a link must not be attributed to this folder",
      );
      if (linked) {
        assert.equal(report.linksSkipped, 1, "the skipped link is reported, not hidden");
      }

      // Same again for a link pointing back INSIDE the root: following it would
      // count the same bytes twice.
      let selfLinked = false;
      try {
        fs.symlinkSync(
          path.join(root, "Movies"),
          path.join(root, "movies-alias"),
          "junction",
        );
        selfLinked = true;
      } catch {
        /* environment forbids it */
      }
      if (selfLinked) {
        const second = await scanDiskInventory({ root });
        assert.equal(
          second.diskBytes,
          1000,
          "a link back into the root must not double-count",
        );
      }
    } finally {
      removeScratchDir(root);
      removeScratchDir(outside);
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Delete-target resolution: containment and live-torrent refusals
// ---------------------------------------------------------------------------

async function containmentTable() {
  await check("containment: syntactically unsafe paths never reach the filesystem", () => {
    const rejected = [
      "",
      "   ",
      "..",
      "../outside.mkv",
      "..\\outside.mkv",
      "Movies/../../outside.mkv",
      "C:/Windows/System32/drivers/etc/hosts",
      "C:\\Windows",
      "/etc/passwd",
      "\\\\server\\share\\file.mkv",
      "//server/share/file.mkv",
      "Movies/\0evil.mkv",
    ];
    for (const value of rejected) {
      assert.equal(
        isSafeRelativeEntryPath(value),
        false,
        `must reject: ${JSON.stringify(value)}`,
      );
    }
    const accepted = [
      "loose.mkv",
      "Movies/Guardians of the Galaxy (2014)",
      "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
      "Movies\\Guardians of the Galaxy (2014)",
    ];
    for (const value of accepted) {
      assert.equal(isSafeRelativeEntryPath(value), true, `must accept: ${value}`);
    }
  });

  await check("containment: the resolver refuses every escape and every live file", async () => {
    const root = makeScratchDir("inv-resolve");
    const outside = makeScratchDir("inv-resolve-outside");
    try {
      writeFile(root, "Movies/Tracked Movie (2020)/movie.mkv", 1000);
      writeFile(root, "Movies/Guardians of the Galaxy (2014)/guardians.mkv", 2000);
      writeFile(root, "TV/Severance/Season 02/tracked.mkv", 1500);
      writeFile(root, "TV/Severance/Season 02/untracked.mkv", 500);
      writeFile(root, ".tf-test/leftover/junk.bin", 100);
      writeFile(root, "loose.mkv", 300);
      writeFile(outside, "secret.mkv", 9999);

      let junction = false;
      try {
        fs.symlinkSync(outside, path.join(root, "escape"), "junction");
        junction = true;
      } catch {
        /* environment forbids reparse points */
      }

      const tracked: TrackedTorrentRef[] = [
        { name: "Tracked Movie (2020)", savePath: path.join(root, "Movies") },
        {
          name: "Severance S02E05",
          savePath: path.join(root, "TV", "Severance", "Season 02"),
          verifiedFilesJson: JSON.stringify([
            { path: path.join(root, "TV/Severance/Season 02/tracked.mkv") },
          ]),
        },
      ];

      const cases: Array<{
        why: string;
        relativePath: string;
        expect: "ok" | string;
        skip?: boolean;
      }> = [
        {
          why: "traversal above the root",
          relativePath: "../" + path.basename(outside) + "/secret.mkv",
          expect: "not-relative",
        },
        {
          why: "traversal buried mid-path",
          relativePath: "Movies/../../outside.mkv",
          expect: "not-relative",
        },
        {
          why: "absolute path outside the root",
          relativePath: path.join(outside, "secret.mkv"),
          expect: "not-relative",
        },
        {
          why: "UNC share",
          relativePath: "\\\\server\\share\\secret.mkv",
          expect: "not-relative",
        },
        {
          why: "junction that escapes the root",
          relativePath: "escape/secret.mkv",
          expect: "escapes-root",
          skip: !junction,
        },
        {
          why: "the junction directory itself",
          relativePath: "escape",
          expect: "escapes-root",
          skip: !junction,
        },
        {
          why: "TorrentFlow's own scratch root",
          relativePath: ".tf-test",
          expect: "internal",
        },
        {
          why: "a file inside TorrentFlow's own scratch root",
          relativePath: ".tf-test/leftover/junk.bin",
          expect: "internal",
        },
        {
          why: "a file a live transfer owns (by savePath/name)",
          relativePath: "Movies/Tracked Movie (2020)/movie.mkv",
          expect: "tracked",
        },
        {
          why: "a file a live transfer owns (by verified path)",
          relativePath: "TV/Severance/Season 02/tracked.mkv",
          expect: "tracked",
        },
        {
          why: "a folder that still holds a live transfer's file",
          relativePath: "TV/Severance/Season 02",
          expect: "contains-tracked",
        },
        {
          why: "a folder a live transfer owns outright",
          relativePath: "Movies/Tracked Movie (2020)",
          expect: "tracked",
        },
        {
          why: "something that is not there",
          relativePath: "Movies/Nope (1999)",
          expect: "missing",
        },
        {
          why: "a genuinely orphaned release folder",
          relativePath: "Movies/Guardians of the Galaxy (2014)",
          expect: "ok",
        },
        {
          why: "a genuinely orphaned loose file",
          relativePath: "loose.mkv",
          expect: "ok",
        },
        {
          why: "an orphaned file inside an impure folder",
          relativePath: "TV/Severance/Season 02/untracked.mkv",
          expect: "ok",
        },
      ];

      for (const c of cases) {
        if (c.skip) continue;
        const result = await resolveOrphanTarget({
          root,
          relativePath: c.relativePath,
          tracked,
        });
        if (c.expect === "ok") {
          assert.equal(result.ok, true, `${c.why} should resolve: ${c.relativePath}`);
        } else {
          assert.equal(result.ok, false, `${c.why} must be refused: ${c.relativePath}`);
          assert.equal(
            result.ok === false ? result.reason : "",
            c.expect,
            `${c.why}: wrong refusal reason`,
          );
        }
      }

      // The root itself is never a target, however it is spelled.
      for (const spelling of [".", "./", ".\\"]) {
        const result = await resolveOrphanTarget({
          root,
          relativePath: spelling,
          tracked,
        });
        assert.equal(result.ok, false, `the download root must never resolve: ${spelling}`);
      }

      // Resolving is read-only: nothing above may have been deleted.
      for (const rel of [
        "Movies/Tracked Movie (2020)/movie.mkv",
        "Movies/Guardians of the Galaxy (2014)/guardians.mkv",
        "TV/Severance/Season 02/tracked.mkv",
        "loose.mkv",
      ]) {
        assert.ok(
          fs.existsSync(path.join(root, ...rel.split("/"))),
          `resolveOrphanTarget must never delete: ${rel}`,
        );
      }
      assert.ok(
        fs.existsSync(path.join(outside, "secret.mkv")),
        "nothing outside the root may be touched",
      );
    } finally {
      removeScratchDir(root);
      removeScratchDir(outside);
    }
  });

  await check("containment: a resolved orphan reports the bytes it would free", async () => {
    const root = makeScratchDir("inv-resolve-bytes");
    try {
      writeFile(root, "Movies/Guardians of the Galaxy (2014)/guardians.mkv", 2000);
      writeFile(root, "Movies/Guardians of the Galaxy (2014)/poster.jpg", 500);
      const result = await resolveOrphanTarget({
        root,
        relativePath: "Movies/Guardians of the Galaxy (2014)",
        tracked: [],
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.kind, "directory");
        assert.equal(result.bytes, 2500);
        assert.equal(result.fileCount, 2);
        assert.equal(path.resolve(result.path), path.resolve(root, "Movies/Guardians of the Galaxy (2014)"));
      }
    } finally {
      removeScratchDir(root);
    }
  });

  await check("containment: a truncated folder walk is refused, not guessed", async () => {
    const root = makeScratchDir("inv-resolve-trunc");
    try {
      writeFile(root, "Movies/Big (2001)/a.mkv", 100);
      writeFile(root, "Movies/Big (2001)/b.mkv", 100);
      writeFile(root, "Movies/Big (2001)/c.mkv", 100);
      const result = await resolveOrphanTarget({
        root,
        relativePath: "Movies/Big (2001)",
        tracked: [],
        maxEntries: 1,
      });
      assert.equal(result.ok, false, "a partial walk cannot prove a folder is orphaned");
      assert.equal(result.ok === false ? result.reason : "", "contains-tracked");
    } finally {
      removeScratchDir(root);
    }
  });
}

// ---------------------------------------------------------------------------

async function main() {
  await classificationTable();
  await groupingTable();
  await walkTable();
  await truncationTable();
  await linkBehaviour();
  await containmentTable();

  if (failures > 0) {
    console.error(`disk-inventory.test.ts: ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log("disk-inventory.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
