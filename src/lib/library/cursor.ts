/**
 * Library show cursor — what automation hunts next (SxxEyy).
 * On-demand rewatch must not rewind this cursor (Phase 3).
 */
import { parseEpisode } from "@/lib/torrents/episodes";

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

/** v1: episode + 1 (season length from TMDB later). */
export function advanceCursor(cursor: ShowCursor): ShowCursor {
  return { season: cursor.season, episode: cursor.episode + 1 };
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
  const isSeries = item.mediaType === "tv" || item.mediaType === "anime";

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
