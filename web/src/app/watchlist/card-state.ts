/**
 * What a library card says about where a title stands.
 *
 * The Library used to answer this with a status chip filter — you filtered to
 * "Watching" to find the things you were watching. That put the answer one
 * interaction away from the question, and it only ever answered one of the two
 * things a person actually wants to know when they look at a library row:
 *
 *   1. Where am I in this?          ("S02E06")
 *   2. Is anything happening to it?  ("Downloading S02E07", "New episode")
 *
 * The second is the one the old page could not answer at all. A monitored show
 * with a new episode waiting looked exactly like a monitored show with nothing
 * to do, so the only way to find out was to open each one.
 *
 * These are deliberately two separate lines rather than one merged sentence.
 * Position is durable and slow-moving; activity is transient. Folding them
 * together produces copy like "Watching S02E06, downloading S02E07" that has
 * to be re-read to be parsed, and that goes stale in one of its halves.
 */

export interface LibraryCardRow {
  status: string;
  monitored?: boolean;
  /** Where the hunt cursor sits, when the show is monitored. */
  cursorSeason?: number | null;
  cursorEpisode?: number | null;
  /** The most recent episode we know about, already formatted (`S02E06`). */
  lastEpisode: string | null;
  /** A release the automation has found but not yet acted on. */
  nextEpisodeHint: string | null;
}

/** `S02E06`, or null when either half is unknown. */
function formatEpisode(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null || episode == null) return null;
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  const pad = (n: number) => String(Math.trunc(n)).padStart(2, "0");
  return `S${pad(season)}E${pad(episode)}`;
}

/**
 * Line one: where the user is.
 *
 * The last episode we hold beats the hunt cursor. The cursor says what the app
 * is *looking for*, which is one episode ahead of where the viewer actually
 * is — reporting it as position would tell someone who just finished S02E06
 * that they are on S02E07, which they have not seen and may not exist yet.
 */
export function positionLine(row: LibraryCardRow): string | null {
  if (row.lastEpisode?.trim()) return row.lastEpisode.trim();
  const cursor = formatEpisode(row.cursorSeason, row.cursorEpisode);
  // No held episode, but a cursor: the show is tracked and waiting for its
  // first match. Say that rather than claiming a position.
  return cursor ? `Waiting for ${cursor}` : null;
}

type ActivityKind = "update" | "tracking" | "paused" | null;

export interface ActivityLine {
  kind: ActivityKind;
  text: string;
}

/**
 * Line two: what, if anything, is happening.
 *
 * Ordered by what the user can act on:
 *
 *  - A found release is news and outranks everything.
 *  - Otherwise, monitoring is a promise the app is keeping; say it quietly.
 *  - A monitored-off show says so, because silence from a library row is
 *    otherwise indistinguishable from silence from a broken one.
 *  - A finished or abandoned show gets nothing. There is nothing to say, and
 *    a line saying "nothing to report" is worse than no line.
 */
export function activityLine(row: LibraryCardRow): ActivityLine | null {
  const status = row.status.trim().toLowerCase();

  const hint = row.nextEpisodeHint?.trim();
  if (hint) return { kind: "update", text: hint };

  // A completed or dropped show is not waiting for anything, so monitoring
  // state is not news about it.
  if (status === "completed" || status === "dropped") return null;

  if (row.monitored === false) return { kind: "paused", text: "Not tracking" };

  const cursor = formatEpisode(row.cursorSeason, row.cursorEpisode);
  if (row.monitored) {
    return {
      kind: "tracking",
      text: cursor ? `Tracking · next ${cursor}` : "Tracking",
    };
  }

  return null;
}

/**
 * Does this row want attention?
 *
 * Only a found release qualifies. "Tracking" is the app doing its job, and
 * highlighting every monitored show would make the highlight meaningless —
 * the same mistake the old Activity feed made at page scale.
 */
export function needsAttention(row: LibraryCardRow): boolean {
  return activityLine(row)?.kind === "update";
}
