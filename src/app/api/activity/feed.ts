import type {
  DownloadHistory,
  GrabJob,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  infoHashFromMagnet,
  normalizeInfoHash,
} from "@/lib/torrents/infohash";

export const ACTIVITY_LIMIT = 50;
/** Hard ceiling on `?limit=`, so a crafted URL cannot ask for the whole table. */
export const ACTIVITY_MAX_LIMIT = 200;
export const LEGACY_ACTIVITY_PAIR_WINDOW_MS = 1_000;
/**
 * Extra rows read per page so the pairing-window overlap and the merges that
 * collapse two rows into one cannot starve a page of its `limit`.
 */
export const PAGE_OVERLAP_SLACK = 10;

export type ActivityFilter = "all" | "sent";

export type ActivityItem = {
  id: string;
  type: "grab" | "history";
  title: string;
  status: string;
  message: string | null;
  source: string | null;
  kind: string | null;
  query: string | null;
  magnet: string | null;
  infoHash: string | null;
  savePath: string | null;
  category: string | null;
  context: string | null;
  clientType: string | null;
  sendKind: string | null;
  createdAt: string;
};

export type ActivityStore = Pick<
  PrismaClient,
  "grabJob" | "downloadHistory"
>;

/**
 * Streams are ephemeral playback cache entries, not downloads. Legacy rows
 * have a NULL retention because they predate that column, so NULL must be
 * included explicitly rather than relying on SQL `NOT`, which excludes it.
 */
export function activityWhere(
  userId: string,
  filter: ActivityFilter,
  createdBefore?: Date,
) {
  return {
    userId,
    OR: [{ retention: null }, { retention: { not: "stream" } }],
    ...(filter === "sent" ? { status: "sent" } : {}),
    ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}),
  } satisfies Prisma.GrabJobWhereInput & Prisma.DownloadHistoryWhereInput;
}

/**
 * The order both tables are read in, and the order `compareActivity` restates.
 *
 * The `id` leg is not decoration: with `createdAt` alone the database is free
 * to return any of the rows written in the same millisecond, so a `take`-bound
 * read could hand back a different subset on every page and a composite cursor
 * would still walk past rows it never saw.
 */
function activityOrderBy(): [{ createdAt: "desc" }, { id: "asc" }] {
  return [{ createdAt: "desc" }, { id: "asc" }];
}

function grabItem(job: GrabJob): ActivityItem {
  return {
    id: `grab-${job.id}`,
    type: "grab",
    title: job.title,
    status: job.status,
    message: job.message,
    source: job.source,
    kind: job.kind,
    query: job.query,
    magnet: job.magnet,
    infoHash:
      normalizeInfoHash(job.infoHash) ?? infoHashFromMagnet(job.magnet),
    savePath: job.savePath,
    category: job.category,
    context: null,
    clientType: null,
    sendKind: null,
    createdAt: job.createdAt.toISOString(),
  };
}

function historyItem(history: DownloadHistory): ActivityItem {
  return {
    id: `hist-${history.id}`,
    type: "history",
    title: history.title,
    status: history.status,
    message: history.message,
    source: history.source,
    kind: null,
    query: null,
    magnet: history.magnet,
    infoHash:
      normalizeInfoHash(history.infoHash) ??
      infoHashFromMagnet(history.magnet),
    savePath: history.savePath,
    category: history.category,
    context: history.context,
    clientType: history.clientType,
    sendKind: history.sendKind,
    createdAt: history.createdAt.toISOString(),
  };
}

function activityIdentity(item: ActivityItem): string | null {
  const hash =
    normalizeInfoHash(item.infoHash) ?? infoHashFromMagnet(item.magnet);
  if (hash) return `hash:${hash}`;

  const magnet = item.magnet?.trim();
  return magnet ? `magnet:${magnet}` : null;
}

function createdAtMs(item: ActivityItem): number {
  return new Date(item.createdAt).getTime();
}

function pairDistanceMs(
  grab: ActivityItem,
  history: ActivityItem,
): number | null {
  if (grab.status !== history.status) return null;

  const grabIdentity = activityIdentity(grab);
  if (!grabIdentity || grabIdentity !== activityIdentity(history)) return null;

  const distance = Math.abs(createdAtMs(grab) - createdAtMs(history));
  return Number.isFinite(distance) &&
    distance <= LEGACY_ACTIVITY_PAIR_WINDOW_MS
    ? distance
    : null;
}

function mergePair(grab: ActivityItem, history: ActivityItem): ActivityItem {
  return {
    ...grab,
    message: history.message ?? grab.message,
    source: grab.source ?? history.source,
    magnet: grab.magnet ?? history.magnet,
    infoHash: grab.infoHash ?? history.infoHash,
    savePath: grab.savePath ?? history.savePath,
    category: grab.category ?? history.category,
    context: history.context ?? grab.context,
    clientType: history.clientType ?? grab.clientType,
    sendKind: history.sendKind ?? grab.sendKind,
    createdAt:
      createdAtMs(history) > createdAtMs(grab)
        ? history.createdAt
        : grab.createdAt,
  };
}

/**
 * Reconcile the two durable records written for one pipeline event.
 *
 * Matching is one-to-one, cross-table, and time-bounded. This removes the
 * GrabJob/DownloadHistory representation duplicate without collapsing a real
 * re-grab of the same torrent later or hiding history-only manual sends.
 */
export function reconcileActivityItems(
  merged: ActivityItem[],
  limit = ACTIVITY_LIMIT,
): ActivityItem[] {
  const grabs = merged
    .filter((item) => item.type === "grab")
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
  const histories = merged
    .filter((item) => item.type === "history")
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
  const unmatchedHistory = new Set(histories.map((_, index) => index));
  const reconciled: ActivityItem[] = [];

  for (const grab of grabs) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const index of unmatchedHistory) {
      const distance = pairDistanceMs(grab, histories[index]);
      if (distance !== null && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }

    if (bestIndex >= 0) {
      unmatchedHistory.delete(bestIndex);
      reconciled.push(mergePair(grab, histories[bestIndex]));
    } else {
      reconciled.push(grab);
    }
  }

  for (const index of unmatchedHistory) {
    reconciled.push(histories[index]);
  }

  return reconciled.sort(compareActivity).slice(0, limit);
}

/**
 * Newest first, then by id ascending.
 *
 * The id tiebreak is what makes the cursor below safe: two rows written in the
 * same millisecond must land in the same order on every request, or a page
 * boundary that falls between them would drop one and repeat the other. The
 * comparison is ordinal (not `localeCompare`) so it is exactly the order the
 * database sorts by, which is what lets the cursor be pushed into the query.
 */
function compareActivity(a: ActivityItem, b: ActivityItem): number {
  return createdAtMs(b) - createdAtMs(a) || compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type ActivityPage = {
  items: ActivityItem[];
  /** Pass back as `?cursor=` to get the next, older page. Null at the end. */
  nextCursor: string | null;
  hasMore: boolean;
};

export type ActivityPageOptions = {
  limit?: number | string | null;
  cursor?: string | null;
};

/** Clamp a caller-supplied `?limit=` into the range the API will serve. */
export function normalizeActivityLimit(raw: string | number | null): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return ACTIVITY_LIMIT;
  }
  return Math.min(Math.trunc(value), ACTIVITY_MAX_LIMIT);
}

/**
 * A page boundary: the `createdAt` **and** the id of the last row already
 * shown, because `createdAt` alone does not identify a position in a total
 * order that breaks millisecond ties by id.
 *
 * `id` is null only for a legacy timestamp-only cursor issued before this
 * shape existed. Those still page (by timestamp alone, as they always did)
 * rather than 400-ing a client mid-scroll.
 */
export type ActivityCursor = {
  time: Date;
  id: string | null;
};

/** Longest cursor the parser will even look at, so `?cursor=` cannot be a payload. */
export const ACTIVITY_CURSOR_MAX_LENGTH = 256;
/** Item ids are `grab-<id>` / `hist-<id>`; anything longer is not one of ours. */
const ACTIVITY_CURSOR_ID_MAX_LENGTH = 128;
const ACTIVITY_ITEM_ID = /^(?:grab|hist)-.+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Opaque, URL-safe cursor: base64url of `<iso createdAt>|<item id>`.
 *
 * Opaque so callers cannot hand-build one and land between rows, URL-safe so
 * it survives a query string untouched, and self-describing enough that the
 * server can validate it rather than trust it.
 */
export function encodeActivityCursor(item: {
  createdAt: string;
  id: string;
}): string {
  return Buffer.from(`${item.createdAt}|${item.id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursorPayload(raw: string): string | null {
  if (!BASE64URL.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url");
  // Reject anything that is not a faithful base64url encoding: sloppy padding
  // would let two different strings denote the same boundary.
  if (decoded.toString("base64url") !== raw) return null;
  return decoded.toString("utf8");
}

/**
 * Parse `?cursor=`. Invalid, oversized or unrecognised cursors return null,
 * which the API already treats as "start at the newest row".
 */
export function parseActivityCursor(
  raw: string | null | undefined,
): ActivityCursor | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > ACTIVITY_CURSOR_MAX_LENGTH) return null;

  const payload = decodeCursorPayload(trimmed);
  if (payload !== null) {
    const separator = payload.indexOf("|");
    if (separator <= 0) return null;
    const time = new Date(payload.slice(0, separator));
    const id = payload.slice(separator + 1);
    if (!Number.isFinite(time.getTime())) return null;
    if (id.length > ACTIVITY_CURSOR_ID_MAX_LENGTH) return null;
    if (!ACTIVITY_ITEM_ID.test(id)) return null;
    return { time, id };
  }

  // Legacy: a bare ISO timestamp from a client that loaded the old page.
  const date = new Date(trimmed);
  return Number.isFinite(date.getTime()) ? { time: date, id: null } : null;
}

/** Is this row strictly after the cursor in `compareActivity` order? */
function isAfterCursor(item: ActivityItem, cursor: ActivityCursor): boolean {
  const time = createdAtMs(item);
  const boundary = cursor.time.getTime();
  if (time !== boundary) return time < boundary;
  return cursor.id === null ? false : compareIds(item.id, cursor.id) > 0;
}

/**
 * The cursor boundary expressed as a `where` fragment both tables accept.
 * Deliberately structural rather than a Prisma model type — the same shape has
 * to type-check against `GrabJob` and `DownloadHistory` alike.
 */
type ActivityCursorWhere = {
  AND?: {
    OR: {
      createdAt?: Date | { lt?: Date; gt?: Date };
      id?: { gt: string };
    }[];
  }[];
};

/**
 * The boundary pushed into the page query for one table, as a *strict* filter:
 * every row it admits is one the caller has not been shown yet.
 *
 * This is what makes the read advance. An earlier shape also admitted the
 * pairing-window rows above the boundary, which meant a burst of more rows
 * than `take` inside one second spent the whole budget on rows already served:
 * the page came back empty, `hasMore` went false, and every older row was
 * stranded. The overlap is now a separate, separately-bounded read.
 *
 * Item ids are prefixed and `"grab-" < "hist-"`, so at the boundary
 * millisecond a grab-side cursor keeps every history row while a history-side
 * cursor drops every grab row — exactly the merged total order.
 */
function cursorClause(
  table: "grab" | "hist",
  cursor: ActivityCursor | null,
): ActivityCursorWhere {
  if (!cursor) return {};
  const boundary = cursor.time;
  const before = { createdAt: { lt: boundary } };
  if (!cursor.id) return { AND: [{ OR: [before] }] };

  const [prefix, ...rest] = cursor.id.split("-");
  const rawId = rest.join("-");

  if (prefix === table) {
    return { AND: [{ OR: [before, { createdAt: boundary, id: { gt: rawId } }] }] };
  }
  // The other table sorts wholly after (id prefix greater) or wholly before
  // this cursor within the boundary millisecond.
  return table > prefix
    ? { AND: [{ OR: [before, { createdAt: boundary }] }] }
    : { AND: [{ OR: [before] }] };
}

/**
 * The pairing-window rows *above* the boundary, read separately so they can
 * never consume the page's own budget.
 *
 * They exist only to let a grab/history twin that straddles the page boundary
 * re-merge, so the event is not rendered twice. They are read nearest-boundary
 * first, because those are the only ones close enough to pair with a row on
 * this page, and are dropped again by `isAfterCursor` after reconciliation.
 */
function overlapWhere(
  userId: string,
  filter: ActivityFilter,
  cursor: ActivityCursor,
) {
  const windowEnd = new Date(
    cursor.time.getTime() + LEGACY_ACTIVITY_PAIR_WINDOW_MS,
  );
  return {
    ...activityWhere(userId, filter, windowEnd),
    AND: [{ OR: [{ createdAt: { gt: cursor.time } }] }],
  };
}

function overlapOrderBy(): [{ createdAt: "asc" }, { id: "desc" }] {
  return [{ createdAt: "asc" }, { id: "desc" }];
}

/**
 * One bounded page of activity, oldest boundary given by `cursor`.
 *
 * Two details this cannot get wrong:
 *
 *  - **Dedupe survives the boundary.** A GrabJob and its DownloadHistory twin
 *    are written milliseconds apart, so a naive `createdAt < cursor` can put
 *    the pair on opposite sides of a page and render the event twice. A
 *    separate, separately-bounded read fetches only the pairing-window rows
 *    just above the boundary so the pair re-merges and is then discarded.
 *  - **It stays bounded, and it always advances.** Every read is `take`-
 *    limited, and the page reads admit only rows strictly after the cursor,
 *    so even hundreds of rows inside one second cannot spend the page's
 *    budget on rows the caller has already seen.
 *  - **The boundary is a position, not a timestamp.** The cursor carries
 *    `createdAt` *and* id and is applied in the query in exactly the order
 *    `compareActivity` defines, so a run of rows sharing one millisecond that
 *    is longer than the page limit still pages through without skipping,
 *    repeating, or stopping early.
 */
export async function loadActivityPage(
  db: ActivityStore,
  userId: string,
  filter: ActivityFilter,
  options: ActivityPageOptions = {},
): Promise<ActivityPage> {
  const limit = normalizeActivityLimit(options.limit ?? null);
  const cursor = parseActivityCursor(options.cursor);
  const where = activityWhere(userId, filter);
  // `limit + 1` proves whether an older page exists; the slack covers the
  // merges that collapse two rows into one.
  const take = limit + 1 + PAGE_OVERLAP_SLACK;
  // The overlap read has its own budget on purpose: sharing the page's budget
  // is what let a dense one-second burst starve the page of unseen rows.
  const overlapTake = limit + PAGE_OVERLAP_SLACK;
  const orderBy = activityOrderBy();

  const [jobs, history, overlapJobs, overlapHistory] = await Promise.all([
    db.grabJob.findMany({
      where: { ...where, ...cursorClause("grab", cursor) },
      orderBy,
      take,
    }),
    db.downloadHistory.findMany({
      where: { ...where, ...cursorClause("hist", cursor) },
      orderBy,
      take,
    }),
    cursor
      ? db.grabJob.findMany({
          where: overlapWhere(userId, filter, cursor),
          orderBy: overlapOrderBy(),
          take: overlapTake,
        })
      : Promise.resolve([] as GrabJob[]),
    cursor
      ? db.downloadHistory.findMany({
          where: overlapWhere(userId, filter, cursor),
          orderBy: overlapOrderBy(),
          take: overlapTake,
        })
      : Promise.resolve([] as DownloadHistory[]),
  ]);

  const reconciled = reconcileActivityItems(
    [
      ...jobs.map(grabItem),
      ...overlapJobs.map(grabItem),
      ...history.map(historyItem),
      ...overlapHistory.map(historyItem),
    ],
    (take + overlapTake) * 2,
  );
  const older = cursor
    ? reconciled.filter((item) => isAfterCursor(item, cursor))
    : reconciled;

  const items = older.slice(0, limit);
  // Only the page reads speak to whether older rows remain; the overlap read
  // is entirely made of rows the caller has already seen.
  const saturated = jobs.length >= take || history.length >= take;
  const hasMore = items.length > 0 && (older.length > limit || saturated);

  return {
    items,
    nextCursor:
      hasMore && items.length
        ? encodeActivityCursor(items[items.length - 1])
        : null,
    hasMore,
  };
}

export async function loadActivityItems(
  db: ActivityStore,
  userId: string,
  filter: ActivityFilter,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityItem[]> {
  const page = await loadActivityPage(db, userId, filter, { limit });
  return page.items;
}

/**
 * Reconciled rows newer than `since`, capped.
 *
 * The nav badge needs a count, not a feed, and it must not be the length of
 * whatever the first page happened to contain. Restricting the query to the
 * statuses the inbox recognises and stopping at `cap + 1` answers "how many,
 * and is it more than the badge can show" without an unbounded read.
 */
export async function loadActivitySince(
  db: ActivityStore,
  userId: string,
  since: Date | null,
  statuses: readonly string[],
  cap: number,
): Promise<{ items: ActivityItem[]; capped: boolean }> {
  const take = Math.max(1, cap) + 1;
  const where = {
    userId,
    OR: [{ retention: null }, { retention: { not: "stream" } }],
    status: { in: [...statuses] },
    ...(since ? { createdAt: { gt: since } } : {}),
  } satisfies Prisma.GrabJobWhereInput & Prisma.DownloadHistoryWhereInput;

  const [jobs, history] = await Promise.all([
    db.grabJob.findMany({ where, orderBy: activityOrderBy(), take }),
    db.downloadHistory.findMany({ where, orderBy: activityOrderBy(), take }),
  ]);

  const items = reconcileActivityItems(
    [...jobs.map(grabItem), ...history.map(historyItem)],
    take * 2,
  );

  return { items, capped: jobs.length >= take || history.length >= take };
}
