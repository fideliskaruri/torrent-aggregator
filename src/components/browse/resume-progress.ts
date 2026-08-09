import type { ProgressEntry } from "@/lib/browse/types";

type ResumeCoordinates = {
  season?: number | null;
  episode?: number | null;
};

/**
 * Pick the newest active progress row that belongs to the requested episode.
 *
 * A season pack shares one info hash across many files, so falling back to a
 * different episode would be worse than starting at zero. The API returns rows
 * newest-first; callers without episode coordinates may safely use that first
 * active row.
 */
export function resumePositionForTarget(
  entries: ProgressEntry[],
  target: ResumeCoordinates,
): number | null {
  const active = entries.filter(
    (entry) =>
      entry.completedAt === null &&
      Number.isFinite(entry.positionSec) &&
      entry.positionSec > 5,
  );
  const candidates = active.filter(
    (entry) =>
      (target.season == null || entry.season === target.season) &&
      (target.episode == null || entry.episode === target.episode),
  );
  const hasExactEpisode = target.season != null && target.episode != null;
  const match = hasExactEpisode
    ? candidates[0]
    : candidates.length === 1
      ? candidates[0]
      : undefined;

  return match ? Math.floor(match.positionSec) : null;
}
