/**
 * Focused safety check for test-all's database routing.
 *
 * Run with: node scripts/check-test-all-private-db.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupPrivateDb, preparePrivateDb } from "./lib/private-db.mjs";
import { PRIVATE_DB_RUNS } from "./lib/test-all-private-runs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expected = [
  "settings-upsert",
  "ondemand-estimate",
  "ondemand-advance",
  "builtin-send",
  "availability-seam",
  "browse-rails",
];

function main() {
  const names = PRIVATE_DB_RUNS.map((r) => r.name);
  assert.deepEqual(names, expected, "the private-db run list changed");

  const testAllSource = fs.readFileSync(path.join(root, "scripts", "test-all.mjs"), "utf8");
  assert.ok(
    testAllSource.includes("PRIVATE_DB_RUNS") && testAllSource.includes("env: privateDbEnv"),
    "test-all should route the private run list through the private DATABASE_URL",
  );

  const privateDb = preparePrivateDb("validation");
  try {
    assert.match(privateDb.url, /^file:/);
    assert.ok(
      privateDb.dir.startsWith(path.join(root, ".next-scratch", "private-db")),
      `private db must stay inside repo scratch, got ${privateDb.dir}`,
    );
    assert.notEqual(
      privateDb.url,
      process.env.DATABASE_URL ?? "",
      "the private database must not reuse the live DATABASE_URL",
    );
    assert.ok(fs.existsSync(privateDb.dir), "private database directory should exist");
    assert.ok(
      fs.existsSync(privateDb.target) || fs.existsSync(`${privateDb.target}-wal`),
      "private database target should be created or copied from dev.db",
    );
    console.log(`PASS private db isolation (${privateDb.url})`);
    console.log(`PASS backend-only routing (${names.join(", ")})`);
  } finally {
    cleanupPrivateDb(privateDb);
  }
}

main();
