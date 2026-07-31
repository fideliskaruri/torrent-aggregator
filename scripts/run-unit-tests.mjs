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

/** Same reasoning as TSX: call the local prisma binary, never `npx prisma`. */
const PRISMA = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
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

/**
 * Bring the private copy up to the current schema.
 *
 * `createPrivateDb` snapshots `dev.db`, which is the user's live database and is
 * deliberately NOT migrated on their behalf — a migration window is theirs to
 * choose, and the app has real data. So the copy is missing any migration not
 * yet applied to `dev.db`, and a suite that reads a column from an unapplied
 * migration fails with `SQLITE_ERROR: no such column`. That looks like a broken
 * test but is a schema-application gap: the code and its RED-provable test are
 * correct, the test database is simply behind. (This is exactly how a live
 * data-loss bug in the eviction path stayed hidden — its guarding test could
 * never run to red because the `evictLease` column was missing here.)
 *
 * `migrate deploy` applies only the pending migrations, offline, and — because
 * the URL points at the COPY and `dev.db` never appears in it — can never touch
 * the user's database. If it fails, say so loudly and continue: the
 * schema-dependent suites will then fail visibly, which is the honest signal.
 */
function migratePrivateDb(url) {
  const r = spawnSync(PRISMA, ["migrate", "deploy"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: url },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 0) {
    const applied = [...out.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    if (applied.length) {
      console.log(`Applied ${applied.length} pending migration(s) to the private database:`);
      for (const name of applied) console.log(`  ${name}`);
    } else {
      console.log("Private database already at the current schema.");
    }
  } else {
    console.warn(
      "WARNING: could not migrate the private database; schema-dependent suites may fail.",
    );
    console.warn(out.split(/\r?\n/).filter(Boolean).slice(0, 6).join("\n"));
  }
}

const privateDb = createPrivateDb();
if (privateDb) {
  console.log(`Using private database ${privateDb.url}\n`);
  migratePrivateDb(privateDb.url);
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

  // But leniency must stop at the line between "exited untidily" and "died".
  //
  // The original rule forgave ANY non-zero exit that had printed a PASS, which
  // meant a file that crashed halfway through — after some assertions had
  // printed and before the rest ever ran — was reported as green. The suite
  // would then claim to cover behaviour it had not actually executed, which is
  // worse than a red run because it is trusted.
  //
  // A hard crash is distinguishable and is never forgiven:
  //   - a signal (SIGSEGV / SIGABRT) killed it;
  //   - the runner's own timeout fired, so the file never finished;
  //   - the code is an NTSTATUS-shaped value (>= 0xC0000000), which on Windows
  //     means access violation, stack overflow, heap corruption and friends.
  //     Node's own `process.exit(n)` can never produce one, so seeing one here
  //     is unambiguous.
  const NTSTATUS_FLOOR = 0xc0000000;
  const crashed =
    r.signal != null ||
    r.error?.code === "ETIMEDOUT" ||
    (typeof r.status === "number" && r.status >= NTSTATUS_FLOOR);

  const ok = !sawFail && !crashed && (r.status === 0 || sawPass);
  // That leniency is justified, but it must never be silent: a file counted
  // green on a non-zero exit is green because of this rule, not because the
  // process succeeded. Track it so "N/N passed" can state how much of itself
  // rests on the exception.
  const forgiven = ok && r.status !== 0;
  if (crashed) {
    console.log(
      `        crashed: ${
        r.signal
          ? `signal ${r.signal}`
          : r.error?.code === "ETIMEDOUT"
            ? "timed out — the file never finished"
            : `exit 0x${(r.status >>> 0).toString(16).toUpperCase()}`
      } — PASS markers before a crash do not count`,
    );
  }

  results.push({ file, ok, took, out, forgiven, status: r.status, crashed });
  console.log(`${ok ? "PASS" : "FAIL"}${forgiven ? "*" : " "} ${file}  (${took}ms)${forgiven ? `  [exit ${r.status}, counted green on PASS marker]` : ""}`);
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
const forgiven = results.filter((r) => r.forgiven);
if (privateDb) {
  fs.rmSync(privateDb.dir, { recursive: true, force: true });
}
console.log(
  `\n${failed.length === 0 ? "ALL GREEN" : `${failed.length} FAILED`} — ` +
    `${results.length - failed.length}/${results.length} passed`,
);
if (forgiven.length) {
  console.log(
    `\n${forgiven.length} of those passed DESPITE a non-zero exit code, counted green because the ` +
      `output contained a PASS marker and no FAIL marker (see the rule above). Quote the total ` +
      `with that caveat, and if one of these ever regresses in a way that does not print FAIL, ` +
      `this runner will not catch it:`,
  );
  console.log(forgiven.map((f) => `  - ${f.file}  (exit ${f.status})`).join("\n"));
}
if (failed.length) {
  console.log(failed.map((f) => `  - ${f.file}`).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
