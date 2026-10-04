import { isSeriesMediaType } from "@/lib/metadata/media-type";

export interface LibraryStateItem {
  mediaType: string;
  monitored?: boolean | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  fromSeason?: number | null;
  ready?: boolean | null;
}

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
