import assert from "node:assert/strict";
import type { DownloadHistory, GrabJob } from "@prisma/client";
import {
  ACTIVITY_CURSOR_MAX_LENGTH,
  ACTIVITY_LIMIT,
  ACTIVITY_MAX_LIMIT,
  activityWhere,
  encodeActivityCursor,
  loadActivityItems,
  loadActivityPage,
  loadActivitySince,
  normalizeActivityLimit,
  parseActivityCursor,
  reconcileActivityItems,
  type ActivityItem,
  type ActivityPage,
  type ActivityStore,
} from "./feed";
import {
  INBOX_STATUSES,
  UNREAD_COUNT_CAP,
  badgeText,
  buildInbox,
  unreadCountUrl,
} from "@/app/notifications/inbox";
import {
  activityPageUrl,
  mergeActivityPages,
  olderActivityAction,
} from "@/app/notifications/presentation";

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
    workId: null,
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

type FakeCondition = {
  createdAt?: Date | { lt?: Date; gt?: Date };
  id?: { gt?: string };
};

type FakeWhere = {
  userId: string;
  status?: string | { in: string[] };
  createdAt?: { lt?: Date; gt?: Date };
  AND?: { OR: FakeCondition[] }[];
};

/**
 * Evaluate one leaf of the cursor clause the feed pushes into the query.
 *
 * The fake store has to honour it (and the composite `orderBy`) or the tests
 * would prove something the database never does.
 */
function matchesCondition(
  row: { createdAt: Date; id: string },
  condition: FakeCondition,
): boolean {
  const { createdAt, id } = condition;
  if (createdAt instanceof Date) {
    if (row.createdAt.getTime() !== createdAt.getTime()) return false;
  } else if (createdAt) {
    if (createdAt.lt && row.createdAt.getTime() >= createdAt.lt.getTime()) {
      return false;
    }
    if (createdAt.gt && row.createdAt.getTime() <= createdAt.gt.getTime()) {
      return false;
    }
  }
  if (id?.gt !== undefined && !(row.id > id.gt)) return false;
  return true;
}

function fakeStore(grabs: GrabJob[], history: DownloadHistory[]): ActivityStore {
  const findMany = <T extends GrabJob | DownloadHistory>(rows: T[]) =>
    async (args: {
      where: FakeWhere;
      take: number;
      orderBy?: { createdAt?: "asc" | "desc"; id?: "asc" | "desc" }[];
    }): Promise<T[]> => {
      const status = args.where.status;
      const createdAt = args.where.createdAt;
      const groups = args.where.AND ?? [];
      const timeDir = args.orderBy?.[0]?.createdAt === "asc" ? 1 : -1;
      const idDir = args.orderBy?.[1]?.id === "desc" ? -1 : 1;
      const filtered = rows
        .filter((row) => row.userId === args.where.userId)
        .filter((row) =>
          !status
            ? true
            : typeof status === "string"
              ? row.status === status
              : status.in.includes(row.status),
        )
        .filter((row) =>
          !createdAt?.lt
            ? true
            : row.createdAt.getTime() < createdAt.lt.getTime(),
        )
        .filter((row) =>
          !createdAt?.gt
            ? true
            : row.createdAt.getTime() > createdAt.gt.getTime(),
        )
        .filter((row) =>
          groups.every((group) =>
            group.OR.some((condition) => matchesCondition(row, condition)),
          ),
        )
        .filter((row) => row.retention === null || row.retention !== "stream")
        .sort(
          (a, b) =>
            timeDir * (a.createdAt.getTime() - b.createdAt.getTime()) ||
            idDir * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
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

/**
 * Paging past the first page.
 *
 * The defect this guards: the feed read a fixed 50 rows and the API had no way
 * to ask for anything older, so "Show older activity" could only re-reveal rows
 * already downloaded. Row 51 was unreachable from the UI.
 */
async function testPaginationReachesOlderRows() {
  const base = new Date("2026-07-01T00:00:00.000Z").getTime();
  // 120 rows, newest first when sorted: minute N is older for smaller N.
  const grabs = Array.from({ length: 120 }, (_, index) =>
    grabRow(`page-${String(index).padStart(3, "0")}`, "failed", null, new Date(base + index * 60_000)),
  );
  const store = fakeStore(grabs, []);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page: ActivityPage = await loadActivityPage(store, "user-1", "all", {
      limit: 50,
      cursor,
    });
    assert.ok(page.items.length <= 50, "a page must never exceed the limit");
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 10, "pagination must terminate");
  } while (cursor);

  assert.equal(seen.length, 120, "every stored row is reachable by paging");
  assert.equal(new Set(seen).size, 120, "no row is served twice across pages");
  assert.equal(seen[0], "grab-page-119", "the newest row is first");
  assert.equal(seen[seen.length - 1], "grab-page-000", "the oldest row is last");
  const times = seen.map((id) => id.replace("grab-page-", ""));
  assert.deepEqual(
    [...times].sort().reverse(),
    times,
    "newest-first order survives the page boundary",
  );
}

/** A limit larger than the ceiling is clamped, not honoured. */
function testLimitIsBounded() {
  assert.equal(normalizeActivityLimit("10"), 10);
  assert.equal(normalizeActivityLimit("100000"), ACTIVITY_MAX_LIMIT);
  assert.equal(normalizeActivityLimit("0"), ACTIVITY_LIMIT);
  assert.equal(normalizeActivityLimit("not-a-number"), ACTIVITY_LIMIT);
  assert.equal(normalizeActivityLimit(null), ACTIVITY_LIMIT);
  assert.equal(parseActivityCursor("nonsense"), null);
  assert.equal(parseActivityCursor(null), null);
}

/**
 * The cursor is an opaque, URL-safe, validated token.
 *
 * The defect it fixes: a cursor of `createdAt` alone cannot name a position in
 * an order whose tiebreak is the id, so the boundary was ambiguous whenever
 * two rows shared a millisecond.
 */
function testCursorEncoding() {
  const cursor = encodeActivityCursor({
    createdAt: "2026-07-05T01:00:00.000Z",
    id: "grab-abc",
  });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/, "the cursor is URL-safe as issued");
  assert.equal(
    encodeURIComponent(cursor),
    cursor,
    "and therefore survives a query string unescaped",
  );

  const parsed = parseActivityCursor(cursor);
  assert.equal(parsed?.id, "grab-abc");
  assert.equal(parsed?.time.toISOString(), "2026-07-05T01:00:00.000Z");

  assert.equal(
    parseActivityCursor("2026-07-05T01:00:00.000Z")?.id,
    null,
    "a legacy timestamp-only cursor still pages instead of failing",
  );
  assert.equal(
    parseActivityCursor("2026-07-05T01:00:00.000Z")?.time.toISOString(),
    "2026-07-05T01:00:00.000Z",
  );

  assert.equal(
    parseActivityCursor(
      Buffer.from("2026-07-05T01:00:00.000Z|nope-1", "utf8").toString(
        "base64url",
      ),
    ),
    null,
    "an id that is not a grab/history item id is rejected",
  );
  assert.equal(
    parseActivityCursor(
      Buffer.from("not-a-date|grab-abc", "utf8").toString("base64url"),
    ),
    null,
    "an unparseable timestamp is rejected",
  );
  assert.equal(
    parseActivityCursor(
      Buffer.from("2026-07-05T01:00:00.000Z", "utf8").toString("base64url"),
    ),
    null,
    "a payload with no id separator is rejected",
  );
  assert.equal(
    parseActivityCursor("a".repeat(ACTIVITY_CURSOR_MAX_LENGTH + 1)),
    null,
    "an oversized cursor is rejected before it is decoded",
  );
  assert.equal(parseActivityCursor("   "), null);
}

/**
 * Adversarial: more rows sharing one millisecond than fit on a page.
 *
 * The defect this guards: the cursor was `createdAt` only and the read was
 * `createdAt`-ordered and `take`-bounded, so page two asked for "rows before
 * 12:00:00.000" — which is every row already shown — and the feed either
 * repeated them or terminated with rows still unread.
 */
async function testSameMillisecondRunPagesCleanly() {
  const stamp = new Date("2026-07-06T12:00:00.000Z");
  const rowCount = 25;
  const limit = 5;
  const grabs = Array.from({ length: rowCount }, (_, index) =>
    grabRow(`same-${String(index).padStart(3, "0")}`, "failed", null, stamp),
  );
  const store = fakeStore(grabs, []);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page: ActivityPage = await loadActivityPage(store, "user-1", "all", {
      limit,
      cursor,
    });
    assert.ok(page.items.length <= limit, "a page never exceeds the limit");
    assert.ok(
      page.items.length > 0,
      "a page inside the run is never empty while rows remain",
    );
    seen.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= rowCount, "pagination must terminate");
  } while (cursor);

  assert.equal(
    seen.length,
    rowCount,
    "every same-millisecond row is served exactly once, none skipped",
  );
  assert.equal(new Set(seen).size, rowCount, "and none is served twice");
  assert.deepEqual(
    seen,
    [...seen].sort(),
    "the run is walked in the id order the total sort defines",
  );
}

/**
 * The same run, split across both tables, where the boundary can fall between
 * a grab row and a history row written in the very same millisecond.
 */
async function testSameMillisecondRunAcrossBothTables() {
  const stamp = new Date("2026-07-06T13:00:00.000Z");
  const limit = 4;
  const grabs = Array.from({ length: 15 }, (_, index) =>
    grabRow(`tie-${String(index).padStart(2, "0")}`, "failed", null, stamp),
  );
  // Distinct info hashes per row would be closer to production, but identical
  // ones are the harder case: only the status mismatch keeps reconciliation
  // from merging them, which is what makes the boundary crowded.
  const histories = Array.from({ length: 15 }, (_, index) =>
    historyRow(`tie-${String(index).padStart(2, "0")}`, "sent", null, stamp),
  );
  const store = fakeStore(grabs, histories);

  const seen: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page <= 30; page++) {
    const result: ActivityPage = await loadActivityPage(store, "user-1", "all", {
      limit,
      cursor,
    });
    seen.push(...result.items.map((row) => row.id));
    cursor = result.nextCursor;
    if (!cursor) break;
    assert.ok(page < 30, "pagination must terminate");
  }

  assert.equal(new Set(seen).size, seen.length, "no row is repeated");
  assert.equal(
    seen.length,
    30,
    "both tables' same-millisecond rows are fully reachable",
  );
  assert.ok(
    seen.slice(0, 15).every((id) => id.startsWith("grab-")),
    "the id tiebreak orders grab rows before history rows, on every page",
  );
}

/** A 40-hex info hash unique to `seed`, so unrelated rows never look like twins. */
function syntheticHash(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}

function grabRowWithHash(
  id: string,
  createdAt: Date,
  seed: number,
  status = "failed",
): GrabJob {
  const hash = syntheticHash(seed);
  return {
    ...grabRow(id, status, null, createdAt),
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}`,
  };
}

function historyRowWithHash(
  id: string,
  createdAt: Date,
  seed: number,
  status = "failed",
): DownloadHistory {
  const hash = syntheticHash(seed);
  return {
    ...historyRow(id, status, null, createdAt),
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}`,
  };
}

type WalkResult = { seen: string[]; pages: number };

/** Walk every page the feed offers, following its own cursor, and record what it served. */
async function walkAllPages(
  store: ActivityStore,
  limit: number,
  maxPages: number,
): Promise<WalkResult> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const page: ActivityPage = await loadActivityPage(store, "user-1", "all", {
      limit,
      cursor,
    });
    assert.ok(page.items.length <= limit, "a page never exceeds the limit");
    if (page.hasMore) {
      assert.ok(page.items.length > 0, "a page claiming more is never empty");
      assert.ok(page.nextCursor, "a page claiming more always issues a cursor");
    }
    seen.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= maxPages, "pagination must terminate");
  } while (cursor);

  return { seen, pages };
}

/**
 * A burst far larger than one page, entirely inside the pairing window.
 *
 * The defect this guards: the overlap rows used to share the page query's
 * `take`, so once a single second held more rows than the budget, page two was
 * filled entirely with rows already served, came back empty, and reported
 * `hasMore: false` — stranding every older row in the table behind it.
 */
async function testDenseOneSecondBurstIsFullyReachable() {
  for (const rowCount of [70, 100, 300]) {
    const start = new Date("2026-07-08T09:00:00.000Z").getTime();
    const grabs = Array.from({ length: rowCount }, (_, index) =>
      grabRowWithHash(
        `burst-${String(index).padStart(4, "0")}`,
        // Spread across a single second: every row is inside the pairing
        // window of every other row.
        new Date(start + (index % 1000)),
        index + 1,
      ),
    );
    // One much older row: it is only reachable if paging actually advances
    // through the burst instead of stalling inside it.
    grabs.push(grabRowWithHash("zz-oldest", new Date(start - 60_000), 999_001));
    const store = fakeStore(grabs, []);

    const { seen } = await walkAllPages(store, 20, rowCount + 10);

    assert.equal(
      seen.length,
      rowCount + 1,
      `every one of ${rowCount} same-second rows is served, plus the older row`,
    );
    assert.equal(new Set(seen).size, seen.length, "and none is served twice");
    assert.equal(
      seen[seen.length - 1],
      "grab-zz-oldest",
      "the row behind the burst is not stranded",
    );
  }
}

/**
 * The same density, split across both tables, with real grab/history twins
 * inside it: reachability must not be bought by breaking pairing.
 */
async function testDenseMixedBurstKeepsPairingAndOrder() {
  const start = new Date("2026-07-08T10:00:00.000Z").getTime();
  const pairCount = 60;
  const grabs: GrabJob[] = [];
  const histories: DownloadHistory[] = [];

  for (let index = 0; index < pairCount; index++) {
    const id = `pair-${String(index).padStart(3, "0")}`;
    // Twins written milliseconds apart, exactly as the pipeline writes them,
    // so a page boundary can land between the two halves of one event.
    grabs.push(grabRowWithHash(id, new Date(start + index * 8), index + 1));
    histories.push(
      historyRowWithHash(id, new Date(start + index * 8 + 3), index + 1),
    );
  }
  const store = fakeStore(grabs, histories);

  const { seen } = await walkAllPages(store, 7, pairCount + 20);

  assert.equal(new Set(seen).size, seen.length, "no event is served twice");
  assert.equal(
    seen.length,
    pairCount,
    "each grab/history twin is reconciled into exactly one item",
  );
  assert.ok(
    seen.every((id) => id.startsWith("grab-")),
    "reconciliation keeps the grab identity, across page boundaries too",
  );
  const expected = [...seen].sort().reverse();
  assert.deepEqual(
    seen,
    expected,
    "newest first is preserved across every page boundary",
  );
}

/**
 * A twin that lands strictly above the page boundary, with an unrelated row
 * between it and its partner.
 *
 * This is the case the separate overlap read exists for: the boundary falls
 * between the history half and the grab half of one event, so without reading
 * the pairing window above the boundary the grab half would be served a second
 * time as its own, unreconciled item.
 */
async function testPairStraddlingBoundaryIsNotServedTwice() {
  const base = new Date("2026-07-08T12:00:00.000Z").getTime();
  const grabs = [
    grabRowWithHash("pairA", new Date(base), 1),
    grabRowWithHash("between", new Date(base + 3), 2),
    grabRowWithHash("older-1", new Date(base - 10_000), 3),
    grabRowWithHash("older-2", new Date(base - 20_000), 4),
  ];
  const histories = [historyRowWithHash("pairA", new Date(base + 5), 1)];
  const store = fakeStore(grabs, histories);

  const { seen } = await walkAllPages(store, 2, 10);

  assert.deepEqual(
    seen,
    ["grab-pairA", "grab-between", "grab-older-1", "grab-older-2"],
    "the straddling pair stays one item and the older rows still follow",
  );
  assert.equal(new Set(seen).size, seen.length, "nothing is repeated");
}

/** Unpaired rows in a dense burst are all reachable, in both tables. */
async function testDenseUnpairedMixedBurstIsFullyReachable() {
  const stamp = new Date("2026-07-08T11:00:00.000Z");
  const grabs = Array.from({ length: 80 }, (_, index) =>
    grabRowWithHash(`g-${String(index).padStart(3, "0")}`, stamp, index + 1),
  );
  const histories = Array.from({ length: 80 }, (_, index) =>
    historyRowWithHash(
      `h-${String(index).padStart(3, "0")}`,
      stamp,
      500 + index,
      "sent",
    ),
  );
  const store = fakeStore(grabs, histories);

  const { seen } = await walkAllPages(store, 9, 200);

  assert.equal(seen.length, 160, "every row in both tables is reachable");
  assert.equal(new Set(seen).size, 160, "and each exactly once");
  assert.equal(
    seen.filter((id) => id.startsWith("hist-")).length,
    80,
    "the history half is not stranded behind the grab half",
  );
}
async function testInvalidCursorServesNewestPage() {
  const base = new Date("2026-07-07T00:00:00.000Z").getTime();
  const grabs = Array.from({ length: 4 }, (_, index) =>
    grabRow(`bogus-${index}`, "failed", null, new Date(base + index * 1000)),
  );
  const store = fakeStore(grabs, []);

  const page = await loadActivityPage(store, "user-1", "all", {
    limit: 2,
    cursor: "!!!not-a-cursor!!!",
  });
  assert.equal(page.items[0].id, "grab-bogus-3", "the newest row is served");
  assert.equal(page.items.length, 2);
}

/**
 * A grab/history pair written either side of a page boundary must still
 * reconcile into one row — the reason pages overlap by the pairing window.
 */
async function testPagingPreservesDedupe() {
  const base = new Date("2026-07-02T00:00:00.000Z").getTime();
  const grabs = Array.from({ length: 6 }, (_, index) =>
    grabRow(`pair-${index}`, "sent", null, new Date(base + index * 60_000)),
  );
  const histories = grabs.map((grab, index) =>
    historyRow(
      `history-pair-${index}`,
      "sent",
      null,
      new Date(grab.createdAt.getTime() + 4),
    ),
  );
  const store = fakeStore(grabs, histories);

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const result: ActivityPage = await loadActivityPage(store, "user-1", "all", {
      limit: 2,
      cursor,
    });
    seen.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  assert.equal(
    seen.length,
    6,
    "six events paged two at a time stay six — no page boundary duplicates them",
  );
  assert.equal(new Set(seen).size, 6, "ids are unique across pages");
}

/**
 * The unread count is a query, not the length of a page.
 *
 * The defect: the badge counted `/api/activity`'s first response, so it could
 * never exceed the feed's page size however much was unread.
 */
async function testUnreadCountIsNotCappedByFeedPage() {
  const base = new Date("2026-07-03T00:00:00.000Z").getTime();
  const grabs = Array.from({ length: 80 }, (_, index) =>
    grabRow(`unread-${index}`, "sent", null, new Date(base + index * 60_000)),
  );
  // Noise the inbox must not count: a status it does not recognise, and a
  // stream row, which is playback cache rather than a download.
  grabs.push(grabRow("unread-searching", "searching", null, new Date(base + 999_000)));
  const streamed = historyRow(
    "history-stream-unread",
    "sent",
    "stream",
    new Date(base + 999_000),
  );

  const { items, capped } = await loadActivitySince(
    fakeStore(grabs, [streamed]),
    "user-1",
    null,
    INBOX_STATUSES,
    UNREAD_COUNT_CAP,
  );
  const notifications = buildInbox(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      message: item.message,
      createdAt: item.createdAt,
      infoHash: item.infoHash,
    })),
  );

  assert.equal(
    notifications.length,
    80,
    "the count exceeds one feed page instead of stopping at it",
  );
  assert.equal(capped, false, "80 unread is under the cap, so nothing is truncated");

  const since = new Date(base + 60 * 60_000);
  const recent = await loadActivitySince(
    fakeStore(grabs, []),
    "user-1",
    since,
    INBOX_STATUSES,
    UNREAD_COUNT_CAP,
  );
  assert.equal(
    recent.items.length,
    19,
    "the read mark excludes everything at or before it",
  );
}

/** The read count never reads unbounded rows, however much is unread. */
async function testUnreadCountStaysBounded() {
  const base = new Date("2026-07-04T00:00:00.000Z").getTime();
  const grabs = Array.from({ length: 500 }, (_, index) =>
    grabRow(`flood-${index}`, "sent", null, new Date(base + index * 60_000)),
  );
  const { items, capped } = await loadActivitySince(
    fakeStore(grabs, []),
    "user-1",
    null,
    INBOX_STATUSES,
    UNREAD_COUNT_CAP,
  );
  assert.ok(
    items.length <= UNREAD_COUNT_CAP + 1,
    `the count reads at most the cap + 1 rows, read ${items.length}`,
  );
  assert.equal(capped, true, "beyond the cap the answer is reported as capped");
  assert.equal(
    badgeText(Math.min(items.length, UNREAD_COUNT_CAP)),
    "99+",
    "and the badge says 99+ rather than an invented total",
  );
}

/** The client-side merge that "Show older activity" appends with. */
function testPageMergeContract() {
  const first = [
    { id: "a", createdAt: "2026-07-05T03:00:00.000Z" },
    { id: "b", createdAt: "2026-07-05T02:00:00.000Z" },
  ];
  const second = [
    // Deliberately repeated: pages overlap by the pairing window.
    { id: "b", createdAt: "2026-07-05T02:00:00.000Z" },
    { id: "c", createdAt: "2026-07-05T01:00:00.000Z" },
  ];
  assert.deepEqual(
    mergeActivityPages(first, second).map((item) => item.id),
    ["a", "b", "c"],
    "an overlapping older page appends without duplicating",
  );
  assert.deepEqual(
    mergeActivityPages(
      [{ id: "z", createdAt: "2026-07-05T01:00:00.000Z" }],
      [{ id: "a", createdAt: "2026-07-05T01:00:00.000Z" }],
    ).map((item) => item.id),
    ["a", "z"],
    "equal timestamps are ordered by id so rows cannot swap between renders",
  );

  assert.equal(olderActivityAction(20, 50, true), "reveal");
  assert.equal(olderActivityAction(50, 50, true), "fetch");
  assert.equal(olderActivityAction(50, 50, false), "none");

  assert.equal(
    activityPageUrl({ sentOnly: true, cursor: "2026-07-05T01:00:00.000Z", limit: 50 }),
    "/api/activity?filter=sent&limit=50&cursor=2026-07-05T01%3A00%3A00.000Z",
  );
  const opaque = encodeActivityCursor({
    createdAt: "2026-07-05T01:00:00.000Z",
    id: "grab-abc",
  });
  assert.equal(
    activityPageUrl({ sentOnly: false, cursor: opaque, limit: 50 }),
    `/api/activity?limit=50&cursor=${opaque}`,
    "the client passes the server's cursor through verbatim and opaquely",
  );
  assert.equal(activityPageUrl({ sentOnly: false, limit: 50 }), "/api/activity?limit=50");
  assert.equal(
    unreadCountUrl("2026-07-05T01:00:00.000Z"),
    "/api/activity/unread?since=2026-07-05T01%3A00%3A00.000Z",
  );
  assert.equal(unreadCountUrl(null), "/api/activity/unread");
}

{
  const where = activityWhere("user-1", "sent");
  assert.equal(where.status, "sent");
  assert.deepEqual(where.OR, [
    { retention: null },
    { retention: { not: "stream" } },
  ]);
  assert.equal(
    "createdAt" in activityWhere("user-1", "all"),
    false,
    "no cursor means no createdAt predicate at all",
  );
  const paged = activityWhere("user-1", "all", new Date("2026-07-05T00:00:00.000Z"));
  assert.deepEqual(paged.createdAt, {
    lt: new Date("2026-07-05T00:00:00.000Z"),
  });
}

Promise.all([
  testSentFilter(),
  testPaginationReachesOlderRows(),
  testPagingPreservesDedupe(),
  testSameMillisecondRunPagesCleanly(),
  testSameMillisecondRunAcrossBothTables(),
  testDenseOneSecondBurstIsFullyReachable(),
  testDenseMixedBurstKeepsPairingAndOrder(),
  testDenseUnpairedMixedBurstIsFullyReachable(),
  testPairStraddlingBoundaryIsNotServedTwice(),
  testInvalidCursorServesNewestPage(),
  testUnreadCountIsNotCappedByFeedPage(),
  testUnreadCountStaysBounded(),
]).then(
  () => {
    testLimitIsBounded();
    testCursorEncoding();
    testPageMergeContract();
    console.log("PASS activity feed");
  },
  (error) => {
    console.error(error);
    console.error("FAIL activity feed");
    process.exit(1);
  },
);
