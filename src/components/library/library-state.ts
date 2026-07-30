import { isSeriesMediaType } from "@/lib/metadata/media-type";

export interface LibraryStateItem {
  mediaType: string;
  title: string;
  monitored?: boolean | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  nextEpisodeHint?: string | null;
  latestReleaseMagnet?: string | null;
}

export type LibraryItemStatusKind =
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
  const ready = items.filter((item) => Boolean(item.latestReleaseMagnet)).length;
  const waiting = items.filter(
    (item) =>
      isSeriesMediaType(item.mediaType) &&
      item.monitored !== false &&
      !item.latestReleaseMagnet &&
      Boolean(nextEpisodeLabel(item)),
  ).length;
  const paused = items.filter((item) => item.monitored === false).length;

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
  opts: { sending: boolean; canStream: boolean },
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

  if (item.latestReleaseMagnet) {
    if (opts.canStream) {
      return {
        kind: "ready",
        label: "Ready to watch",
        detail: nextLabel ? `${nextLabel} is ready here.` : "Playable here.",
        nextLabel,
      };
    }
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
      label: "In your library",
      detail: "No release has been sent yet.",
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
      detail: "Paused — new episodes won't be added until you resume.",
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
  if (minutes < 60) return `Checks for new episodes every ${minutes} minutes`;
  if (minutes === 60) return "Checks for new episodes every hour";
  const hours = minutes / 60;
  return `Checks for new episodes every ${hours} hours`;
}

export function nextEpisodeLabel(item: LibraryStateItem): string | null {
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
