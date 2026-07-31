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
export const LEGACY_ACTIVITY_PAIR_WINDOW_MS = 1_000;

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
export function activityWhere(userId: string, filter: ActivityFilter) {
  return {
    userId,
    OR: [{ retention: null }, { retention: { not: "stream" } }],
    ...(filter === "sent" ? { status: "sent" } : {}),
  } satisfies Prisma.GrabJobWhereInput & Prisma.DownloadHistoryWhereInput;
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

  return reconciled
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))
    .slice(0, limit);
}

export async function loadActivityItems(
  db: ActivityStore,
  userId: string,
  filter: ActivityFilter,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityItem[]> {
  const where = activityWhere(userId, filter);
  const [jobs, history] = await Promise.all([
    db.grabJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.downloadHistory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  return reconcileActivityItems(
    [...jobs.map(grabItem), ...history.map(historyItem)],
    limit,
  );
}
