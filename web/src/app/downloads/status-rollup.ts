/**
 * An honest one-line status for a set of transfers (a series or one season).
 *
 * `combinedState` picks one member's state to speak for the set, so a series
 * with thirty failed episodes and one still fetching metadata was badged
 * "Finding files". Once anything has failed, the count is the truth: say how
 * many are moving and how many need attention instead of one member's state.
 *
 * Kept free of imports so `tests/status-rollup.test.mjs` can load it directly.
 */

export interface StatusCounts {
  total: number;
  downloading: number;
  queued: number;
  paused: number;
  done: number;
  error: number;
}

export type StatusTone = "danger" | "accent" | "default";

export interface StatusSummary {
  /** Null when nothing failed: the single combined state already tells the truth. */
  label: string | null;
  tone: StatusTone;
}

export function emptyStatusCounts(): StatusCounts {
  return { total: 0, downloading: 0, queued: 0, paused: 0, done: 0, error: 0 };
}

export function needsAttentionLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
}

export function summarizeStatus(counts: StatusCounts): StatusSummary {
  if (counts.error <= 0) return { label: null, tone: "default" };
  const parts: string[] = [];
  if (counts.downloading > 0) parts.push(`${counts.downloading} downloading`);
  if (counts.queued > 0) parts.push(`${counts.queued} queued`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.done > 0) parts.push(`${counts.done} ready`);
  parts.push(needsAttentionLabel(counts.error));
  const stillMoving = counts.downloading + counts.queued;
  const mostlyFailed = counts.error * 2 > counts.total || stillMoving === 0;
  return {
    label: parts.join(" · "),
    tone: mostlyFailed ? "danger" : stillMoving > 0 ? "accent" : "default",
  };
}
