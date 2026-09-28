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
  /**
   * Aggregate reasons the missing episodes did not start, most common first
   * when the server sorts them. Optional: older servers omit it.
   */
  failureReasons?: SeasonGrabFailureReason[] | null;
  /**
   * False when trying the missing episodes again cannot help (for example the
   * season has nothing released at the chosen quality). Omitted means unknown,
   * which still allows a retry of the missing episodes.
   */
  retryable?: boolean | null;
}

export interface SeasonGrabFailureReason {
  code: string;
  count: number;
  message: string;
  action?: string | null;
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

/**
 * A Retry from a result toast may rerun a season whose last run finished
 * ("done" after a partial start) or failed, but never one still in flight.
 */
export function shouldRetrySeasonGrab(status: SeasonGrabStatus): boolean {
  return status.status !== "pending";
}

/**
 * Episodes a Retry may resend: those the report marks missing, limited to the
 * episodes the original click asked for. Covered episodes are never resent.
 */
export function seasonGrabMissingEpisodes(
  report: SeasonGrabReport,
  requested: readonly number[],
): number[] {
  const asked = new Set(requested);
  const covered = new Set<number>();
  const missing = new Set<number>();
  for (const episode of report.episodes) {
    if (!Number.isInteger(episode.episode)) continue;
    if (episode.status === "covered") covered.add(episode.episode);
    else if (episode.status === "missing") missing.add(episode.episode);
  }
  return [...missing]
    .filter((episode) => asked.has(episode) && !covered.has(episode))
    .sort((a, b) => a - b);
}

/** Missing episodes to offer a Retry for, or null when a retry cannot help. */
export function seasonGrabRetryEpisodes(
  report: SeasonGrabReport | null | undefined,
  requested: readonly number[],
): number[] | null {
  if (!report || report.retryable === false) return null;
  const missing = seasonGrabMissingEpisodes(report, requested);
  return missing.length > 0 ? missing : null;
}

const SEASON_FAILURE_DESCRIPTION_MAX = 200;

/** Season grab failure that keeps a short toast description beside the title. */
export class SeasonGrabFailureError extends Error {
  readonly description?: string;
  readonly report?: SeasonGrabReport | null;

  constructor(
    message: string,
    description?: string,
    report?: SeasonGrabReport | null,
  ) {
    super(message);
    this.name = "SeasonGrabFailureError";
    this.description = description;
    this.report = report;
  }
}

/**
 * Short toast description for the episodes a season download did not start.
 * Prefers the server's aggregate reasons ("3 episodes: No release at 1080p or
 * higher. Choose a lower quality."), then groups distinct per-episode reasons,
 * then falls back to the planner's sentence. When `headline` (the toast title
 * from the server) already states every aggregate reason, only the next step
 * is returned so the toast does not say the same thing twice.
 */
export function seasonGrabFailureDescription(
  report: SeasonGrabReport,
  headline?: string | null,
): string | undefined {
  const aggregate = describeFailureReasons(report.failureReasons, headline);
  if (aggregate !== null) return aggregate ? clipSeasonFailureDescription(aggregate) : undefined;

  const counts = new Map<string, number>();
  for (const episode of report.episodes) {
    if (episode.status !== "missing") continue;
    const reason = episode.reason?.trim();
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const parts = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${episodeCountLabel(count)}: ${sentence(reason)}`);
    return clipSeasonFailureDescription(parts.join(" "));
  }

  const plan = report.planReason?.trim();
  return plan ? clipSeasonFailureDescription(plan) : undefined;
}

/**
 * The aggregate description, "" when the headline already says it all and
 * there is no next step, or null when the server sent no aggregate reasons.
 */
function describeFailureReasons(
  reasons: SeasonGrabFailureReason[] | null | undefined,
  headline?: string | null,
): string | null {
  const usable = (reasons ?? [])
    .filter((reason) => reason.message?.trim())
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  if (usable.length === 0) return null;
  // One next step, from the most common reason, so the text stays short.
  const action = usable.find((reason) => reason.action?.trim())?.action?.trim();
  const said = normalizeForMatch(headline ?? "");
  if (said && usable.every((reason) => said.includes(normalizeForMatch(reason.message)))) {
    return action && !said.includes(normalizeForMatch(action)) ? sentence(action) : "";
  }
  const parts = usable.map((reason) =>
    usable.length === 1 && !(reason.count > 1)
      ? sentence(reason.message)
      : `${episodeCountLabel(Math.max(1, reason.count || 1))}: ${sentence(reason.message)}`,
  );
  if (action) parts.push(sentence(action));
  return parts.join(" ");
}

function normalizeForMatch(text: string): string {
  return text.trim().replace(/[.!?…]+$/, "").replace(/\s+/g, " ").toLowerCase();
}

function episodeCountLabel(count: number): string {
  return count === 1 ? "1 episode" : `${count} episodes`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function clipSeasonFailureDescription(text: string): string {
  if (text.length <= SEASON_FAILURE_DESCRIPTION_MAX) return text;
  return `${text.slice(0, SEASON_FAILURE_DESCRIPTION_MAX - 1).trimEnd()}…`;
}
