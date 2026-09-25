import type { TitleRetention } from "./types";

type SeasonGrabEpisodeStatus = "covered" | "missing" | "not_measured";

interface SeasonGrabEpisodeReport {
  episode: number;
  status: SeasonGrabEpisodeStatus;
  reason?: string | null;
}

export interface SeasonGrabReport {
  season: number;
  totalEpisodes: number;
  coveredEpisodes: number;
  strategy: "pack" | "singles" | "mixed" | "unknown";
  /**
   * False when coverage rests on a pack's *name* rather than its verified file
   * list — a bare `S01` claims the whole season and may not hold it. The wording
   * must not state an unverified count as fact.
   */
  coverageConfirmed: boolean;
  episodes: SeasonGrabEpisodeReport[];
  /**
   * Human-readable explanation from the planner, e.g.
   * "Season 1 pack (measured good) covers the whole season" or
   * "Assembling 8 episode(s) from individual releases".
   * Null when the planner did not produce one.
   */
  planReason?: string | null;
}

export type SeasonGrabStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; report: SeasonGrabReport }
  | { status: "error"; message: string };

export function seasonGrabKey(season: number, retention: TitleRetention = "keep"): string {
  return `season-${season}:${retention}`;
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
