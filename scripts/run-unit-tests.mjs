/**
 * Unit test runner.
 *
 * Runs every *.test.ts and reports all of them. The previous `a && b && c`
 * chain stopped at the first failure, so one broken file hid the state of
 * everything after it.
 *
 * Tests that reach live torrent indexers are excluded by default — they fail on
 * networks that block those hosts, which is not a code defect. Run them with
 * `pnpm run test:live`.
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
import { cleanupPrivateDb, preparePrivateDb } from "./lib/private-db.mjs";

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

const privateDb = preparePrivateDb("unit");
console.log(`Using private database ${privateDb.url}\n`);
const childEnv = { ...process.env, DATABASE_URL: privateDb.url };

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
cleanupPrivateDb(privateDb);
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
