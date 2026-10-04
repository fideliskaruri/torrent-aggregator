export function requestDeadlineMs(intervalMs: number, firstLoad = false): number {
  if (firstLoad) return 60_000;
  return Math.max(15_000, Math.min(60_000, intervalMs * 4));
}
