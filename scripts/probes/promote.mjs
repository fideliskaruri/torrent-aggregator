/*
 * Promote the artifact the gate validated into production, without rebuilding it.
 *
 * The gap this closes: `gate.mjs` builds and verifies `.next-gate`, but a normal
 * `next start` reads `.next`. So the thing that got tested and the thing that
 * serves the owner were different directories, and nothing in the plan said how
 * one became the other. Rebuilding into `.next` after a green gate would mean
 * the bytes serving users had never been verified - the build is not
 * deterministic enough to assume two runs agree, and a rebuild is exactly where
 * a "works on my machine" difference would hide.
 *
 * So this MOVES the validated directory rather than regenerating it. What runs
 * in production is byte-identical to what passed.
 *
 * It also keeps the previous build as a rollback, because the failure mode of a
 * promotion is discovering the new build will not boot AFTER deleting the only
 * copy of the one that did.
 *
 *   node scripts/probes/promote.mjs --check     inspect, change nothing
 *   node scripts/probes/promote.mjs             promote (server must be stopped)
 *   node scripts/probes/promote.mjs --rollback  put the previous build back
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = path.join(repoRoot, ".next");
const GATE = path.join(repoRoot, ".next-gate");
const ROLLBACK = path.join(repoRoot, ".next-rollback");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const ROLL = argv.includes("--rollback");

const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });

const describe = (p) => {
  if (!fs.existsSync(p)) return "absent";
  const st = fs.statSync(p);
  const buildId = path.join(p, "BUILD_ID");
  const id = fs.existsSync(buildId) ? fs.readFileSync(buildId, "utf8").trim() : "no BUILD_ID";
  return `${st.mtime.toISOString()}  BUILD_ID=${id}`;
};

console.log("\n=== BUILD PROMOTION ===\n");
console.log(`  .next          (live)      ${describe(LIVE)}`);
console.log(`  .next-gate     (validated) ${describe(GATE)}`);
console.log(`  .next-rollback (previous)  ${describe(ROLLBACK)}`);

const busy = await portBusy(3000);
console.log(`\n  :3000 ${busy ? "IS SERVING" : "is free"}`);

if (ROLL) {
  if (!fs.existsSync(ROLLBACK)) throw new Error("no .next-rollback to restore");
  if (busy) throw new Error("stop the server on :3000 before rolling back - it is holding the build it serves");
  if (fs.existsSync(LIVE)) fs.rmSync(LIVE, { recursive: true, force: true });
  fs.renameSync(ROLLBACK, LIVE);
  console.log("\nrolled back: .next-rollback -> .next. Restart the server.");
  process.exit(0);
}

if (CHECK) {
  console.log("\n--check: nothing changed.");
  process.exit(0);
}

/*
 * Refuse rather than guess. Every one of these is a case where continuing would
 * either serve unverified bytes or destroy the running server's own files.
 *
 * The live-server check comes FIRST deliberately: it is the most consequential
 * failure (moving a directory out from under a running server) and the one the
 * owner is most likely to hit, so it should be the message they actually see.
 */
if (busy) {
  throw new Error(
    "a server is live on :3000. Promoting would move the directory out from under it. " +
      "Stop it first, then re-run. (Deliberately not stopping it automatically - the owner may be watching something.)",
  );
}
if (!fs.existsSync(GATE)) {
  throw new Error(".next-gate does not exist - run the gate first. Refusing to promote nothing.");
}
if (!fs.existsSync(path.join(GATE, "BUILD_ID"))) {
  throw new Error(
    ".next-gate has no BUILD_ID - it is an incomplete build (a --skip-build gate run leaves this behind). " +
      "Refusing to promote a partial artifact.",
  );
}

if (fs.existsSync(ROLLBACK)) fs.rmSync(ROLLBACK, { recursive: true, force: true });
if (fs.existsSync(LIVE)) {
  fs.renameSync(LIVE, ROLLBACK);
  console.log("\n  kept the previous build as .next-rollback");
}
fs.renameSync(GATE, LIVE);
console.log(`  promoted the VALIDATED build: .next-gate -> .next  (BUILD_ID=${fs.readFileSync(path.join(LIVE, "BUILD_ID"), "utf8").trim()})`);
console.log("\nProduction now serves the exact bytes the gate verified - not a rebuild of them.");
console.log("Start with:  node node_modules/next/dist/bin/next start -p 3000");
console.log("Undo with :  node scripts/probes/promote.mjs --rollback");
