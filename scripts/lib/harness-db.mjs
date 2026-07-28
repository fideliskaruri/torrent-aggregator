/**
 * Isolate a harness from the user's live database.
 *
 * A journey harness (e.g. `media-instant-play-e2e.mts`) seeds fixture torrents
 * and lets the running app persist them through `@/lib/prisma`, which resolves
 * `DATABASE_URL` — defaulting to the repo's `dev.db`, the user's real library.
 * Every fixture the harness or its spawned server writes then lands in Continue
 * Watching / Active downloads / Recently measured, and a crash before the row
 * cleanup leaves it there for good. That is exactly the `.e2e-instant-play`
 * pollution found in the live DB.
 *
 * The fix is structural, not a bigger delete: give the harness its own throwaway
 * copy of the database and repoint `DATABASE_URL` at it, so nothing the harness
 * does can reach `dev.db` in the first place.
 *
 * IMPORTANT — import ordering. `@/lib/prisma` reads `DATABASE_URL` and builds its
 * client at module-evaluation time. ESM executes imports in source order, so this
 * module MUST be imported *before* any import that transitively pulls in
 * `@/lib/prisma` (i.e. before the harness's own `import { prisma }`). The env var
 * is set as an import side effect precisely so it wins that race. Only harness /
 * probe scripts should import this; application code never does.
 *
 * The copy carries the WAL and shared-memory sidecars — taking `dev.db` alone
 * while the server holds an open WAL yields a torn snapshot missing every
 * recently written row (same reasoning as `run-unit-tests.mjs`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function provisionScratchDb() {
  const source = path.join(root, "dev.db");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-harness-db-"));
  const target = path.join(dir, "harness.db");

  // Copy the live DB if it exists so the schema and any rows the harness reads
  // are already present; otherwise the harness runs against an empty file and
  // `prisma migrate deploy` (its own responsibility) can populate the schema.
  if (fs.existsSync(source)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${source}${suffix}`;
      if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
    }
  }

  // libSQL wants forward slashes in file: URLs, on Windows too.
  const url = `file:${target.split(path.sep).join("/")}`;
  return { dir, target, url };
}

export const scratchDb = provisionScratchDb();

// The side effect that beats the hoisted `import { prisma }`.
process.env.DATABASE_URL = scratchDb.url;

let cleaned = false;

/** Remove the scratch database directory. Safe to call more than once. */
export function cleanupScratchDb() {
  if (cleaned) return;
  cleaned = true;
  fs.rmSync(scratchDb.dir, { recursive: true, force: true });
}

// A harness that dies before its own teardown still must not leak a temp DB.
process.once("exit", () => {
  try {
    fs.rmSync(scratchDb.dir, { recursive: true, force: true });
  } catch {
    /* best effort on exit */
  }
});
