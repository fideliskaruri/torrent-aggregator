/**
 * Unit test runner.
 *
 * Runs every *.test.ts and reports all of them. The previous `a && b && c`
 * chain stopped at the first failure, so one broken file hid the state of
 * everything after it.
 *
 * Tests that reach live torrent indexers are excluded by default — they fail on
 * networks that block those hosts, which is not a code defect. Run them with
 * `npm run test:live`.
 *
 * Usage:
 *   node scripts/run-unit-tests.mjs           # offline-safe units
 *   node scripts/run-unit-tests.mjs --live    # only the network-dependent ones
 *   node scripts/run-unit-tests.mjs --all     # everything
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Call the installed tsx directly. `npx tsx` reaches for the registry, which
 * fails on networks behind an authenticated proxy even though tsx is already
 * in node_modules.
 */
const TSX = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

/** Test files that hit real indexers over the network. */
const LIVE_TESTS = new Set(["src/lib/library/library-core.test.ts"]);

const mode = process.argv.includes("--live")
  ? "live"
  : process.argv.includes("--all")
    ? "all"
    : "offline";

function findTests(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      findTests(full, acc);
    } else if (entry.name.endsWith(".test.ts")) {
      acc.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return acc;
}

const all = findTests(path.join(root, "src")).sort();
const files = all.filter((f) => {
  const isLive = LIVE_TESTS.has(f);
  if (mode === "all") return true;
  return mode === "live" ? isLive : !isLive;
});

if (files.length === 0) {
  console.log(`No ${mode} tests found.`);
  process.exit(0);
}

console.log(`Running ${files.length} ${mode} test file(s)\n`);

const results = [];
for (const file of files) {
  const started = Date.now();
  const r = spawnSync(TSX, [file], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 180_000,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const took = Date.now() - started;

  // tsx can exit non-zero during teardown (WebTorrent keeps handles open) after
  // the assertions already passed, so trust explicit FAIL markers over the code.
  const sawFail = /\bFAIL\b/.test(out);
  const sawPass = /\bPASS\b/.test(out);
  const ok = !sawFail && (r.status === 0 || sawPass);

  results.push({ file, ok, took, out });
  console.log(`${ok ? "PASS" : "FAIL"}  ${file}  (${took}ms)`);
  if (!ok) {
    console.log(
      out
        .split("\n")
        .filter((l) => l.trim())
        .slice(-25)
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "ALL GREEN" : `${failed.length} FAILED`} — ` +
    `${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f.file}`).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
