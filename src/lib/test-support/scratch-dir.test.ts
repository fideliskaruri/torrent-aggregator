/**
 * The rule: a test suite that proves the app does not leak storage must not
 * itself leak storage.
 *
 * The owner's words, after finding 40 GB of files the app could not account
 * for: *"i cna't even see these on my downloads, ik this is the test folder but
 * please write to the same folder whilst testing to avoid storage runaway"*.
 *
 * Every scratch directory therefore lives under ONE named folder inside the
 * download root the owner has already accepted, and is removed in a `finally`.
 * A crashed run leaves at most one folder somewhere they already look — never a
 * random tree under `%TEMP%` that nobody will find and nothing will measure.
 *
 * Two kinds of check live here, and both are needed:
 *
 *  1. **Behaviour** — the helper puts directories where it claims, and its
 *     cleanup cannot be talked into deleting anything outside the root.
 *  2. **A source rule** — no test file anywhere may mint its own scratch root.
 *     Without this the convention decays the moment someone reaches for the
 *     obvious `os.tmpdir()`, and the leak returns quietly. Enforcing it by
 *     scanning the tree is what makes the rule a guarantee instead of a habit.
 *
 * Run: npx tsx src/lib/test-support/scratch-dir.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeScratchDir,
  removeScratchDir,
  SCRATCH_DIRNAME,
  scratchRoot,
  withScratchDir,
  withScratchDirSync,
} from "./scratch-dir";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Every `*.test.ts` under src, so the rule cannot be dodged by adding a file. */
async function allTestFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await allTestFiles(full, out);
    } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Ways a test could invent its own scratch root.
 *
 * Each pattern is a real escape hatch someone would plausibly reach for, not a
 * hypothetical. They are listed separately so a violation names the specific
 * habit rather than "matched the regex".
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  {
    // Deliberately anchored to the `os` module rather than the bare word. A
    // rule test that fires on a correctly-named local helper gets muted, and a
    // muted rule protects nothing — precision is what keeps it enforceable.
    pattern: /(\bos\b|require\(["']node:os["']\)|require\(["']os["']\))\s*\.\s*tmpdir\s*\(/,
    why: "writes outside the download root, where the app's storage accounting cannot see it",
  },
  {
    pattern: /\bmkdtemp(Sync)?\s*\(/,
    why: "mints an unnamed root; use makeScratchDir/withScratchDir so cleanup is guaranteed",
  },
  {
    pattern: /process\.env\.(TEMP|TMP|TMPDIR)\b/,
    why: "resolves to the system temp folder, which nothing in this app measures",
  },
  {
    pattern: /from\s+["']node:os["']|import\s+os\s+from/,
    why: "importing os in a test is almost always a scratch-root escape hatch",
  },
];

async function main() {
  console.log("scratch-dir.test.ts");

  const root = scratchRoot();

  // ── Where the bytes land ─────────────────────────────────────────────────
  check("the scratch root sits inside the app's own download folder", () => {
    // The whole point: bytes written by tests are counted by the same storage
    // accounting the tests are verifying. A root anywhere else is invisible.
    assert.equal(path.basename(root), SCRATCH_DIRNAME);
    assert.ok(
      path.resolve(root).startsWith(path.resolve(repoRoot()) + path.sep) ||
        process.env.TORRENTFLOW_TEST_SCRATCH_ROOT,
      `scratch root escaped the repo: ${root}`,
    );
  });

  check("the folder name is dot-prefixed so it is never offered as reclaimable media", () => {
    // `disk-inventory` classifies dot-prefixed top-level entries as internal.
    // Drop the dot and the owner gets asked whether to delete the test folder.
    assert.ok(SCRATCH_DIRNAME.startsWith("."), SCRATCH_DIRNAME);
  });

  await checkAsync("withScratchDir creates a real directory and removes it", async () => {
    let seen = "";
    await withScratchDir("demo", async (dir) => {
      seen = dir;
      assert.ok(fs.existsSync(dir), "directory should exist inside the callback");
      await fsp.writeFile(path.join(dir, "a.bin"), "x");
    });
    assert.ok(seen, "a path should have been produced");
    assert.equal(fs.existsSync(seen), false, "and must be gone afterwards");
  });

  await checkAsync("cleanup still happens when the body throws", async () => {
    // The failure mode this prevents: one throwing test leaves bytes behind on
    // every run, which is exactly how a runaway starts.
    let seen = "";
    await assert.rejects(
      withScratchDir("boom", async (dir) => {
        seen = dir;
        throw new Error("deliberate");
      }),
      /deliberate/,
    );
    assert.equal(fs.existsSync(seen), false);
  });

  check("the sync variant cleans up when the body throws too", () => {
    let seen = "";
    assert.throws(
      () =>
        withScratchDirSync("boom-sync", (dir) => {
          seen = dir;
          throw new Error("deliberate");
        }),
      /deliberate/,
    );
    assert.equal(fs.existsSync(seen), false);
  });

  check("two scratch directories never collide", () => {
    const a = makeScratchDir("same-label");
    const b = makeScratchDir("same-label");
    try {
      assert.notEqual(a, b, "concurrent tests would otherwise delete each other's files");
    } finally {
      removeScratchDir(a);
      removeScratchDir(b);
    }
  });

  // ── Cleanup cannot become a weapon ───────────────────────────────────────
  //
  // `removeScratchDir` does a recursive force delete. A bug in a test must not
  // be able to aim that at the owner's media library, so refusal is verified
  // rather than assumed.
  const refusals: Array<{ name: string; target: () => string }> = [
    { name: "the scratch root itself", target: () => root },
    { name: "the download root above it", target: () => path.dirname(root) },
    { name: "a sibling of the scratch root", target: () => path.join(path.dirname(root), "Movies") },
    { name: "a traversal back out of the root", target: () => path.join(root, "..", "Movies") },
    { name: "an unrelated absolute path", target: () => path.join(repoRoot(), "src") },
    { name: "an empty path", target: () => "" },
  ];
  for (const row of refusals) {
    check(`removeScratchDir refuses ${row.name}`, () => {
      const target = row.target();
      const existedBefore = target ? fs.existsSync(target) : false;
      removeScratchDir(target);
      if (existedBefore) {
        assert.ok(fs.existsSync(target), `removeScratchDir deleted ${target}`);
      }
    });
  }

  // ── The leak rule ────────────────────────────────────────────────────────
  //
  // The source rule above is necessary but not sufficient, and that gap was a
  // real one: every file used the helper correctly, yet two `tf-absent-*`
  // directories were found sitting in the download folder after a run. The
  // cause was `makeScratchDir(...)` called inline as an argument, so nothing
  // ever owned the result or removed it.
  //
  // Using the right helper is not the same as cleaning up. This checks the
  // outcome — an empty scratch root — which is the thing actually promised.
  await checkAsync("a completed suite leaves no scratch directories behind", async () => {
    const root = scratchRoot();
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(root);
    } catch {
      return; // never created: the strongest possible pass
    }

    // Directories belonging to THIS process are expected — the tests above are
    // still running inside it. Anything from another pid is a leak.
    const mine = new RegExp(`-${process.pid}-\\d+$`);
    const leaked = entries.filter((name) => !mine.test(name));

    assert.deepEqual(
      leaked,
      [],
      `left behind by an earlier run — use withScratchDir/withScratchDirSync, or ` +
        `removeScratchDir in a finally:\n  ${leaked.join("\n  ")}`,
    );
  });

  // ── The source rule ──────────────────────────────────────────────────────
  await checkAsync("no test file mints its own scratch root", async () => {    const files = await allTestFiles(path.join(repoRoot(), "src"));
    assert.ok(files.length > 50, `expected to scan the suite, found ${files.length} files`);

    const violations: string[] = [];
    for (const file of files) {
      // This file necessarily names the forbidden patterns in order to ban them.
      if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
      const source = await fsp.readFile(file, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) {
          violations.push(
            `${path.relative(repoRoot(), file)}: ${rule.pattern.source} — ${rule.why}`,
          );
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Use src/lib/test-support/scratch-dir.ts instead:\n  ${violations.join("\n  ")}`,
    );
  });

  if (failures > 0) {
    console.error(`scratch-dir.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("scratch-dir.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
