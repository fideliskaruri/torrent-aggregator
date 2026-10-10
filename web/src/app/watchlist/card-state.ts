import { formatEpisodeLabel } from "@/lib/library/cursor";

export interface LibraryCardRow {
  status: string;
  mediaType?: string | null;
  monitored?: boolean;
  fromSeason?: number | null;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
}

export function followLine(row: LibraryCardRow): string {
  if (!row.monitored) return "Not following";
  return row.fromSeason != null
    ? `Following from S${row.fromSeason}`
    : "Following";
}

function formatEpisode(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null || episode == null) return null;
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return formatEpisodeLabel(Math.trunc(season), Math.trunc(episode));
}

export function positionLine(row: LibraryCardRow): string | null {
  const cursor = formatEpisode(row.cursorSeason, row.cursorEpisode);
  return cursor ? `Waiting for ${cursor}` : null;
}

type ActivityKind = "tracking" | "paused" | null;

export interface ActivityLine {
  kind: ActivityKind;
  text: string;
}

export function activityLine(row: LibraryCardRow): ActivityLine | null {
  const status = row.status.trim().toLowerCase();
  if (status === "completed" || status === "dropped") return null;

  if (row.monitored === false) return { kind: "paused", text: "Not tracking" };

  const cursor = formatEpisode(row.cursorSeason, row.cursorEpisode);
  if (row.monitored) {
    return {
      kind: "tracking",
      text: cursor ? `Tracking · next ${cursor}` : "Tracking",
    };
  }

  return null;
}
