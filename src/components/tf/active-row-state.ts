/**
 * What an active download row says about itself.
 *
 * The teaser had `progress` and `dlspeed` in its type and rendered neither, so
 * a panel whose entire subject is work in flight showed a list of names and
 * nothing else. Three identical-looking rows could be at 2%, 97%, and stalled.
 *
 * Split out from the component because the interesting part is the wording,
 * not the markup, and wording is where this app has repeatedly claimed things
 * that were not true: a floored 0% on a running torrent, "downloading" on a
 * queue entry that had not started, a speed on a row that is not moving.
 */

export interface ActiveRow {
  /** 0–1. */
  progress: number;
  /** Bytes per second. */
  dlspeed: number;
  /** Raw client state string. */
  state: string;
}

/**
 * Percent as a whole number, floored.
 *
 * Floored, not rounded, for the same reason the title page floors it: 99.6%
 * rounding to "100%" tells someone a file is complete while it is still being
 * written, and they will go and try to open it.
 */
export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.floor(clamped * 100);
}

/** Human speed, or null when nothing is moving. */
export function speedLabel(dlspeed: number): string | null {
  if (!Number.isFinite(dlspeed) || dlspeed <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = dlspeed;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${shown} ${units[unit]}/s`;
}

/**
 * The state word, in the user's language rather than the client's.
 *
 * `stalledDL` is the one that matters: it reads like an error and means only
 * "connected to nobody right now", which is a normal and usually temporary
 * condition. Calling it "Stalled" invites someone to cancel a download that
 * would have finished on its own.
 */
export function stateLabel(state: string): string {
  const s = String(state ?? "").toLowerCase();
  if (/meta/.test(s)) return "Finding files";
  if (/stalled/.test(s)) return "Looking for peers";
  if (/queued/.test(s)) return "Queued";
  if (/check/.test(s)) return "Checking";
  if (/alloc/.test(s)) return "Preparing";
  if (/pause/.test(s)) return "Paused";
  return "Downloading";
}

/**
 * The one line under a row's title.
 *
 * Speed is appended only when it is real. A row reading "Downloading 41% ·
 * 0 B/s" is worse than one reading "Downloading 41%", because the zero looks
 * like a measurement of failure rather than the absence of a measurement.
 *
 * Percent is withheld at zero for a torrent that has not begun: "Finding files
 * 0%" invites the reading that it has stalled at nothing, when in fact there
 * is nothing to report yet.
 */
export function activityLabel(row: ActiveRow): string {
  const label = stateLabel(row.state);
  const percent = progressPercent(row.progress);
  const speed = speedLabel(row.dlspeed);
  const parts: string[] = [];
  if (percent > 0 || label === "Downloading") {
    parts.push(`${label} ${percent}%`);
  } else {
    parts.push(label);
  }
  if (speed) parts.push(speed);
  return parts.join(" · ");
}
