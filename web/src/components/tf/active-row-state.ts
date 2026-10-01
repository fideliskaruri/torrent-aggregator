/**
 * What a download row's numbers say about themselves.
 *
 * Shared by the `/downloads` page, which renders its own state wording
 * (`stateLabel` in `src/app/downloads/page.tsx`) but reuses progress percent
 * here. Speed formatting lives in `@/lib/format` (`formatSpeed`).
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
