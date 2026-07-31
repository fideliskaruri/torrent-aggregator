/**
 * Home-release evidence for discovery rails.
 *
 * TMDB's primary movie date is usually a premiere/theatrical date. A past
 * primary date therefore does not prove that a film is available at home.
 * Digital (4), Physical (5), and TV (6) dates do.
 *
 * The checked bit is essential: no cache row, a failed provider request, or an
 * empty response is unknown and can never close the gate.
 */

const HOME_RELEASE_TYPES = new Set([4, 5, 6]);
const KNOWN_RELEASE_TYPES = new Set([1, 2, 3, 4, 5, 6]);

export interface TmdbCountryRelease {
  release_dates?: Array<{
    release_date?: string | null;
    type?: number | null;
  }>;
}

export interface HomeReleaseSignal {
  /** True only when TMDB supplied at least one dated, recognised release row. */
  checked: boolean;
  /** Earliest premiere/theatrical date on or before the classification day. */
  theatricalReleasedAt: string | null;
  /** Earliest home-release date on or before the classification day. */
  releasedAt: string | null;
  /** Earliest home-release date after the classification day. */
  nextHomeReleaseAt: string | null;
}

export interface TheatricalGate {
  inTheatricalWindow: boolean;
  nextHomeReleaseAt: string | null;
}

const NO_SIGNAL: HomeReleaseSignal = Object.freeze({
  checked: false,
  theatricalReleasedAt: null,
  releasedAt: null,
  nextHomeReleaseAt: null,
});

const OPEN_GATE: TheatricalGate = Object.freeze({
  inTheatricalWindow: false,
  nextHomeReleaseAt: null,
});

function isoDay(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
}

/**
 * Classify release-date rows without turning an empty response into evidence.
 */
export function classifyHomeReleaseEvidence(
  results: readonly TmdbCountryRelease[] | null | undefined,
  now: Date = new Date(),
): HomeReleaseSignal {
  const today = now.toISOString().slice(0, 10);
  const theatricalPast: string[] = [];
  const past: string[] = [];
  const future: string[] = [];
  let sawDatedRelease = false;

  for (const country of results ?? []) {
    for (const entry of country.release_dates ?? []) {
      const type = entry.type ?? 0;
      const date = isoDay(entry.release_date);
      if (!KNOWN_RELEASE_TYPES.has(type) || !date) continue;
      sawDatedRelease = true;
      if (type <= 3 && date <= today) theatricalPast.push(date);
      if (!HOME_RELEASE_TYPES.has(type)) continue;
      (date <= today ? past : future).push(date);
    }
  }

  if (!sawDatedRelease) return NO_SIGNAL;
  theatricalPast.sort();
  past.sort();
  future.sort();
  return {
    checked: true,
    theatricalReleasedAt: theatricalPast[0] ?? null,
    releasedAt: past[0] ?? null,
    nextHomeReleaseAt: future[0] ?? null,
  };
}

/**
 * Convert persisted provider evidence into the two fields a rail card needs.
 *
 * Unknown media type, unknown primary date, and unchecked provider data all
 * fail open. Series also fail open even if a malformed cache row says true:
 * this rule is exclusively about a movie's cinema-to-home window.
 */
export function theatricalGateFromSignal(
  input: {
    mediaType: string | null | undefined;
    releaseDate: Date | string | null | undefined;
  },
  signal: HomeReleaseSignal | null | undefined,
  now: Date = new Date(),
): TheatricalGate {
  const mediaType = input.mediaType?.trim().toLowerCase();
  if (!["movie", "movies", "film", "feature"].includes(mediaType ?? "")) {
    return OPEN_GATE;
  }

  const today = now.toISOString().slice(0, 10);
  const primaryDate = isoDay(input.releaseDate);
  if (!primaryDate || primaryDate > today || signal?.checked !== true) {
    return OPEN_GATE;
  }
  const theatricalDate = isoDay(signal.theatricalReleasedAt);
  if (!theatricalDate || theatricalDate > today) return OPEN_GATE;

  const homeDates = [signal.releasedAt, signal.nextHomeReleaseAt]
    .map(isoDay)
    .filter((date): date is string => date !== null)
    .sort();
  const earliestHome = homeDates[0] ?? null;
  if (earliestHome && earliestHome <= today) return OPEN_GATE;

  return {
    inTheatricalWindow: true,
    nextHomeReleaseAt: earliestHome,
  };
}
