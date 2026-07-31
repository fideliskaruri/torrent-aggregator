/**
 * Run: npx tsx src/app/api/settings/untracked-files/route.test.ts
 *
 * Two halves:
 *
 *  1. Source shape — the route must authorise, re-derive the target server-side,
 *     and remove ONE entry. A bulk loop or a `rm` on a client-supplied path would
 *     pass every behavioural test below while still being the wrong endpoint.
 *  2. Behaviour — the exact guard-then-remove sequence the route performs, run
 *     against a real scratch tree, over a table of request bodies. Each refusal
 *     must leave the volume byte-for-byte unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeScratchDir, removeScratchDir } from "@/lib/test-support/scratch-dir";
import {
  resolveOrphanTarget,
  type TrackedTorrentRef,
} from "@/lib/library/disk-inventory";

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

function writeFile(root: string, relative: string, bytes: number): void {
  const full = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
}

/** Every file under a folder, relative and POSIX, so trees can be compared. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

const SOURCE = fs.readFileSync(
  "src/app/api/settings/untracked-files/route.ts",
  "utf8",
);

async function sourceShape() {
  await check("route: authorises before it touches the filesystem", () => {
    const authAt = SOURCE.indexOf("await auth()");
    const rmAt = SOURCE.indexOf("fsp.rm(");
    assert.ok(authAt > -1, "the route must authenticate");
    assert.ok(rmAt > authAt, "nothing may be removed before the session check");
    assert.match(SOURCE, /status:\s*401/, "an unauthenticated caller is refused");
  });

  await check("route: re-derives the target server-side, never trusts the path", () => {
    assert.match(
      SOURCE,
      /resolveOrphanTarget\(\{\s*root,\s*relativePath,\s*tracked\s*\}\)/,
      "containment, internal status and live-torrent ownership are recomputed here",
    );
    assert.match(
      SOURCE,
      /await\s+trackedTorrentRefs\(/,
      "the live rows must be read at request time, not cached from the page",
    );
    assert.match(
      SOURCE,
      /fsp\.rm\(\s*target\.path/,
      "only the resolved, realpath-checked path may be removed",
    );
    assert.doesNotMatch(
      SOURCE,
      /fsp\.rm\(\s*(body|relativePath|request)/,
      "a client-supplied path must never reach the filesystem",
    );
    assert.doesNotMatch(
      SOURCE,
      /force:\s*true/,
      "force would paper over a target that vanished between check and delete",
    );
  });

  await check("route: removes one entry per request, with no bulk escape hatch", () => {
    assert.doesNotMatch(
      SOURCE,
      /for\s*\([^)]*\)\s*\{[^}]*fsp\.rm/,
      "no loop may delete",
    );
    assert.doesNotMatch(SOURCE, /relativePaths|entries\s*:\s*string\[\]/);
    assert.doesNotMatch(/* the owner's complaint was invisible deletion */ SOURCE, /cleanAll|purgeAll|deleteAllOrphans/i);
  });

  await check("route: refusals are typed, and the caches are invalidated after a delete", () => {
    assert.match(SOURCE, /REFUSAL_STATUS: Record<OrphanTargetRefusal, number>/);
    for (const [reason, status] of [
      ["not-relative", 403],
      ["escapes-root", 403],
      ["is-root", 403],
      ["internal", 403],
      ["missing", 404],
      ["tracked", 409],
      ["contains-tracked", 409],
    ] as const) {
      assert.match(
        SOURCE,
        new RegExp(`"?${reason}"?:\\s*${status}`),
        `${reason} must map to ${status}`,
      );
    }
    const rmAt = SOURCE.indexOf("fsp.rm(");
    assert.ok(
      SOURCE.indexOf("resetDirectorySizeCache()") > rmAt,
      "the cap's size cache must be cleared after the delete, or the number lies",
    );
    assert.ok(
      SOURCE.indexOf("resetDiskInventoryCache()") > rmAt,
      "the inventory memo must be cleared after the delete",
    );
    assert.match(
      SOURCE,
      /usage,?\s*\}\);/,
      "the response returns the recomputed totals so the panel reconciles immediately",
    );
  });
}

// ---------------------------------------------------------------------------

/** The route's guard-then-remove sequence, with the HTTP layer stripped off. */
async function handle(
  root: string,
  relativePath: string,
  tracked: readonly TrackedTorrentRef[],
): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  const target = await resolveOrphanTarget({ root, relativePath, tracked });
  if (!target.ok) return { ok: false, reason: target.reason };
  await fsp.rm(target.path, { recursive: target.kind === "directory", force: false });
  return { ok: true, bytes: target.bytes };
}

async function behaviour() {
  const cases: Array<{
    why: string;
    relativePath: string;
    reason: string;
  }> = [
    { why: "traversal above the root", relativePath: "../escape.mkv", reason: "not-relative" },
    { why: "traversal buried mid-path", relativePath: "Movies/../../escape.mkv", reason: "not-relative" },
    { why: "UNC share", relativePath: "\\\\server\\share\\x.mkv", reason: "not-relative" },
    { why: "the app's own scratch root", relativePath: ".tf-test", reason: "internal" },
    {
      why: "a file a live transfer owns",
      relativePath: "TV/Severance/Season 02/tracked.mkv",
      reason: "tracked",
    },
    {
      why: "a folder a live transfer still writes into",
      relativePath: "TV/Severance/Season 02",
      reason: "contains-tracked",
    },
    {
      why: "a folder a live transfer owns outright",
      relativePath: "Movies/Tracked Movie (2020)",
      reason: "tracked",
    },
    { why: "something already gone", relativePath: "Movies/Gone (1999)", reason: "missing" },
  ];

  for (const c of cases) {
    await check(`delete refused: ${c.why}`, async () => {
      const root = makeScratchDir("untracked-refuse");
      try {
        writeFile(root, "Movies/Tracked Movie (2020)/movie.mkv", 1000);
        writeFile(root, "Movies/Guardians of the Galaxy (2014)/guardians.mkv", 2000);
        writeFile(root, "TV/Severance/Season 02/tracked.mkv", 1500);
        writeFile(root, "TV/Severance/Season 02/untracked.mkv", 500);
        writeFile(root, ".tf-test/leftover/junk.bin", 100);
        const before = snapshot(root);

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

        const result = await handle(root, c.relativePath, tracked);
        assert.equal(result.ok, false, `${c.why} must be refused`);
        assert.equal(result.reason, c.reason, `${c.why}: wrong reason`);
        assert.deepEqual(
          snapshot(root),
          before,
          `${c.why}: a refused request must leave the volume untouched`,
        );
      } finally {
        removeScratchDir(root);
      }
    });
  }

  await check("delete allowed: exactly one entry goes, and only that one", async () => {
    const root = makeScratchDir("untracked-delete");
    try {
      writeFile(root, "Movies/Tracked Movie (2020)/movie.mkv", 1000);
      writeFile(root, "Movies/Guardians of the Galaxy (2014)/guardians.mkv", 2000);
      writeFile(root, "Movies/Guardians of the Galaxy (2014)/poster.jpg", 500);
      writeFile(root, "TV/Rick and Morty/Season 01/rm.s01e01.mkv", 300);
      writeFile(root, ".tf-test/leftover/junk.bin", 100);
      writeFile(root, "loose.mkv", 700);

      const tracked: TrackedTorrentRef[] = [
        { name: "Tracked Movie (2020)", savePath: path.join(root, "Movies") },
      ];

      const folder = await handle(
        root,
        "Movies/Guardians of the Galaxy (2014)",
        tracked,
      );
      assert.equal(folder.ok, true);
      assert.equal(folder.bytes, 2500, "the response reports the bytes actually freed");
      assert.deepEqual(snapshot(root), [
        ".tf-test/leftover/junk.bin",
        "Movies/Tracked Movie (2020)/movie.mkv",
        "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
        "loose.mkv",
      ]);

      const loose = await handle(root, "loose.mkv", tracked);
      assert.equal(loose.ok, true);
      assert.equal(loose.bytes, 700);
      assert.deepEqual(snapshot(root), [
        ".tf-test/leftover/junk.bin",
        "Movies/Tracked Movie (2020)/movie.mkv",
        "TV/Rick and Morty/Season 01/rm.s01e01.mkv",
      ]);
    } finally {
      removeScratchDir(root);
    }
  });

  await check(
    "delete allowed: an orphan inside a folder a transfer also uses",
    async () => {
      const root = makeScratchDir("untracked-mixed");
      try {
        writeFile(root, "TV/Severance/Season 02/tracked.mkv", 1500);
        writeFile(root, "TV/Severance/Season 02/untracked.mkv", 500);
        const tracked: TrackedTorrentRef[] = [
          {
            name: "Severance S02E05",
            savePath: path.join(root, "TV", "Severance", "Season 02"),
            verifiedFilesJson: JSON.stringify([
              { path: path.join(root, "TV/Severance/Season 02/tracked.mkv") },
            ]),
          },
        ];
        const result = await handle(
          root,
          "TV/Severance/Season 02/untracked.mkv",
          tracked,
        );
        assert.equal(result.ok, true);
        assert.deepEqual(
          snapshot(root),
          ["TV/Severance/Season 02/tracked.mkv"],
          "the live transfer's file must survive",
        );
      } finally {
        removeScratchDir(root);
      }
    },
  );
}

async function main() {
  await sourceShape();
  await behaviour();
  if (failures > 0) {
    console.error(`untracked-files/route.test.ts: ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log("untracked-files/route.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
