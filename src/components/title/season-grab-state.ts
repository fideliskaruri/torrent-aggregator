import type { TitleActionStatus } from "./title-actions";

export type SeasonGrabEpisodeStatus = "covered" | "missing" | "not_measured";

export interface SeasonGrabEpisodeReport {
  episode: number;
  status: SeasonGrabEpisodeStatus;
  reason?: string | null;
}

export interface SeasonGrabReport {
  season: number;
  totalEpisodes: number;
  coveredEpisodes: number;
  strategy: "pack" | "singles" | "mixed" | "unknown";
  episodes: SeasonGrabEpisodeReport[];
}

export type SeasonGrabStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; report: SeasonGrabReport }
  | { status: "error"; message: string };

export function seasonGrabKey(season: number): string {
  return `season-${season}`;
}

export function canOfferSeasonGrab(
  season: number | null,
  episodeCount: number,
): boolean {
  return season != null && episodeCount > 0;
}

/**
 * The button label is not the duplicate-grab guard. A completed plan is spent
 * until refreshed rows make the selected episodes playable; this predicate is
 * the side-effect gate, with the click handler holding the same line.
 */
export function shouldRunSeasonGrab(status: SeasonGrabStatus): boolean {
  return status.status === "idle" || status.status === "error";
}

export function seasonGrabSummary(
  status: SeasonGrabStatus,
  season: number,
): string {
  if (status.status === "idle") {
    return "Season coverage not measured yet.";
  }
  if (status.status === "pending") {
    return `Checking season ${season}…`;
  }
  if (status.status === "error") {
    return `Could not plan season ${season}. ${status.message}`;
  }

  const report = status.report;
  const missing = report.episodes
    .filter((episode) => episode.status === "missing")
    .map((episode) => formatEpisodeLabel(report.season, episode.episode));
  const unmeasured = report.episodes
    .filter((episode) => episode.status === "not_measured")
    .map((episode) => formatEpisodeLabel(report.season, episode.episode));

  const parts = [
    `${report.coveredEpisodes} of ${report.totalEpisodes} episodes covered.`,
  ];
  if (missing.length > 0) {
    parts.push(`Missing: ${missing.join(", ")}.`);
  }
  if (unmeasured.length > 0) {
    parts.push(`Not measured yet: ${unmeasured.join(", ")}.`);
  }
  return parts.join(" ");
}

export function seasonGrabStrategySummary(report: SeasonGrabReport): string | null {
  switch (report.strategy) {
    case "pack":
      return "A season pack was selected.";
    case "singles":
      return "Individual episode releases were selected.";
    case "mixed":
      return "A mix of pack and episode releases was selected.";
    case "unknown":
      return null;
    default:
      return assertNeverStrategy(report.strategy);
  }
}

export function episodeStatusesFromSeasonReport(
  report: SeasonGrabReport,
): Record<string, TitleActionStatus> {
  const statuses: Record<string, TitleActionStatus> = {};
  for (const episode of report.episodes) {
    const key = `s${report.season}e${episode.episode}`;
    if (episode.status === "covered") statuses[key] = "done";
    if (episode.status === "missing") statuses[key] = "error";
  }
  return statuses;
}

function formatEpisodeLabel(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function assertNeverStrategy(value: never): never {
  throw new Error(`Unhandled season grab strategy: ${value}`);
}
