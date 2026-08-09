import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./builtin-engine.ts", import.meta.url),
  "utf8",
);
const listStart = source.indexOf("  async listTorrents(");
const listEnd = source.indexOf("  async pauseTorrent(", listStart);
assert.ok(listStart >= 0 && listEnd > listStart, "listTorrents source block exists");
const listSource = source.slice(listStart, listEnd);

assert.doesNotMatch(
  source,
  /await persistAndParkCompletedTorrent/,
  "completed add requests cannot wait for active stream leases to drain",
);
assert.match(
  source,
  /startup rehydrate failed[\s\S]*?setTimeout\([\s\S]*?startBuiltinEngineRuntime[\s\S]*?BUILTIN_RUNTIME_RETRY_MS/,
  "a transient startup persistence failure must retry without another navigation",
);
assert.doesNotMatch(
  listSource,
  /ensureClientAndRehydrate|rehydrateFromDb|scheduleProgressPersist|persistedVerifiedState/,
  "listing cannot activate or persist the torrent engine",
);
assert.match(
  listSource,
  /const client = s\.client;/,
  "listing may only inspect an already-live client",
);
assert.match(
  listSource,
  /if \(client\) startUploadThrottleLoop\(client\)/,
  "listing re-arms maintenance for an already-live client after hot reload",
);
assert.match(
  source,
  /UPLOAD_THROTTLE_LOOP_VERSION[\s\S]*?uploadThrottleVersion === UPLOAD_THROTTLE_LOOP_VERSION[\s\S]*?clearInterval\(s\.uploadThrottleTimer\)/,
  "a stale hot-reloaded maintenance interval is replaced rather than trusted",
);
assert.match(
  source,
  /function resetEngineBookkeeping[\s\S]*?parkingRetryTimers\.clear\(\)[\s\S]*?meta\.clear\(\)[\s\S]*?clearCompletionSweepOwnerState\(\)[\s\S]*?rehydrated\.clear\(\)[\s\S]*?rehydrating\.clear\(\)/,
  "engine-generation teardown clears retry, owner, and rehydrate bookkeeping together",
);
assert.match(
  source,
  /function scheduleIdleClientDestroy[\s\S]*?s\.client = null[\s\S]*?resetEngineBookkeeping\(s\)[\s\S]*?client\.destroy/,
  "idle client destruction uses the same bookkeeping reset as explicit shutdown",
);
assert.match(
  source,
  /backfillSweepOwnerFromDatabase[\s\S]*?const expectedClient = state\(\)\.client[\s\S]*?await prisma\.engineTorrent\.findFirst[\s\S]*?if \(state\(\)\.client !== expectedClient\) return false[\s\S]*?s\.meta\.set/,
  "an owner lookup cannot write meta after its engine generation was destroyed",
);
assert.match(
  source,
  /STREAM_LEASE_RELEASE_WAIT_MS[\s\S]*?function waitForBuiltinStreamLeases[\s\S]*?currentWaiters\?\.delete\(onReleased\)[\s\S]*?setTimeout\([\s\S]*?stream lease did not release/,
  "parking bounds its lease wait and removes timed-out waiters so retries can proceed",
);

for (const route of [
  "../../app/api/stream/[infoHash]/route.ts",
  "../../app/api/stream/[infoHash]/[...filePath]/route.ts",
  "../../app/api/subtitles/[infoHash]/route.ts",
]) {
  const routeSource = readFileSync(new URL(route, import.meta.url), "utf8");
  assert.doesNotMatch(
    routeSource,
    /\bfindBuiltinTorrentFile\b/,
    `${route} cannot activate or rehydrate WebTorrent from a GET`,
  );
  assert.match(
    routeSource,
    /\bfindLiveBuiltinTorrentFile\b/,
    `${route} may inspect only an already-live torrent`,
  );
}
