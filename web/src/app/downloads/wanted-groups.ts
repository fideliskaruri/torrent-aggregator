import { WAITING_FOR_ENGLISH_LABEL, WAITING_FOR_SEASON_LIST_LABEL } from "@/components/title/title-actions";
import type { WantedRow, WantedTarget } from "@/components/wanted/wanted-actions";
import { normalizeMediaType } from "@/lib/metadata/media-type";
import { titleWithYear } from "./release-display";
import type { DownloadMediaKind } from "./types";

export interface WantedGroup extends WantedTarget {
  key: string;
  title: string;
  year: number | null;
  mediaType: string | null;
  mediaKind: DownloadMediaKind | null;
  label: string | null;
  looking: boolean;
  waitingForEnglish: boolean;
  waitingForSeasonList: boolean;
  why: string | null;
  nextAttemptAt: string | null;
  name: string;
  rows: (WantedRow & { statusLabel?: string | null })[];
}

export interface WantedTitle {
  workKey: string;
  title: string;
  year: number | null;
  mediaType: string | null;
  mediaKind: DownloadMediaKind | null;
  groups: WantedGroup[];
}

function wantedMediaKind(mediaType: string | null | undefined): DownloadMediaKind | null {
  const normalized = normalizeMediaType(mediaType);
  if (normalized === "movie") return "movie";
  if (normalized === "anime") return "anime";
  if (normalized === "tv") return "series";
  return null;
}

export function groupWantedRows(rows: readonly WantedRow[]): WantedGroup[] {
  const groups = new Map<string, WantedRow[]>();
  for (const row of rows) {
    const key = `${row.workKey}|${row.season ?? ""}`;
    const items = groups.get(key);
    if (items) items.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, items]) => {
    const first = items[0];
    const episodes = items.map((item) => item.episode).filter((episode): episode is number => episode != null);
    const singleEpisode = first.season != null && episodes.length === 1 ? episodes[0] : null;
    const label = first.season == null
      ? null
      : singleEpisode != null
        ? `S${String(first.season).padStart(2, "0")}E${String(singleEpisode).padStart(2, "0")}`
        : episodes.length === 0
          ? `Season ${first.season}`
          : `Season ${first.season} · ${episodes.length} episodes`;
    const nextAttemptAt = items
      .map((item) => item.nextAttemptAt)
      .filter((date): date is string => Boolean(date))
      .sort()[0] ?? null;
    const name = first.title || first.workKey;
    return {
      key,
      workKey: first.workKey,
      title: first.season == null ? titleWithYear(name, first.year) : name,
      year: first.year ?? null,
      mediaType: first.mediaType ?? null,
      mediaKind: wantedMediaKind(first.mediaType),
      season: first.season ?? null,
      episode: singleEpisode,
      label,
      looking: items.some((item) => item.looking),
      waitingForEnglish: items.some((item) => item.error?.startsWith(WAITING_FOR_ENGLISH_LABEL) ?? false),
      waitingForSeasonList: items.some((item) => item.error?.startsWith(WAITING_FOR_SEASON_LIST_LABEL) ?? false),
      why: items.find((item) => item.why)?.why ?? items.find((item) => item.error)?.error ?? null,
      nextAttemptAt,
      name,
      rows: items,
    };
  });
}

export function groupWantedTitles(groups: readonly WantedGroup[]): WantedTitle[] {
  const byWork = new Map<string, WantedGroup[]>();
  for (const group of groups) {
    const items = byWork.get(group.workKey);
    if (items) items.push(group);
    else byWork.set(group.workKey, [group]);
  }

  return [...byWork.entries()]
    .map(([workKey, items]) => ({
      workKey,
      title: items[0].name,
      year: items[0].year,
      mediaType: items[0].mediaType,
      mediaKind: items[0].mediaKind,
      groups: items,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export function wantedGroupStateLabel(group: WantedGroup): string {
  if (group.waitingForSeasonList) {
    return group.rows.find((row) => row.statusLabel)?.statusLabel ?? "Waiting for season list";
  }
  if (group.waitingForEnglish) {
    return group.rows.find((row) => row.statusLabel)?.statusLabel ?? "Waiting for English";
  }
  return group.looking ? "Searching" : "Not found yet";
}

function nextTry(iso: string | null): string {
  if (!iso) return "trying again soon";
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 1) return "trying again in a minute";
  if (minutes < 90) return `trying again in ${minutes} minutes`;
  return `trying again at ${new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function rowLabel(row: WantedRow): string {
  if (row.season == null) return row.title || row.workKey;
  if (row.episode == null) return `Season ${row.season}`;
  return `S${String(row.season).padStart(2, "0")}E${String(row.episode).padStart(2, "0")}`;
}

export function wantedTooltip(groups: readonly WantedGroup[]): string {
  return groups.flatMap((group) => group.rows.map((row) => `${rowLabel(row)}, ${nextTry(row.nextAttemptAt ?? null)}`))
    .join("\n");
}

export function wantedSubtitle(title: WantedTitle): string {
  if (title.mediaKind === "movie") return title.year ? String(title.year) : "";
  return title.groups.map((group) => group.label).filter((label): label is string => Boolean(label)).join(" · ");
}

export function wantedGroupName(group: WantedGroup): string {
  return group.label ? `${group.title} ${group.label}` : group.title;
}

export function wantedTitleKeyForDownload(groupKey: string, workKey: string | null | undefined): string {
  return groupKey.trim() || workKey?.trim() || groupKey;
}
