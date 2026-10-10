import { isSeriesMediaType } from "@/lib/metadata/media-type";

export interface LibraryStateItem {
  mediaType: string;
  monitored?: boolean | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  fromSeason?: number | null;
  ready?: boolean | null;
  libraryState?: "downloading" | "looking" | "downloaded" | "coming_up" | "idle";
  hasFiles?: boolean;
  ownedEpisodes?: number | null;
  airedEpisodes?: number | null;
  activeEpisodes?: number;
  nextReleaseAt?: string | null;
  lookingReason?: string | null;
  lookingSince?: string | null;
  updatedAt?: string;
}

export const LIBRARY_STATUSES = [
  "all",
  "coming_up",
  "looking",
  "downloading",
  "downloaded",
] as const;

export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];
export type ItemLibraryStatus = Exclude<LibraryStatus, "all"> | "idle";

export const LIBRARY_STATUS_LABELS: Record<LibraryStatus, string> = {
  all: "All",
  coming_up: "Coming up",
  looking: "Looking",
  downloading: "Downloading",
  downloaded: "Downloaded",
};

type LibraryItemStatusKind =
  | "ready"
  | "waiting"
  | "paused"
  | "not-set"
  | "saved";

export interface LibraryItemState {
  kind: LibraryItemStatusKind;
  label: string;
  detail: string;
  nextLabel: string | null;
}

export function itemLibraryStatus(item: LibraryStateItem): ItemLibraryStatus {
  if (item.libraryState) return item.libraryState;
  if (item.ready) return "downloaded";
  if (item.monitored) return "coming_up";
  return "idle";
}

export function libraryStatusCounts(
  items: readonly LibraryStateItem[],
): Record<LibraryStatus, number> {
  const counts: Record<LibraryStatus, number> = {
    all: items.length,
    coming_up: 0,
    looking: 0,
    downloading: 0,
    downloaded: 0,
  };
  for (const item of items) {
    const status = itemLibraryStatus(item);
    if (status !== "idle" && status !== "downloaded") counts[status] += 1;
    if (item.hasFiles || item.ready) counts.downloaded += 1;
  }
  return counts;
}

export function itemMatchesLibraryStatus(
  item: LibraryStateItem,
  status: LibraryStatus,
): boolean {
  if (status === "all") return true;
  if (status === "downloaded") return Boolean(item.hasFiles || item.ready);
  return itemLibraryStatus(item) === status;
}

function dateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date);
}

function relativeDate(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, secondsPerUnit]) => Math.abs(seconds) >= secondsPerUnit) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
}

export function libraryStatusLine(item: LibraryStateItem): {
  text: string;
  title?: string;
} {
  const status = itemLibraryStatus(item);
  const series = isSeriesMediaType(item.mediaType);

  if (status === "coming_up") {
    const date = dateLabel(item.nextReleaseAt);
    if (series) return { text: date ? `Next episode ${date}` : "Waiting for new episodes" };
    return { text: date ? `Out ${date}` : "Date not announced" };
  }
  if (status === "looking") {
    const since = item.lookingSince ? relativeDate(item.lookingSince) : null;
    return {
      text: `Looking for a copy${since ? ` since ${since}` : ""}`,
      ...(item.lookingReason ? { title: item.lookingReason } : {}),
    };
  }
  if (status === "downloading") {
    const count = item.activeEpisodes ?? 0;
    return {
      text: series && count > 1 ? `Downloading ${count} episodes` : "Downloading",
    };
  }
  if (status === "downloaded") {
    if (series && item.ownedEpisodes != null && item.airedEpisodes != null) {
      return { text: `${item.ownedEpisodes} of ${item.airedEpisodes} episodes` };
    }
    return { text: "Downloaded" };
  }
  return { text: "Not following" };
}

function releaseTimestamp(item: LibraryStateItem): number {
  const value = item.nextReleaseAt;
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function sortLibraryItems<T extends LibraryStateItem>(items: readonly T[]): T[] {
  const rank: Record<ItemLibraryStatus, number> = {
    downloading: 0,
    looking: 1,
    coming_up: 2,
    downloaded: 3,
    idle: 4,
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftStatus = itemLibraryStatus(left.item);
      const rightStatus = itemLibraryStatus(right.item);
      const statusOrder = rank[leftStatus] - rank[rightStatus];
      if (statusOrder) return statusOrder;
      if (leftStatus === "coming_up") {
        const dateOrder = releaseTimestamp(left.item) - releaseTimestamp(right.item);
        if (dateOrder) return dateOrder;
      }
      if (leftStatus === "downloaded") {
        const leftUpdated = Date.parse(left.item.updatedAt ?? "");
        const rightUpdated = Date.parse(right.item.updatedAt ?? "");
        const leftHasDate = Number.isFinite(leftUpdated);
        const rightHasDate = Number.isFinite(rightUpdated);
        if (leftHasDate !== rightHasDate) return leftHasDate ? -1 : 1;
        if (leftHasDate && rightHasDate && leftUpdated !== rightUpdated) {
          return rightUpdated - leftUpdated;
        }
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function libraryPageSummary(items: LibraryStateItem[]): string {
  const ready = items.filter((item) => Boolean(item.ready)).length;
  const waiting = items.filter(
    (item) =>
      isSeriesMediaType(item.mediaType) &&
      item.monitored !== false &&
      (Boolean(nextEpisodeLabel(item)) || newEpisodesOnly(item)),
  ).length;
  // A finished title reads as ready, not paused: there is nothing left to track for it.
  const paused = items.filter((item) => item.monitored === false && !item.ready).length;

  return [
    `${items.length} ${items.length === 1 ? "title" : "titles"}`,
    ready > 0 ? `${ready} ready` : null,
    waiting > 0 ? `${waiting} waiting` : null,
    paused > 0 ? `${paused} paused` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function libraryItemState(item: LibraryStateItem): LibraryItemState {
  const isSeries = isSeriesMediaType(item.mediaType);
  const nextLabel = isSeries ? nextEpisodeLabel(item) : null;

  if (item.ready) {
    return {
      kind: "ready",
      label: "Ready to watch",
      detail: isSeries
        ? "Downloaded episodes are on your disk."
        : "Downloaded and on your disk.",
      nextLabel,
    };
  }

  if (!isSeries) {
    return {
      kind: "saved",
      label: "Not downloaded yet",
      detail: "Download it from its title page.",
      nextLabel: null,
    };
  }

  if (!nextLabel && newEpisodesOnly(item)) {
    if (item.monitored === false) {
      return {
        kind: "paused",
        label: "Paused",
        detail: "Paused. New episodes won't be added until you resume.",
        nextLabel: null,
      };
    }
    return {
      kind: "waiting",
      label: "Waiting for new episodes",
      detail: "Set to new episodes only. Episodes that already aired are skipped.",
      nextLabel: null,
    };
  }

  if (!nextLabel) {
    return {
      kind: "not-set",
      label: "No next episode set",
      detail: "Choose where this show should start.",
      nextLabel: null,
    };
  }

  if (item.monitored === false) {
    return {
      kind: "paused",
      label: `Paused at ${nextLabel}`,
      detail: "Paused. New episodes won't be added until you resume.",
      nextLabel,
    };
  }

  return {
    kind: "waiting",
    label: `Waiting for ${nextLabel}`,
    detail: "Not downloaded yet.",
    nextLabel,
  };
}

export function automationStateCopy(minutes: number | null): string {
  if (minutes == null) return "Checking schedule…";
  if (minutes <= 0) return "New episodes won't download automatically";
  return "Automatic checks follow each title's schedule";
}

/**
 * A series added with "New episodes only": the row says it has no start season
 * and has no position yet. `null` is that answer; a requester's identity-only
 * row leaves the field out entirely, which says nothing either way.
 */
function newEpisodesOnly(item: LibraryStateItem): boolean {
  return (
    isSeriesMediaType(item.mediaType) &&
    item.fromSeason === null &&
    item.cursorSeason == null
  );
}

function nextEpisodeLabel(item: LibraryStateItem): string | null {
  if (item.cursorSeason != null && item.cursorEpisode != null) {
    return formatEpisodeLabel(item.cursorSeason, item.cursorEpisode);
  }

  return null;
}
import { formatEpisodeLabel } from "@/lib/library/cursor";
