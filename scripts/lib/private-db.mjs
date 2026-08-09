/**
 * Create and clean up a private SQLite/libSQL database for test harnesses.
 *
 * The live repo database is the owner's data. Harnesses that write through
 * `@/lib/prisma` must get their own copy, including the WAL/SHM sidecars when
 * present, and then be migrated locally so schema-dependent suites can run
 * without touching `dev.db`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRISMA = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);
const SCRATCH_ROOT = path.join(root, ".next-scratch", "private-db");

fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

const liveDb = path.join(root, "dev.db");
const activeDirs = new Set();

function toFileUrl(filePath) {
  return `file:${filePath.split(path.sep).join("/")}`;
}

export function createPrivateDb(label = "private") {
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, `${label}-`));
  const target = path.join(dir, "private.db");

  if (fs.existsSync(liveDb)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${liveDb}${suffix}`;
      if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
    }
  }

  activeDirs.add(dir);
  return { dir, target, url: toFileUrl(target) };
}

export function migratePrivateDb(url) {
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
    return true;
  }

  console.warn(
    "WARNING: could not migrate the private database; schema-dependent suites may fail.",
  );
  console.warn(out.split(/\r?\n/).filter(Boolean).slice(0, 6).join("\n"));
  return false;
}

export function preparePrivateDb(label = "private") {
  const db = createPrivateDb(label);
  migratePrivateDb(db.url);
  return db;
}

export function cleanupPrivateDb(privateDb) {
  if (!privateDb?.dir || !activeDirs.has(privateDb.dir)) return;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(privateDb.dir, { recursive: true, force: true });
      activeDirs.delete(privateDb.dir);
      return;
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : undefined;
      const locked = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!locked || attempt === 9) return;
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

process.once("exit", () => {
  for (const dir of activeDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on exit */
    }
  }
});
