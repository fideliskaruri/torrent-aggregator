/**
 * Folding the second round trip into the first.
 *
 * `GET /api/title/[workKey]` answers from the local database — what we hold,
 * how far it downloaded, where playback got to. `GET …/extras` answers from
 * TMDB — what the episodes are called, when they air, how many seasons there
 * really are. Neither is authoritative about the other's half, and the second
 * one may never arrive, so this is where they are combined under one rule:
 *
 *   **local state wins on availability, provider data wins on description,
 *   and nothing invents either.**
 *
 * Pure and side-effect free so it can be unit-tested without a browser, which
 * matters: the merge is where a wrong answer would be least visible and most
 * damaging — an episode row that offers "Download" for something that has not
 * aired, or a season tab that shows another season's files.
 */
import type {
  TitleEpisode,
  TitleEpisodeMeta,
  TitleSeason,
} from "./types";

/** One episode row: what we hold, plus what it is, when we know. */
export type EpisodeRowModel = TitleEpisode & {
  meta: TitleEpisodeMeta | null;
};

/** Guard rail matching the API's own cap, so a 400-episode show cannot hang. */
const ROW_CAP = 200;

export interface MergedEpisodes {
  rows: EpisodeRowModel[];
  truncated: boolean;
}

/**
 * Combine the episodes we hold with the episodes the provider lists.
 *
 * The provider's list is the *shape* of the season — a show with ten episodes
 * has ten rows even when we hold two, because "we have not fetched E03 yet" is
 * exactly the thing the user came here to act on. Rows that exist only in the
 * provider's list carry `availability: null`, which is the contract's "nobody
 * has checked", never `unavailable`.
 *
 * `metaSeason` is checked against `season` on purpose: the detail route may
 * answer with a different season than the one requested (it only knows the
 * seasons it holds), and pinning another season's names onto these rows would
 * be a confident lie of exactly the kind this codebase keeps being bitten by.
 */
export function mergeEpisodes(input: {
  season: number | null;
  episodes: TitleEpisode[];
  meta: TitleEpisodeMeta[];
  metaSeason: number | null;
  /** True when the detail payload already reported a cut-off list. */
  truncated?: boolean;
}): MergedEpisodes {
  const { season, episodes, meta, metaSeason } = input;
  const usable = season != null && metaSeason === season ? meta : [];

  const metaByEpisode = new Map<number, TitleEpisodeMeta>();
  for (const item of usable) {
    if (item.episode < 1) continue; // Episode 0 is a special, not episode one.
    metaByEpisode.set(item.episode, item);
  }

  const byNumber = new Map<number, EpisodeRowModel>();
  for (const episode of episodes) {
    byNumber.set(episode.episode, {
      ...episode,
      meta: metaByEpisode.get(episode.episode) ?? null,
    });
  }

  if (season != null) {
    for (const [number, item] of metaByEpisode) {
      if (byNumber.has(number)) continue;
      byNumber.set(number, { ...blankEpisode(season, number), meta: item });
    }
  }

  const all = [...byNumber.values()].sort((a, b) => a.episode - b.episode);
  return {
    rows: all.slice(0, ROW_CAP),
    truncated: Boolean(input.truncated) || all.length > ROW_CAP,
  };
}

/**
 * A row for an episode nothing local has ever heard of.
 *
 * Every state field is the honest zero: no file, no progress, nothing watched.
 * `availability: null` is the important one — it means *not determined*, and
 * renders as an ordinary clickable Get rather than a wall.
 */
function blankEpisode(season: number, episode: number): TitleEpisode {
  return {
    season,
    episode,
    label: `S${pad(season)}E${pad(episode)}`,
    availability: null,
    infoHash: null,
    filePath: null,
    downloadFraction: null,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    transfer: null,
  };
}

/**
 * Every season the user can open — the ones we hold, plus the ones the show
 * actually has.
 *
 * A season tab we hold nothing for is not a lie; it is the only way to reach
 * "get me season one" from a page that currently only knows about season two.
 */
export function mergeSeasons(
  local: TitleSeason[],
  providerSeasons: number[],
): TitleSeason[] {
  const byNumber = new Map<number, TitleSeason>();
  for (const season of local) byNumber.set(season.season, season);

  for (const number of providerSeasons) {
    if (!Number.isInteger(number) || number < 1) continue;
    if (byNumber.has(number)) continue;
    // A season the provider knows about but we hold nothing for. There is no
    // transfer to report: the user has never asked for it.
    byNumber.set(number, {
      season: number,
      knownEpisodes: 0,
      pack: null,
      transfer: null,
    });
  }

  return [...byNumber.values()].sort((a, b) => a.season - b.season);
}

/**
 * Has this episode aired?
 *
 * Compared as `YYYY-MM-DD` strings, which sort correctly and sidestep every
 * timezone question — an episode airing "today" somewhere in the world is
 * treated as aired, which is the forgiving direction: the worst case is
 * offering a Get for something that turns up nothing, not hiding a control for
 * an episode that exists.
 */
export function isUnaired(airDate: string | null, now: Date = new Date()): boolean {
  if (!airDate) return false;
  return airDate > isoDay(now);
}

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * `2026-03-12` → `12 Mar 2026`.
 *
 * Deliberately not `toLocaleDateString`: this string is produced on the client
 * from data fetched on the client, and a locale-dependent render is a
 * hydration mismatch waiting for the first user whose machine disagrees with
 * the server's.
 */
export function formatAirDate(airDate: string | null): string | null {
  if (!airDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(airDate);
  if (!match) return null;
  const [, year, month, day] = match;
  const index = Number.parseInt(month, 10) - 1;
  if (index < 0 || index > 11) return null;
  return `${Number.parseInt(day, 10)} ${MONTHS[index]} ${year}`;
}

/** `48` → `48 min`. Null for anything that is not a real runtime. */
export function formatRuntime(minutes: number | null): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return `${Math.round(minutes)} min`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
