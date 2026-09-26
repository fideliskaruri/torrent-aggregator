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

const SEASON_FAILURE_DESCRIPTION_MAX = 160;

/** Season grab failure that keeps a short toast description beside the title. */
export class SeasonGrabFailureError extends Error {
  readonly description?: string;

  constructor(message: string, description?: string) {
    super(message);
    this.name = "SeasonGrabFailureError";
    this.description = description;
  }
}

/**
 * Short toast description when a season grab starts nothing.
 * Prefers the planner's own sentence; otherwise groups distinct per-episode
 * reasons (e.g. "3 episodes: no release found; 1: rate limited").
 */
export function seasonGrabFailureDescription(
  report: SeasonGrabReport,
): string | undefined {
  const plan = report.planReason?.trim();
  if (plan) return clipSeasonFailureDescription(plan);

  const counts = new Map<string, number>();
  for (const episode of report.episodes) {
    const reason = episode.reason?.trim();
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;

  const parts: string[] = [];
  for (const [reason, count] of counts) {
    parts.push(
      count === 1 ? `1: ${reason}` : `${count} episodes: ${reason}`,
    );
  }
  return clipSeasonFailureDescription(parts.join("; "));
}

function clipSeasonFailureDescription(text: string): string {
  if (text.length <= SEASON_FAILURE_DESCRIPTION_MAX) return text;
  return `${text.slice(0, SEASON_FAILURE_DESCRIPTION_MAX - 1).trimEnd()}…`;
}
