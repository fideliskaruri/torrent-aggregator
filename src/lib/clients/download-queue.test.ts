import assert from "node:assert/strict";

import {
  activeKeptCount,
  maxActiveDownloads,
  orderQueue,
  planRehydrate,
  promotionCandidates,
  queueKeyForEpisode,
  queuePositions,
  queuedReservedBytes,
  shouldQueueNewDownload,
  type QueueRow,
} from "./download-queue";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

const base = new Date("2026-01-01T00:00:00.000Z").getTime();
function at(offsetMs: number): Date {
  return new Date(base + offsetMs);
}

function row(partial: Partial<QueueRow> & { hash: string }): QueueRow {
  return {
    status: "queued",
    origin: "user",
    workId: null,
    queueKey: null,
    createdAt: at(0),
    forcedAt: null,
    sizeBytes: 0,
    ...partial,
  };
}

check("episode queue keys sort numerically, not lexically", () => {
  const keys = [
    queueKeyForEpisode(1, 9),
    queueKeyForEpisode(1, 10),
    queueKeyForEpisode(2, 1),
  ] as string[];
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(queueKeyForEpisode(null, 3), null);
});

check("within a series the queue is chronological by season/episode", () => {
  const rows = [
    row({ hash: "e3", workId: "show", queueKey: queueKeyForEpisode(1, 3), createdAt: at(10) }),
    row({ hash: "e10", workId: "show", queueKey: queueKeyForEpisode(1, 10), createdAt: at(0) }),
    row({ hash: "e1", workId: "show", queueKey: queueKeyForEpisode(1, 1), createdAt: at(50) }),
    row({ hash: "s2e1", workId: "show", queueKey: queueKeyForEpisode(2, 1), createdAt: at(5) }),
  ];
  assert.deepEqual(
    orderQueue(rows).map((r) => r.hash),
    ["e1", "e3", "e10", "s2e1"],
    "search completion order must not decide download order",
  );
});

check("across works the queue is FIFO by the work's first enqueue", () => {
  const rows = [
    row({ hash: "b1", workId: "later", queueKey: queueKeyForEpisode(1, 1), createdAt: at(900) }),
    row({ hash: "a2", workId: "early", queueKey: queueKeyForEpisode(1, 2), createdAt: at(700) }),
    row({ hash: "a1", workId: "early", queueKey: queueKeyForEpisode(1, 1), createdAt: at(100) }),
    row({ hash: "film", workId: null, createdAt: at(1200) }),
  ];
  assert.deepEqual(
    orderQueue(rows).map((r) => r.hash),
    ["a1", "a2", "b1", "film"],
    "a show queued first finishes before one queued later",
  );
  assert.deepEqual(
    [...queuePositions(rows).entries()].sort((x, y) => x[1] - y[1]).map(([h]) => h),
    ["a1", "a2", "b1", "film"],
  );
});

check("only kept downloading rows count against the cap", () => {
  const rows = [
    row({ hash: "kept", status: "downloading" }),
    row({ hash: "stream", status: "downloading", origin: "stream" }),
    row({ hash: "prewarm", status: "downloading", origin: "prewarm" }),
    row({ hash: "paused", status: "paused" }),
    row({ hash: "waiting" }),
  ];
  assert.equal(activeKeptCount(rows), 1);
});

check("the cap blocks a new kept add but never a stream or a force", () => {
  const rows = [
    row({ hash: "a", status: "downloading" }),
    row({ hash: "b", status: "downloading" }),
  ];
  assert.equal(shouldQueueNewDownload({ rows, cap: 2, origin: "user" }), true);
  assert.equal(shouldQueueNewDownload({ rows, cap: 3, origin: "user" }), false);
  assert.equal(shouldQueueNewDownload({ rows, cap: 2, origin: "stream" }), false);
  assert.equal(shouldQueueNewDownload({ rows, cap: 2, origin: "prewarm" }), false);
  assert.equal(
    shouldQueueNewDownload({ rows, cap: 2, origin: "user", forced: true }),
    false,
    "a forced download starts immediately regardless of the cap",
  );
});

check("promotion refills exactly the freed slots, in queue order", () => {
  const rows = [
    row({ hash: "a", status: "downloading" }),
    row({ hash: "b", status: "downloading" }),
    row({ hash: "q1", workId: "show", queueKey: queueKeyForEpisode(1, 1), createdAt: at(10) }),
    row({ hash: "q2", workId: "show", queueKey: queueKeyForEpisode(1, 2), createdAt: at(20) }),
  ];
  assert.deepEqual(promotionCandidates(rows, 2), [], "full means nothing starts");

  const afterComplete = rows.map((r) =>
    r.hash === "a" ? { ...r, status: "downloaded" } : r,
  );
  assert.deepEqual(promotionCandidates(afterComplete, 2), ["q1"]);

  const afterPause = afterComplete.map((r) =>
    r.hash === "b" ? { ...r, status: "paused" } : r,
  );
  assert.deepEqual(promotionCandidates(afterPause, 2), ["q1", "q2"]);

  const afterDelete = afterPause.filter((r) => r.hash !== "b");
  assert.deepEqual(promotionCandidates(afterDelete, 2), ["q1", "q2"]);

  const afterFail = rows.map((r) =>
    r.hash === "a" ? { ...r, status: "error" } : r,
  );
  assert.deepEqual(promotionCandidates(afterFail, 2), ["q1"]);
});

check("rehydrate respects the cap and always starts forced rows", () => {
  const rows = [
    row({ hash: "d1", status: "downloading", workId: "show", queueKey: queueKeyForEpisode(1, 1), createdAt: at(10) }),
    row({ hash: "d2", status: "downloading", workId: "show", queueKey: queueKeyForEpisode(1, 2), createdAt: at(20) }),
    row({ hash: "d3", status: "downloading", workId: "show", queueKey: queueKeyForEpisode(1, 3), createdAt: at(30) }),
    row({ hash: "f", status: "queued", workId: "show", queueKey: queueKeyForEpisode(1, 9), createdAt: at(90), forcedAt: at(95) }),
    row({ hash: "s", status: "downloading", origin: "stream" }),
  ];
  const plan = planRehydrate(rows, 2);
  assert.deepEqual(plan.active, ["f", "d1"], "forced first, then the queue head");
  assert.deepEqual(plan.demote.sort(), ["d2", "d3"]);
  assert.equal(
    plan.active.includes("s"),
    false,
    "stream rows are not part of the kept queue plan",
  );
});

check("queued sizes are reserved so parallel episodes cannot double-spend disk", () => {
  const rows = [
    row({ hash: "a", status: "downloading", sizeBytes: 1_000 }),
    row({ hash: "q1", sizeBytes: 2_000 }),
    row({ hash: "q2", sizeBytes: BigInt(3_000) }),
    row({ hash: "q3", sizeBytes: null }),
  ];
  assert.equal(queuedReservedBytes(rows), 5_000);
});

check("the cap is overridable by env and never below 1", () => {
  assert.equal(maxActiveDownloads({}), 2);
  assert.equal(maxActiveDownloads({ TORRENTFLOW_MAX_ACTIVE_DOWNLOADS: "5" }), 5);
  assert.equal(maxActiveDownloads({ TORRENTFLOW_MAX_ACTIVE_DOWNLOADS: "0" }), 1);
  assert.equal(maxActiveDownloads({ TORRENTFLOW_MAX_ACTIVE_DOWNLOADS: "x" }), 2);
});

if (failures > 0) process.exitCode = 1;
