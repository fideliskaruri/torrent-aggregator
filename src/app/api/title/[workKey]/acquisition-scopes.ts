/**
 * Sorting acquisition targets into the three scopes the title page reads.
 *
 * ## Why this is its own module
 *
 * The bug it exists to prevent lived in a Prisma `where` clause:
 * `scope: "episode"`. The detail route asked the database for episode targets
 * only, so a film the user had just sent — or a season pack halfway down —
 * came back with no transfer at all. The page, seeing nothing in flight,
 * offered Download beside a torrent the Client was actively fetching.
 *
 * A `where` clause cannot be unit-tested without a database, which is exactly
 * why that defect survived a green suite. The decision is now a pure function
 * over rows, so the rule can be pinned in the offline suite.
 *
 * ## The rule
 *
 * Three scopes, three separate answers, never merged. A season pack at 40%
 * says nothing about whether episode 3 is playable; a queued episode says
 * nothing about the work as a whole. Only the control that owns a scope may
 * read it.
 */

/** The shape this module needs. A superset arrives from Prisma. */
export interface ScopedTargetRow {
  scope: string;
  season: number | null;
  episode: number | null;
}

export interface ScopedTargets<T extends ScopedTargetRow> {
  /** The work itself: a film, or a whole-series grab. Newest wins. */
  title: T | null;
  /** Season-scoped grabs, keyed by season number. Newest wins. */
  seasons: Map<number, T>;
  /** Episode-scoped grabs, keyed `season:episode`. Newest wins. */
  episodes: Map<string, T>;
  /**
   * Rows whose `scope` and columns disagree, or whose scope is unknown.
   *
   * Returned rather than silently dropped: they still need reconciling against
   * the engine so a stale `downloading` claim does not persist forever, and a
   * caller that ignores them should be doing so on purpose.
   */
  malformed: T[];
}

/**
 * Bucket targets by scope, newest first.
 *
 * `rows` must already be ordered newest-first (the route queries
 * `orderBy: updatedAt desc`); the first row seen for a key wins, so an older
 * duplicate can never overwrite the current state.
 *
 * A row is malformed when its scope claims a precision its columns do not
 * carry — a `season` target with no season names nothing actionable. Such a
 * row is never widened into a claim about the whole work, because widening is
 * how "one episode is queued" silently becomes "the series is queued".
 */
export function bucketTargetsByScope<T extends ScopedTargetRow>(
  rows: readonly T[],
): ScopedTargets<T> {
  const result: ScopedTargets<T> = {
    title: null,
    seasons: new Map(),
    episodes: new Map(),
    malformed: [],
  };

  for (const row of rows) {
    switch (row.scope) {
      case "title":
        // A title target must not carry episode precision; if it does, the
        // writer disagreed with itself and we do not guess which half is true.
        if (row.season != null || row.episode != null) {
          result.malformed.push(row);
          break;
        }
        result.title ??= row;
        break;

      case "season":
        if (row.season == null || row.episode != null) {
          result.malformed.push(row);
          break;
        }
        if (!result.seasons.has(row.season)) result.seasons.set(row.season, row);
        break;

      case "episode": {
        if (row.season == null || row.episode == null) {
          result.malformed.push(row);
          break;
        }
        const key = `${row.season}:${row.episode}`;
        if (!result.episodes.has(key)) result.episodes.set(key, row);
        break;
      }

      default:
        // An unrecognised scope is data from a future or older writer. It is
        // not assumed to mean anything.
        result.malformed.push(row);
    }
  }

  return result;
}

/** The key {@link bucketTargetsByScope} files episode targets under. */
export function episodeTargetKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}
