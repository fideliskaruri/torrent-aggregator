/**
 * What a download row's numbers say about themselves.
 *
 * Shared by the `/downloads` page, which renders its own state wording
 * (`stateLabel` in `src/app/downloads/page.tsx`) but reuses these two: the
 * exact place this app has repeatedly claimed things that were not true — a
 * floored 0% on a running torrent, a speed on a row that is not moving.
 */

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
