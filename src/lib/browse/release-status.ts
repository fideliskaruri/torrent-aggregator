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

// ---------------------------------------------------------------------------
// Theatrical-window gate
// ---------------------------------------------------------------------------

export interface TheatricalStatus {
  /**
   * True when the film is in its theatrical window: it has had a premiere or
   * theatrical release but no Digital/Physical/TV home release yet.
   *
   * Only ever true when the TMDB release_dates endpoint actually responded —
   * if the check was skipped or the endpoint failed, this stays false so the
   * film remains playable. Absence of evidence is not evidence of absence.
   */
  inTheatricalWindow: boolean;
  /**
   * Short chip label when the film is in its theatrical window.
   *
   * - "In cinemas" — no future home release date is known.
   * - "Digital Aug 2026" — the earliest upcoming home release date is known.
   *
   * Null when `inTheatricalWindow` is false.
   */
  theatricalLabel: string | null;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatHomeDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!match) return "In cinemas";
  const [, year, monthStr] = match;
  const idx = Number.parseInt(monthStr, 10) - 1;
  if (idx < 0 || idx > 11) return "In cinemas";
  return `Digital ${MONTHS_SHORT[idx]} ${year}`;
}

/**
 * Theatrical-window status for a movie.
 *
 * A film in its theatrical window receives the same visual gate as an
 * unreleased title (greyscale, chip, no Play/Download), but with copy that
 * names the real reason — "In cinemas" — rather than pretending the premiere
 * has not happened yet.
 *
 * `inTheatricalWindow` comes from the extras round trip. The server sets it
 * true only when:
 *   1. The work is a movie (series are never gated by this rule).
 *   2. The TMDB release_dates endpoint responded successfully.
 *   3. The film's primary release date is in the past (theatrically released).
 *   4. No Digital (4), Physical (5) or TV (6) release date is in the past.
 *
 * The default is false, so this function never gates when data is absent.
 */
export function theatricalWindowStatus(
  inTheatricalWindow: boolean,
  nextHomeReleaseAt: string | null | undefined,
): TheatricalStatus {
  if (!inTheatricalWindow) {
    return { inTheatricalWindow: false, theatricalLabel: null };
  }
  const label = nextHomeReleaseAt ? formatHomeDate(nextHomeReleaseAt) : "In cinemas";
  return { inTheatricalWindow: true, theatricalLabel: label };
}

export interface BrowseReleaseGate {
  gated: boolean;
  label: string | null;
  reason: "future" | "theatrical" | null;
}

/**
 * The one release gate used by Browse cards and the Browse hero.
 *
 * Future primary dates apply to any media type. The cinema-to-home rule applies
 * only to a known movie; an unknown type or a series can never inherit a bad
 * theatrical cache flag.
 */
export function browseReleaseGate(
  item: {
    releaseDate?: Date | string | number | null;
    mediaType?: string | null;
    inTheatricalWindow?: boolean;
    nextHomeReleaseAt?: string | null;
  },
  now: Date = new Date(),
): BrowseReleaseGate {
  const primary = releaseStatus(item.releaseDate, now);
  if (primary.unreleased) {
    return {
      gated: true,
      label: primary.comingLabel ?? "Coming soon",
      reason: "future",
    };
  }

  const mediaType = item.mediaType?.trim().toLowerCase();
  const movie = ["movie", "movies", "film", "feature"].includes(
    mediaType ?? "",
  );
  const theatrical = theatricalWindowStatus(
    movie && item.inTheatricalWindow === true,
    item.nextHomeReleaseAt,
  );
  if (theatrical.inTheatricalWindow) {
    return {
      gated: true,
      label: theatrical.theatricalLabel ?? "In cinemas",
      reason: "theatrical",
    };
  }

  return { gated: false, label: null, reason: null };
}
