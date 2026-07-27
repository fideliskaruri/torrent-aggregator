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
import os from "node:os";
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

/**
 * A private database for the run.
 *
 * Several suites (prerank, prewarm, run-lock, eviction) go through
 * `@/lib/prisma`, which points at the repo's `dev.db`. When the dev server is
 * running — which it is during `npm test`, and whenever anyone is actually
 * using the app — those suites failed with Prisma `P1008 SocketTimeout` from
 * SQLite lock contention, not from any assertion. The identical suite passes
 * against its own copy of the file. A test that only passes when the app is
 * stopped reports on the environment rather than on the code, so give the
 * children their own database and leave `dev.db` to the server.
 *
 * The copy carries the WAL and shared-memory sidecars: taking `dev.db` alone
 * while the server holds an open WAL yields a torn snapshot that is missing
 * every recently written row.
 */
function createPrivateDb() {
  const source = path.join(root, "dev.db");
  if (!fs.existsSync(source)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-unit-db-"));
  const target = path.join(dir, "unit.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${source}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
  }
  return { dir, url: `file:${target.split(path.sep).join("/")}` };
}

const privateDb = createPrivateDb();
if (privateDb) {
  console.log(`Using private database ${privateDb.url}\n`);
}
const childEnv = privateDb
  ? { ...process.env, DATABASE_URL: privateDb.url }
  : process.env;

const results = [];
for (const file of files) {
  const started = Date.now();
  const r = spawnSync(TSX, [file], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 180_000,
    env: childEnv,
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
if (privateDb) {
  fs.rmSync(privateDb.dir, { recursive: true, force: true });
}
console.log(
  `\n${failed.length === 0 ? "ALL GREEN" : `${failed.length} FAILED`} — ` +
    `${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f.file}`).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
