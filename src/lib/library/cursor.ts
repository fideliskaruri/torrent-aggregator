/**
 * Library show cursor — what automation hunts next (SxxEyy).
 * On-demand rewatch must not rewind this cursor (Phase 3).
 */
import { parseEpisode } from "@/lib/torrents/episodes";
import { isSeriesMediaType } from "@/lib/metadata/media-type";

export function padEp(n: number): string {
  return n.toString().padStart(2, "0");
}

export function formatEpisodeLabel(season: number, episode: number): string {
  return `S${padEp(season)}E${padEp(episode)}`;
}

/** Backend search query for a specific episode. */
export function episodeSearchQuery(
  title: string,
  season: number,
  episode: number,
): string {
  return `${title.trim()} ${formatEpisodeLabel(season, episode)}`;
}

export type ShowCursor = {
  season: number;
  episode: number;
};

export function cursorFromStart(
  fromSeason: number,
  fromEpisode = 1,
): ShowCursor {
  return {
    season: Math.max(1, Math.trunc(fromSeason) || 1),
    episode: Math.max(1, Math.trunc(fromEpisode) || 1),
  };
}

/** Next episode in the same season. */
export function advanceCursor(cursor: ShowCursor): ShowCursor {
  return { season: cursor.season, episode: cursor.episode + 1 };
}

/**
 * How many consecutive failed hunts for the same episode before we assume the
 * season has ended and probe the next season.
 */
export const SEASON_ROLLOVER_MISS_THRESHOLD = 3;

export type MissAdvance = {
  cursor: ShowCursor;
  misses: number;
  rolledOver: boolean;
};

/**
 * Advance the cursor after a hunt found nothing.
 *
 * Rule class (not a per-show hardcode): a season boundary is invisible from a
 * release name, so we infer it. When N consecutive hunts for SxxEyy come back
 * empty AND we have already grabbed at least one episode of this season
 * (episode > 1), treat the season as finished and probe S(xx+1)E01.
 *
 * The episode > 1 guard matters: if we have never landed an episode of this
 * season, an empty result means "this show/season isn't available", not "the
 * season ended" — rolling forward there would skip a whole season.
 */
export function advanceCursorAfterMiss(
  cursor: ShowCursor,
  misses: number,
  threshold = SEASON_ROLLOVER_MISS_THRESHOLD,
): MissAdvance {
  const next = Math.max(0, Math.trunc(misses) || 0) + 1;
  const canRollOver = cursor.episode > 1 && next >= Math.max(1, threshold);
  if (!canRollOver) {
    return { cursor: { ...cursor }, misses: next, rolledOver: false };
  }
  return {
    cursor: { season: cursor.season + 1, episode: 1 },
    misses: 0,
    rolledOver: true,
  };
}

/**
 * Consecutive empty hunts before an item stops being checked every pass.
 *
 * Set above SEASON_ROLLOVER_MISS_THRESHOLD so a normal season boundary — which
 * resets misses to 0 when it rolls — never triggers backoff.
 */
export const HUNT_BACKOFF_AFTER_MISSES = 4;
const HUNT_BACKOFF_BASE_MS = 60 * 60 * 1000;
/**
 * Capped at six hours, not a day.
 *
 * The items that reach backoff are overwhelmingly cursors parked at SxxE01 —
 * and the most common reason for that is a season premiere that has not aired
 * yet, or an indexer outage. Both resolve on their own, and when they do the
 * episode is sitting there grabbable. A 24-hour ceiling would punish exactly
 * the case where waiting is least appropriate; six hours still collapses the
 * request cost by an order of magnitude.
 */
const HUNT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait before hunting an item again, given its consecutive misses.
 *
 * Some items can never succeed: a cursor parked at S04E01 of a three-season
 * show cannot roll over (rollover requires episode > 1, because at E01 an empty
 * result means "not available" rather than "season finished"), so it misses
 * forever. With a scheduler running every 30 minutes that is a real indexer
 * request, every pass, for the life of the install.
 *
 * Backoff rather than a terminal "give up" state is deliberate. An empty result
 * is ambiguous — the show may genuinely be over, or two of four indexers may be
 * down, which has actually happened here. Unmonitoring on that evidence would
 * be wrong and would need the user to notice and undo it. Backoff costs almost
 * nothing when we are wrong, and self-heals the moment a hunt succeeds, because
 * a grab resets cursorMisses to 0.
 */
export function huntBackoffMs(misses: number): number {
  const m = Math.max(0, Math.trunc(misses) || 0);
  if (m < HUNT_BACKOFF_AFTER_MISSES) return 0;
  const steps = m - HUNT_BACKOFF_AFTER_MISSES;
  // Cap the exponent before it is applied, so a long-abandoned item cannot
  // overflow 2 ** steps into Infinity.
  if (steps > 10) return HUNT_BACKOFF_MAX_MS;
  return Math.min(HUNT_BACKOFF_BASE_MS * 2 ** steps, HUNT_BACKOFF_MAX_MS);
}

/** Whether an item has waited out its backoff and should be hunted this pass. */
export function isHuntDue(
  misses: number,
  lastChecked: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const wait = huntBackoffMs(misses);
  if (wait === 0) return true;
  if (!lastChecked) return true;
  const elapsed = now.getTime() - lastChecked.getTime();
  // A lastChecked in the future (clock change) must not park an item forever.
  if (elapsed < 0) return true;
  return elapsed >= wait;
}

export function parseSeasonEpisodeLabel(
  label: string | null | undefined,
): ShowCursor | null {
  if (!label?.trim()) return null;
  const se = label.match(/S(\d{1,3})E(\d{1,4})/i);
  if (!se) return null;
  return {
    season: parseInt(se[1], 10),
    episode: parseInt(se[2], 10),
  };
}

/** Prefer explicit cursor; fall back to lastEpisode / fromSeason. */
export function resolveHuntCursor(item: {
  title: string;
  mediaType: string;
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  fromSeason?: number | null;
  fromEpisode?: number | null;
  lastEpisode?: string | null;
  nextEpisodeHint?: string | null;
}): { query: string; cursor: ShowCursor | null } {
  const isSeries = isSeriesMediaType(item.mediaType);

  if (!isSeries) {
    return { query: item.title.trim(), cursor: null };
  }

  if (
    item.cursorSeason != null &&
    item.cursorEpisode != null &&
    item.cursorSeason >= 1 &&
    item.cursorEpisode >= 1
  ) {
    const cursor = {
      season: item.cursorSeason,
      episode: item.cursorEpisode,
    };
    return {
      query: episodeSearchQuery(item.title, cursor.season, cursor.episode),
      cursor,
    };
  }

  const fromLast = parseSeasonEpisodeLabel(item.lastEpisode);
  if (fromLast) {
    const cursor = advanceCursor(fromLast);
    return {
      query: episodeSearchQuery(item.title, cursor.season, cursor.episode),
      cursor,
    };
  }

  if (item.fromSeason != null && item.fromSeason >= 1) {
    const cursor = cursorFromStart(item.fromSeason, item.fromEpisode ?? 1);
    return {
      query: episodeSearchQuery(item.title, cursor.season, cursor.episode),
      cursor,
    };
  }

  if (item.nextEpisodeHint?.trim()) {
    const hint = item.nextEpisodeHint.trim();
    const parsed = parseEpisode(hint);
    if (parsed.season != null && parsed.episode != null) {
      return {
        query: hint,
        cursor: { season: parsed.season, episode: parsed.episode },
      };
    }
    return { query: hint, cursor: null };
  }

  return { query: item.title.trim(), cursor: null };
}

/**
 * After successful send: lastEpisode = grabbed ep, cursor = next.
 */
export function afterSuccessfulGrab(
  title: string,
  huntCursor: ShowCursor | null,
  grabbedTitle: string,
): {
  lastEpisode: string;
  cursorSeason: number;
  cursorEpisode: number;
  nextEpisodeHint: string;
} {
  const fromTitle = parseEpisode(grabbedTitle);
  let completed: ShowCursor;

  if (fromTitle.season != null && fromTitle.episode != null) {
    completed = { season: fromTitle.season, episode: fromTitle.episode };
  } else if (huntCursor) {
    completed = huntCursor;
  } else {
    completed = { season: 1, episode: 1 };
  }

  const next = advanceCursor(completed);
  return {
    lastEpisode: formatEpisodeLabel(completed.season, completed.episode),
    cursorSeason: next.season,
    cursorEpisode: next.episode,
    nextEpisodeHint: episodeSearchQuery(title, next.season, next.episode),
  };
}
