import assert from "node:assert/strict";
import type { DownloadHistory, GrabJob } from "@prisma/client";
import {
  activityWhere,
  loadActivityItems,
  reconcileActivityItems,
  type ActivityItem,
  type ActivityStore,
} from "./feed";

const HASHES = [
  "065075b8a32bc6c23b0142b4897f137d2f2acbb5",
  "245a962734421a5809cdb17e28da751fe85e5e26",
  "9b52ba4dfa504c09c6c2200c277887ecaa4e8f23",
];
let itemSequence = 0;

function item(
  type: "grab" | "history",
  overrides: Partial<ActivityItem> = {},
): ActivityItem {
  return {
    id: `${type}-${(itemSequence += 1)}`,
    type,
    title: "Family Guy S01E01",
    status: "sent",
    message: "Download started",
    source: "torrentscsv",
    kind: type === "grab" ? "ondemand" : null,
    query: type === "grab" ? "Family Guy S01E01" : null,
    magnet: `magnet:?xt=urn:btih:${HASHES[0]}`,
    infoHash: HASHES[0],
    savePath: type === "grab" ? "D:\\TV\\Family Guy\\Season 01" : null,
    category: type === "grab" ? "TV" : null,
    context: type === "history" ? "On-demand S01E01" : null,
    clientType: type === "history" ? "builtin" : null,
    sendKind: null,
    createdAt: "2026-07-30T14:50:32.958Z",
    ...overrides,
  };
}

for (const testCase of [
  {
    name: "successful TV send",
    title: "Family Guy S01E01",
    status: "sent",
    hash: HASHES[0],
  },
  {
    name: "failed release",
    title: "American Dad S01E02 PDTV XviD-LOL",
    status: "failed",
    hash: HASHES[1],
  },
  {
    name: "alternate title spelling is its own release",
    title: "American Dad s01e02",
    status: "failed",
    hash: HASHES[2],
  },
]) {
  const grab = item("grab", {
    id: `grab-${testCase.name}`,
    title: testCase.title,
    status: testCase.status,
    infoHash: testCase.hash,
    magnet: `magnet:?xt=urn:btih:${testCase.hash}`,
  });
  const history = item("history", {
    id: `hist-${testCase.name}`,
    title: testCase.title,
    status: testCase.status,
    infoHash: testCase.hash,
    magnet: `magnet:?xt=urn:btih:${testCase.hash}&tr=udp://tracker`,
    createdAt: "2026-07-30T14:50:32.962Z",
  });
  const reconciled = reconcileActivityItems([history, grab]);

  assert.equal(
    reconciled.length,
    1,
    `${testCase.name}: one logical event must render exactly once`,
  );
  assert.equal(reconciled[0].type, "grab");
  assert.equal(reconciled[0].context, "On-demand S01E01");
}

{
  const rows = HASHES.slice(1).flatMap((hash, index) => {
    const createdAt = `2026-07-30T14:5${index}:32.95${index}Z`;
    return [
      item("grab", {
        id: `grab-failure-${index}`,
        infoHash: hash,
        magnet: `magnet:?xt=urn:btih:${hash}`,
        status: "failed",
        createdAt,
      }),
      item("history", {
        id: `hist-failure-${index}`,
        infoHash: hash,
        magnet: `magnet:?xt=urn:btih:${hash}`,
        status: "failed",
        createdAt,
      }),
    ];
  });
  assert.equal(
    reconcileActivityItems(rows).length,
    2,
    "two real failed release attempts produce two rows, not four",
  );
}

{
  const firstGrab = item("grab", {
    id: "first-grab",
    createdAt: "2026-07-30T10:00:00.000Z",
  });
  const firstHistory = item("history", {
    id: "first-history",
    createdAt: "2026-07-30T10:00:00.004Z",
  });
  const laterGrab = item("grab", {
    id: "later-grab",
    createdAt: "2026-07-30T11:00:00.000Z",
  });
  const laterHistory = item("history", {
    id: "later-history",
    createdAt: "2026-07-30T11:00:00.004Z",
  });

  assert.equal(
    reconcileActivityItems([
      firstGrab,
      firstHistory,
      laterGrab,
      laterHistory,
    ]).length,
    2,
    "a later real re-send of the same torrent remains a separate event",
  );
}

{
  const historyOnly = item("history", {
    id: "manual-send",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  const result = reconcileActivityItems([historyOnly]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "manual-send");
}

function grabRow(
  id: string,
  status: string,
  retention: string | null,
  createdAt: Date,
): GrabJob {
  return {
    id,
    userId: "user-1",
    title: id,
    query: id,
    status,
    message: null,
    magnet: `magnet:?xt=urn:btih:${HASHES[0]}`,
    infoHash: HASHES[0],
    source: "test",
    savePath: null,
    category: null,
    kind: "library",
    externalId: null,
    retention,
    createdAt,
    updatedAt: createdAt,
  };
}

function historyRow(
  id: string,
  status: string,
  retention: string | null,
  createdAt: Date,
): DownloadHistory {
  return {
    id,
    userId: "user-1",
    title: id.replace("history", "grab"),
    magnet: `magnet:?xt=urn:btih:${HASHES[0]}`,
    torrentUrl: null,
    infoHash: HASHES[0],
    source: "test",
    status,
    message: null,
    context: "Library automation",
    category: null,
    savePath: null,
    clientType: "builtin",
    sendKind: null,
    retention,
    createdAt,
  };
}

function fakeStore(grabs: GrabJob[], history: DownloadHistory[]): ActivityStore {
  const findMany = <T extends GrabJob | DownloadHistory>(rows: T[]) =>
    async (args: {
      where: ReturnType<typeof activityWhere>;
      take: number;
    }): Promise<T[]> => {
      const filtered = rows
        .filter((row) => row.userId === args.where.userId)
        .filter((row) => !args.where.status || row.status === args.where.status)
        .filter((row) => row.retention === null || row.retention !== "stream")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return filtered.slice(0, args.take);
    };

  return {
    grabJob: { findMany: findMany(grabs) },
    downloadHistory: { findMany: findMany(history) },
  } as unknown as ActivityStore;
}

async function testSentFilter() {
  const oldSentAt = new Date("2026-07-28T00:00:00.000Z");
  const failures = Array.from({ length: 60 }, (_, index) =>
    grabRow(
      `failure-${index}`,
      "failed",
      null,
      new Date(oldSentAt.getTime() + (index + 1) * 60_000),
    ),
  );
  const sentGrab = grabRow("grab-legacy-sent", "sent", null, oldSentAt);
  const sentHistory = historyRow(
    "history-legacy-sent",
    "sent",
    null,
    new Date(oldSentAt.getTime() + 4),
  );
  const streamed = historyRow(
    "history-stream",
    "sent",
    "stream",
    new Date(oldSentAt.getTime() + 8),
  );

  const result = await loadActivityItems(
    fakeStore([...failures, sentGrab], [sentHistory, streamed]),
    "user-1",
    "sent",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].status, "sent");
  assert.equal(
    result[0].id,
    "grab-grab-legacy-sent",
    "status filtering must happen before the source limit",
  );
}

{
  const where = activityWhere("user-1", "sent");
  assert.equal(where.status, "sent");
  assert.deepEqual(where.OR, [
    { retention: null },
    { retention: { not: "stream" } },
  ]);
}

testSentFilter().then(
  () => console.log("PASS activity feed"),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
