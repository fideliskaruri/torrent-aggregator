// Full pre-commit gate: static checks, then a real build, then a real browser
// against a real server.
//
// Safety, non-negotiable and asserted at runtime rather than merely intended:
//   * never touches the user's dev.db  - runs on a COPY in the OS temp dir
//   * never touches the user's :3000   - refuses to start if its port is taken,
//                                        and never uses 3000
//   * never touches .next              - builds into an isolated distDir
//
//   node scripts/probes/gate.mjs [--skip-build] [--port 3400]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 3400;
const DIST = ".next-gate";
/** Local prisma binary — never `npx prisma` (registry is offline here). */
const PRISMA = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");

if (PORT === 3000) throw new Error("gate: port 3000 is the user's live app. Refusing.");

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

function run(name, cmd, args, opts = {}) {
  console.log(`\n── ${name} ──`);
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  if (!ok) console.log(out.split("\n").slice(-40).join("\n"));
  return { ok, out, status: r.status };
}

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });

const waitForHttp = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

// ── scratch DB ───────────────────────────────────────────────────────────────
const liveDb = path.join(repoRoot, "dev.db");
// Baseline BEFORE any work, so the closing check is a comparison and not a
// decorative printout. A number with nothing to compare it against is not proof.
const liveDbBaseline = fs.existsSync(liveDb) ? fs.statSync(liveDb) : null;
// The real media tree. The gate must never create, delete or rearrange anything
// beneath it; record enough to notice if it did.
const MEDIA_ROOT = path.join(repoRoot, ".e2e-instant-play");
const mediaBaseline = fs.existsSync(MEDIA_ROOT)
  ? { mtimeMs: fs.statSync(MEDIA_ROOT).mtimeMs, entries: fs.readdirSync(MEDIA_ROOT).length }
  : null;
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-gate-"));
const scratchDb = path.join(scratchDir, "gate.db");
// Carry the WAL/SHM sidecars. Taking dev.db alone while the server holds an open
// WAL yields a torn snapshot missing every recently written row - the same trap
// scripts/run-unit-tests.mjs:85-87 documents.
for (const suffix of ["", "-wal", "-shm"]) {
  const from = `${liveDb}${suffix}`;
  if (fs.existsSync(from)) fs.copyFileSync(from, `${scratchDb}${suffix}`);
}
const DATABASE_URL = `file:${scratchDb.replace(/\\/g, "/")}`;
console.log(`gate: scratch DB ${scratchDb}`);

/*
 * Bring the scratch copy up to the current schema BEFORE the server starts.
 *
 * dev.db is the owner's live database and is deliberately NOT migrated on their
 * behalf — the migration window is theirs. So a plain copy is missing any
 * migration not yet applied to dev.db, and the app's own Prisma client (already
 * regenerated for the new columns) emits `SELECT ... evictLease, retention ...`
 * against it. The result is `no such column` -> a 500 from every route that
 * reads EngineTorrent/GrabJob/DownloadHistory (e.g. /api/title/*), which is a
 * FALSE gate failure: it certifies the code against a schema the code does not
 * support. `migrate deploy` applies only the pending migrations, offline, and —
 * because DATABASE_URL points at the COPY, never dev.db — cannot touch the live
 * database. It runs on the copy before sanitisation; the sanitiser below only
 * touches path columns, so ordering is independent.
 */
{
  const r = spawnSync(PRISMA, ["migrate", "deploy"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 0) {
    const applied = [...out.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
    console.log(
      applied.length
        ? `gate: applied ${applied.length} pending migration(s) to the scratch copy: ${applied.join(", ")}`
        : "gate: scratch copy already at current schema",
    );
  } else {
    console.warn("gate: WARNING could not migrate the scratch copy; schema-dependent routes may 500.");
    console.warn(out.split(/\r?\n/).filter(Boolean).slice(0, 6).join("\n"));
  }
}

/*
 * Copying the database is NOT enough, and believing it was is how this gate
 * could have destroyed the owner's remaining media.
 *
 * The rows carry absolute filesystem POINTERS - EngineTorrent.savePath and
 * ClientSettings.baseDownloadPath - into the real 13.2 GB media tree. A server
 * started against this copy will, on the first visit to /client, rehydrate
 * those torrents against their stored paths: creating directories, running the
 * layout repair, and attaching WebTorrent to the owner's real files while the
 * live server on :3000 has them open. Two engines, one set of files.
 *
 * So sever the pointers before the server ever starts:
 *   - drop every EngineTorrent row (each one is a pointer at real media);
 *   - repoint every stored download path into this run's temp media root.
 * The catalog, titles, metadata and history all survive, so the pages the gate
 * probes still render real content.
 */
const scratchMedia = path.join(scratchDir, "media");
fs.mkdirSync(scratchMedia, { recursive: true });
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(scratchDb);
  const severed = { engineTorrents: 0, paths: 0 };
  const tableExists = (name) =>
    db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(name).n > 0;

  if (tableExists("EngineTorrent")) {
    severed.engineTorrents = db.prepare("SELECT COUNT(*) n FROM EngineTorrent").get().n;
    db.prepare("DELETE FROM EngineTorrent").run();
  }
  // Repoint any column that looks like a download root, in whatever table holds
  // it. Enumerating from the schema rather than hardcoding table names means a
  // new settings table cannot silently reintroduce a real path.
  const cols = db
    .prepare("SELECT m.name AS tbl, i.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) i WHERE m.type='table'")
    .all()
    .filter((r) => /savePath|baseDownloadPath|downloadDir|saveDir/i.test(r.col));
  for (const { tbl, col } of cols) {
    const res = db.prepare(`UPDATE "${tbl}" SET "${col}" = ? WHERE "${col}" IS NOT NULL`).run(scratchMedia);
    severed.paths += res.changes ?? 0;
  }
  db.close();
  console.log(
    `gate: severed real-media pointers - dropped ${severed.engineTorrents} EngineTorrent rows, ` +
      `repointed ${severed.paths} path values (${cols.map((c) => `${c.tbl}.${c.col}`).join(", ") || "none"}) -> ${scratchMedia}`,
  );
}

const childEnv = {
  ...process.env,
  DATABASE_URL,
  NEXT_DIST_DIR: DIST,
  NEXT_TELEMETRY_DISABLED: "1",
  // Belt and braces: if anything resolves a download root from the environment
  // rather than the database, it still lands in this run's temp tree.
  DOWNLOAD_DIR: scratchMedia,
};

let server = null;
let exitCode = 0;

try {
  // ── 0. the gate must not be lied to ────────────────────────────────────────
  // This run sets NEXT_DIST_DIR to isolate its build. If next.config.ts uses
  // that same flag to also switch OFF type/lint gating, then "next build
  // passed" would mean nothing - the gate would certify code the compiler
  // never checked. Fail loudly rather than report a green build over it.
  const cfg = fs.readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
  // Match the SETTING, not the word. A plain substring search also matches the
  // comment in next.config.ts that explains why those flags are deliberately
  // absent - so the gate failed on its own documentation. A guard that fires on
  // prose is a guard someone deletes.
  const cheatPatterns = [
    ["ignoreBuildErrors", /ignoreBuildErrors\s*:\s*true/],
    ["ignoreDuringBuilds", /ignoreDuringBuilds\s*:\s*true/],
  ];
  const cheats = cheatPatterns.filter(([, re]) => re.test(cfg)).map(([k]) => k);
  record(
    "build config does not disable gating",
    cheats.length === 0,
    cheats.length ? `next.config.ts sets ${cheats.join(", ")} = true - remove before trusting this gate` : "",
  );
  if (cheats.length) throw new Error("build config disables type/lint gating - refusing to certify");

  // The mirror of the check above, and the more dangerous of the two.
  //
  // Setting NEXT_DIST_DIR in this process only isolates the build if
  // next.config.ts actually READS it. If that line is ever removed, this gate
  // silently builds into `.next` - the directory the owner's live production
  // server on :3000 is serving from - and swaps chunks out from under their
  // running app. The env var alone is not evidence; the config honouring it is.
  // Assert the wiring exists BEFORE any build runs, and refuse outright if not.
  const honoursDistDir = /distDir\s*:\s*process\.env\.NEXT_DIST_DIR/.test(cfg);
  record(
    "build is isolated from the live .next",
    honoursDistDir,
    honoursDistDir
      ? `next.config.ts honours NEXT_DIST_DIR -> ${DIST}`
      : "next.config.ts does NOT read NEXT_DIST_DIR - a build here would overwrite the live .next",
  );
  if (!honoursDistDir) {
    throw new Error(
      "refusing to build: next.config.ts does not honour NEXT_DIST_DIR, so this build would " +
        "overwrite .next and break the running server on :3000",
    );
  }

  // ── 1. static ──────────────────────────────────────────────────────────────
  const tsc = run("typecheck", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  const tscErrs = (tsc.out.match(/error TS/g) ?? []).length;
  record("tsc --noEmit", tsc.ok, tscErrs ? `${tscErrs} errors` : "clean");

  const unit = run("unit tests", process.execPath, ["scripts/run-unit-tests.mjs"]);
  const m = unit.out.match(/(\d+)\s*\/\s*(\d+)/g);
  record("unit tests", unit.ok, m ? m[m.length - 1] : "");

  // ── 2. build ───────────────────────────────────────────────────────────────
  if (!SKIP_BUILD) {
    // Positive evidence beats a config regex. Record the live build directory's
    // fingerprint first, then prove after the build that it did not move.
    const liveNext = path.join(repoRoot, ".next");
    const beforeNext = fs.existsSync(liveNext) ? fs.statSync(liveNext).mtimeMs : null;

    /*
     * Clear the gate's own dist first. Next overwrites what it regenerates, but
     * it does not remove artifacts for routes that no longer exist - so without
     * this, a run could start a server that serves a route deleted in the very
     * commit being verified, and pass. The artifact must be provably built by
     * THIS run, not merely present.
     */
    const gateDistPath = path.join(repoRoot, DIST);
    if (fs.existsSync(gateDistPath)) {
      fs.rmSync(gateDistPath, { recursive: true, force: true });
      console.log(`gate: cleared stale ${DIST} so the build output is provably fresh`);
    }

    const build = run("next build", process.execPath, ["node_modules/next/dist/bin/next", "build"], {
      env: childEnv,
    });
    record("next build", build.ok, build.ok ? DIST : `exit ${build.status}`);

    const afterNext = fs.existsSync(liveNext) ? fs.statSync(liveNext).mtimeMs : null;
    const liveUntouched = beforeNext === afterNext;
    record(
      "live .next untouched by the build",
      liveUntouched,
      liveUntouched
        ? "mtime unchanged - the running :3000 server was not disturbed"
        : "THE BUILD WROTE INTO THE LIVE .next - the server on :3000 is now serving a half-swapped build",
    );
    const gateDist = path.join(repoRoot, DIST);
    record(
      `build output landed in ${DIST}`,
      fs.existsSync(gateDist),
      fs.existsSync(gateDist) ? "" : `${DIST} was not created - isolation did not take effect`,
    );

    if (!build.ok) throw new Error("build failed - runtime checks cannot be trusted, stopping");
    if (!liveUntouched) throw new Error("build overwrote the live .next - stopping before any further damage");
  }

  // ── 3. runtime ─────────────────────────────────────────────────────────────
  if (!(await portFree(PORT))) throw new Error(`gate: port ${PORT} is busy; refusing to guess another`);

  console.log(`\n── server on :${PORT} ──`);
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(PORT)],
    { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  server.stdout.on("data", (d) => log.push(String(d)));
  server.stderr.on("data", (d) => log.push(String(d)));

  const up = await waitForHttp(`http://127.0.0.1:${PORT}/`, 90000);
  record("server responds", up, up ? "" : log.join("").slice(-800));
  if (!up) throw new Error("server never came up");

  const base = `http://127.0.0.1:${PORT}`;
  // Page loads only. Deliberately NOT loader-continuity: that probe presses
  // Play, and a press is an action with side effects - against this sanitised
  // DB there is no torrent on disk, so it would kick off a real grab against
  // real indexers from inside a verification run. Loader continuity is measured
  // separately against :3000, where the file is already 100% on disk and
  // pressing Play downloads nothing.
  const probes = [
    ["responsive audit", "scripts/probes/responsive-audit.mjs"],
    // Overlays only exist in the DOM once opened, so the static audit above is
    // structurally blind to them and reported clean over 23 broken surfaces.
    // This one presses the things that announce they open, then measures what
    // mounted. It only presses controls advertising a popup/dialog, so it can
    // never start a grab or delete from inside a verification run.
    ["overlay audit", "scripts/probes/overlay-audit.mjs"],
    ["console errors", "scripts/probes/console-errors.mjs"],
  ];
  for (const [name, script] of probes) {
    const r = run(name, process.execPath, [script, base]);
    const tail = r.out.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    record(name, r.ok, tail.slice(0, 220));
  }
} catch (err) {
  record("gate", false, err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  if (server && !server.killed) {
    try {
      spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      server.kill("SIGKILL");
    }
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

console.log("\n════ GATE ════");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);

// Prove — by comparison against the baseline taken before any work — that this
// run touched neither the live database nor the real media tree. A gate that
// could corrupt the thing it guards is worse than no gate, and a printed number
// with nothing to compare it to is not evidence.
let collateral = false;
if (liveDbBaseline) {
  const now = fs.statSync(liveDb);
  const same = now.size === liveDbBaseline.size && now.mtimeMs === liveDbBaseline.mtimeMs;
  // The owner may be using the app while this runs, so a change is not proof of
  // guilt - but it does mean this run cannot claim innocence, and that must be
  // said out loud rather than glossed over.
  console.log(
    same
      ? `live dev.db UNCHANGED (${now.size} bytes, ${now.mtime.toISOString()})`
      : `live dev.db CHANGED during this run: ${liveDbBaseline.size}b -> ${now.size}b. ` +
        `This gate did not write to it (it used a scratch copy), but it can no longer PROVE that - ` +
        `the owner may have been using the app. Re-run on a quiet machine if you need the proof.`,
  );
}
if (mediaBaseline) {
  const now = { mtimeMs: fs.statSync(MEDIA_ROOT).mtimeMs, entries: fs.readdirSync(MEDIA_ROOT).length };
  const same = now.mtimeMs === mediaBaseline.mtimeMs && now.entries === mediaBaseline.entries;
  console.log(
    same
      ? `real media tree UNCHANGED (${now.entries} entries at ${MEDIA_ROOT})`
      : `!! REAL MEDIA TREE CHANGED: ${mediaBaseline.entries} -> ${now.entries} entries. INVESTIGATE BEFORE COMMITTING.`,
  );
  if (!same) collateral = true;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

process.exit(failed.length || exitCode || collateral ? 1 : 0);
