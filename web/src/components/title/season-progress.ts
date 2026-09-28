/**
 * "How much of this season do I have?"
 *
 * One definition, used by the season picker and the season header alike:
 *
 *  - **downloaded**: distinct episodes with a finished file on disk.
 *  - **downloading**: distinct episodes queued or transferring that are not
 *    downloaded yet. Counted separately, never folded into `downloaded`.
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

/** Short form for the season picker: `8/10`, `10/10 ✓`, `5/9 +2`, `3 downloaded`. */
export function seasonProgressShort(p: SeasonProgress): string | null {
  const base = seasonProgressBase(p);
  if (p.downloading === 0) return base;
  return `${base ?? "0 downloaded"} +${p.downloading}`;
}

function seasonProgressBase(p: SeasonProgress): string | null {
  if (p.aired == null) return p.downloaded > 0 ? `${p.downloaded} downloaded` : null;
  if (p.aired === 0) return p.downloaded > 0 ? `${p.downloaded} downloaded` : "not aired";
  return isSeasonComplete(p) ? `${p.downloaded}/${p.aired} \u2713` : `${p.downloaded}/${p.aired}`;
}

/** Long form for the season header: `8 of 10 episodes downloaded`. */
export function seasonProgressLabel(p: SeasonProgress): string | null {
  if (p.aired == null || p.aired === 0) {
    if (p.downloaded === 0) return null;
    return `${p.downloaded} ${p.downloaded === 1 ? "episode" : "episodes"} downloaded`;
  }
  if (isSeasonComplete(p)) {
    return p.aired === 1 ? "The aired episode is downloaded" : `All ${p.aired} aired episodes downloaded`;
  }
  return `${p.downloaded} of ${p.aired} ${p.aired === 1 ? "episode" : "episodes"} downloaded`;
}

export function providerAiredFor(
  map: Record<string, number> | undefined | null,
  season: number,
): number | null {
  const value = map?.[String(season)];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
