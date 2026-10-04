import { isSeriesMediaType } from "@/lib/metadata/media-type";

export interface LibraryStateItem {
  mediaType: string;
  title: string;
  monitored?: boolean | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  /** The season a series was asked to start from. `null` means new episodes only. */
  fromSeason?: number | null;
  nextEpisodeHint?: string | null;
  latestReleaseMagnet?: string | null;
  /** A finished download of this title is on disk. */
  ready?: boolean | null;
}

type LibraryItemStatusKind =
  | "ready"
  | "in-client"
  | "getting"
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
  const ready = items.filter((item) => Boolean(item.ready || item.latestReleaseMagnet)).length;
  const waiting = items.filter(
    (item) =>
      isSeriesMediaType(item.mediaType) &&
      item.monitored !== false &&
      !item.latestReleaseMagnet &&
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

export function libraryItemState(
  item: LibraryStateItem,
  opts: { sending: boolean },
): LibraryItemState {
  const isSeries = isSeriesMediaType(item.mediaType);
  const nextLabel = isSeries ? nextEpisodeLabel(item) : null;

  if (opts.sending) {
    const target = nextLabel ?? "this title";
    return {
      kind: "getting",
      label: `Getting ${target} ready…`,
      detail: "This row will update when the grab finishes.",
      nextLabel,
    };
  }

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

  if (item.latestReleaseMagnet) {
    return {
      kind: "in-client",
      label: "In your client",
      detail: nextLabel
        ? `${nextLabel} was sent to your torrent client.`
        : "Sent to your torrent client.",
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

  // "New episodes only" deliberately stores no start (see
  // `answersToPayload`), so there is no episode to name yet. That is the
  // user's answer, not a missing one; asking again would contradict it.
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
    item.cursorSeason == null &&
    !item.nextEpisodeHint?.trim()
  );
}

function nextEpisodeLabel(item: LibraryStateItem): string | null {
  if (item.cursorSeason != null && item.cursorEpisode != null) {
    return `S${pad(item.cursorSeason)}E${pad(item.cursorEpisode)}`;
  }

  const hint = item.nextEpisodeHint?.replace(item.title, "").trim();
  const match = hint?.match(/S(\d{1,3})E(\d{1,3})/i);
  if (match) {
    return `S${pad(Number(match[1]))}E${pad(Number(match[2]))}`;
  }
  return hint || null;
}

function pad(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, "0");
}
