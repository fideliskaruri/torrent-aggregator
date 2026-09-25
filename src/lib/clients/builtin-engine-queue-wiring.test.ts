/**
 * The queue is only worth having if the engine is actually wired to it.
 *
 * `download-queue.test.ts` proves the rules — ordering, the cap, who gets
 * promoted. It cannot prove that `builtin-engine.ts` calls them, and every way
 * this feature can silently die is a missing call site rather than a wrong
 * rule: a kept add that skips the gate goes straight into WebTorrent and the
 * cap means nothing; a completion that forgets to promote leaves the rest of
 * the season queued forever.
 *
 * Driving the real engine here would mean a client, a swarm and a database, so
 * this pins the wiring against the source instead — the same technique
 * `src/app/api/title/[workKey]/route-source.test.ts` uses, and the same one
 * `timer-singletons.test.ts` uses for the client options.
 *
 * Run: npx tsx src/lib/clients/builtin-engine-queue-wiring.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const engine = fs.readFileSync("src/lib/clients/builtin-engine.ts", "utf8");
const lifecycle = fs.readFileSync(
  "src/lib/clients/builtin-engine-lifecycle.ts",
  "utf8",
);

function countOf(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

// A queued download must not exist inside WebTorrent at all. Pausing does not
// drop wires, peers or the piece cache (verified against WebTorrent 3.0.16), so
// "add it then pause it" would keep the RAM this whole change exists to save.
assert.match(
  engine,
  /persistQueuedDownload\(/,
  "the add path must be able to park a download as a row rather than a torrent",
);
assert.ok(
  countOf(engine, "void promoteQueuedDownloads(") >= 5,
  "every way an active slot frees — complete, pause, delete, remove, failure —" +
    " must try to promote the next queued download",
);
assert.match(
  engine,
  /export async function promoteQueuedDownloads\(/,
  "promotion is exported so the queue can be advanced from outside the adapter",
);
assert.match(
  engine,
  /await applyStartupQueuePlan\(userId\)/,
  "rehydrate must re-apply the cap before re-adding anything, or a restart" +
    " puts every unfinished download back into the swarm at once",
);
assert.match(
  engine,
  /async forceTorrent\(/,
  "Download now must exist on the adapter, not just in the queue module",
);

// The per-add store cache is the other half of the RAM saving, and it can only
// be set at torrent construction — see the comment on KEPT_STORE_CACHE_SLOTS.
assert.match(engine, /export const KEPT_STORE_CACHE_SLOTS = \d+;/);
const slots = Number(
  /export const KEPT_STORE_CACHE_SLOTS = (\d+);/.exec(engine)?.[1],
);
assert.ok(
  slots >= 2 && slots <= 8,
  `kept downloads need a small piece cache, got ${slots}: fewer than 2 slots` +
    " starves sequential writes, more than 8 gives back the RAM saving",
);
assert.ok(
  countOf(engine, "storeCacheSlots: KEPT_STORE_CACHE_SLOTS") >= 2,
  "both the fresh add and the rehydrated add must use the smaller cache," +
    " otherwise a restart silently restores the old memory cost",
);

// Streaming must never be queued or shrunk: the viewer is waiting.
assert.doesNotMatch(
  engine,
  /purpose === "stream"[^\n]*persistQueuedDownload/,
  "playback and prewarm are never queued",
);

// A queued row is a row the engine deliberately keeps out of WebTorrent, so
// rehydrate must agree with the queue about what that status means.
assert.match(
  lifecycle,
  /QUEUED_STATUS|"queued"/,
  "rehydrate has to recognise the queued status or it will re-add queued rows",
);

console.log("PASS builtin engine is wired to the download queue");
