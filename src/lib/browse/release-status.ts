/**
 * Future-gating — the single source of truth for "is this thing out yet?".
 *
 * A title whose primary release / first-air date is in the FUTURE is not a
 * playable thing yet. Every surface (browse rails, search results, title hero)
 * must gray it out and label it "Coming {date}" rather than offer a dead
 * Play/Download that resolves to nothing.
 *
 * Unknown dates are NEVER gated: the absence of a date is not evidence that a
 * title is in the future. Confusing "no date" with "future" would hide half the
 * catalogue, exactly the mistake the `availability: null` state exists to avoid.
 */

export interface ReleaseStatus {
  /** True only when we have a concrete date and it is strictly in the future. */
  unreleased: boolean;
  /** Convenience inverse. Unknown dates are treated as released (never gated). */
  released: boolean;
  /** e.g. "Coming Jul 2026" or "Coming 2026". Null when released or unknown. */
  comingLabel: string | null;
  /** The parsed date, when the input was a valid date. */
  date: Date | null;
}

export function parseReleaseDate(
  input: Date | string | number | null | undefined,
): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A year-only date is stored as Jan 1 of that year (TMDB/AniList give a bare
 * year for many announced-but-undated titles). We must not pretend to know the
 * month in that case, so the label degrades to just the year.
 */
function isYearOnlyPlaceholder(date: Date): boolean {
  return date.getMonth() === 0 && date.getDate() === 1;
}

function formatComingLabel(date: Date): string {
  if (isYearOnlyPlaceholder(date)) return `Coming ${date.getFullYear()}`;
  return `Coming ${date.toLocaleString("en-US", { month: "short", year: "numeric" })}`;
}

export function releaseStatus(
  input: Date | string | number | null | undefined,
  now: Date = new Date(),
): ReleaseStatus {
  const date = parseReleaseDate(input);
  if (!date) {
    return { unreleased: false, released: true, comingLabel: null, date: null };
  }
  const future = date.getTime() > now.getTime();
  if (!future) {
    return { unreleased: false, released: true, comingLabel: null, date };
  }
  return {
    unreleased: true,
    released: false,
    comingLabel: formatComingLabel(date),
    date,
  };
}

/** True only when a concrete date is strictly in the future. */
export function isUnreleased(
  input: Date | string | number | null | undefined,
  now: Date = new Date(),
): boolean {
  return releaseStatus(input, now).unreleased;
}
