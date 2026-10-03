/**
 * "How much of this season do I have?"
 *
 * One definition, used by the season header, the title hero (summed over
 * seasons) and the Downloads series row alike:
 *
 *  - **downloaded**: distinct episodes with a finished file on disk.
 *  - **downloading**: distinct episodes queued or transferring that are not
 *    downloaded yet. Counted separately, never folded into `downloaded`.
 *  - **queued** (optional): when the caller can tell them apart, the episodes
 *    still waiting their turn move out of `downloading` into here, so a line
 *    reads "1 downloading · 2 queued". Downloads knows each transfer's engine
 *    state, so its series row splits them; a caller that leaves this out
 *    keeps queued episodes under `downloading`.
 *  - **aired** (the Y in "X of Y"): episodes that have aired. Unaired episodes
 *    are left out entirely, so a season airing weekly reads complete once you
 *    hold everything released so far. A downloaded episode always counts as
 *    aired. `null` means nobody knows yet, and the UI says "X downloaded"
 *    instead of guessing a total.
 *
 * The loaded season is derived from its rows, which the transfer poll keeps
 * live. Every other season comes from the detail payload's per-season counts
 * and the provider's aired counts.
 */
import { isUnaired, type EpisodeRowModel } from "./merge-extras";
import type { TitleSeason } from "./types";

export interface SeasonProgress {
  downloaded: number;
  downloading: number;
  /** Waiting in the download queue, kept apart from `downloading` when known. */
  queued?: number;
  aired: number | null;
}

export function isRowDownloaded(row: EpisodeRowModel): boolean {
  return row.availability === "ready" || row.transfer?.status === "downloaded";
}

function isRowDownloading(row: EpisodeRowModel): boolean {
  return (
    !isRowDownloaded(row) &&
    (row.transfer?.status === "queued" || row.transfer?.status === "downloading")
  );
}

export function seasonProgressFromRows(
  rows: readonly EpisodeRowModel[],
  providerAired: number | null,
  now: Date = new Date(),
): SeasonProgress {
  let downloaded = 0;
  let downloading = 0;
  let aired = 0;
  for (const row of rows) {
    const done = isRowDownloaded(row);
    if (done) downloaded += 1;
    else if (isRowDownloading(row)) downloading += 1;
    if (done || !isUnaired(row.meta?.airDate ?? null, now)) aired += 1;
  }
  // Rows only exist for episodes something has heard of; the provider may know
  // of aired episodes nothing local has seen yet.
  const total = Math.max(aired, providerAired ?? 0, downloaded);
  return {
    downloaded,
    downloading,
    aired: rows.length === 0 && providerAired == null ? null : total,
  };
}

export function seasonProgressFromSummary(
  season: TitleSeason,
  providerAired: number | null,
): SeasonProgress {
  const downloaded = season.downloadedEpisodes ?? 0;
  return {
    downloaded,
    downloading: season.downloadingEpisodes ?? 0,
    aired: providerAired == null ? null : Math.max(providerAired, downloaded),
  };
}

export function isSeasonComplete(p: SeasonProgress): boolean {
  return p.aired != null && p.aired > 0 && p.downloaded >= p.aired;
}

/**
 * The one download line, said the same way everywhere (season header, title
 * hero, Downloads series row): `12 of 38 in your library · 3 downloading`.
 * Without a known total it drops the "of Y": `5 in your library · 2 downloading`.
 * Queued episodes, when counted apart, follow as their own part:
 * `1 downloading · 2 queued`. The "of Y" rides on the first part said.
 * Null when nothing is downloaded or on its way.
 */
export function seasonProgressLabel(p: SeasonProgress): string | null {
  const total = p.aired != null && p.aired > 0 ? p.aired : null;
  const parts = [
    { count: p.downloaded, word: "in your library" },
    { count: p.downloading, word: "downloading" },
    { count: p.queued ?? 0, word: "queued" },
  ].filter((part) => part.count > 0);
  if (parts.length === 0) return null;
  return parts
    .map((part, index) =>
      index === 0 && total != null ? `${part.count} of ${total} ${part.word}` : `${part.count} ${part.word}`,
    )
    .join(" \u00b7 ");
}

/**
 * A whole show's progress: every season summed. The total is unknown when any
 * season's is, so the hero never claims "12 of 12" while a season's count is
 * still missing.
 */
export function showProgressFromSeasons(seasons: readonly SeasonProgress[]): SeasonProgress {
  let downloaded = 0;
  let downloading = 0;
  let queued = 0;
  let aired: number | null = seasons.length > 0 ? 0 : null;
  for (const p of seasons) {
    downloaded += p.downloaded;
    downloading += p.downloading;
    queued += p.queued ?? 0;
    aired = aired == null || p.aired == null ? null : aired + p.aired;
  }
  return { downloaded, downloading, queued, aired };
}

export function providerAiredFor(
  map: Record<string, number> | undefined | null,
  season: number,
): number | null {
  const value = map?.[String(season)];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
