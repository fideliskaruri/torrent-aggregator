export type EpisodeListLoadState =
  | { status: "ready" }
  | { status: "loading" }
  | { status: "error"; message: string };

export const EMPTY_EPISODES_COPY =
  "No episodes known yet. Nothing here has been searched or downloaded, so there is no episode list to show. Use the button above to get the next one.";

const SKELETON_ROWS = 5;

export type EpisodeListView =
  | { kind: "loading"; skeletonRows: number }
  | { kind: "empty"; copy: typeof EMPTY_EPISODES_COPY }
  | { kind: "error"; message: string }
  | { kind: "rows" };

export function episodeListView(
  state: EpisodeListLoadState,
  rowCount: number,
): EpisodeListView {
  if (rowCount > 0) {
    return { kind: "rows" };
  }
  if (state.status === "loading") {
    return { kind: "loading", skeletonRows: SKELETON_ROWS };
  }
  if (state.status === "error") {
    return { kind: "error", message: state.message };
  }
  return { kind: "empty", copy: EMPTY_EPISODES_COPY };
}

/**
 * Is an extras request for the season the user is looking at actually
 * outstanding?
 *
 * The episode panel used to treat "extras do not describe the active season"
 * as loading, full stop. That is only honest while a request for that season
 * is in flight (or about to be). The extras URL is built from the *page's*
 * season, which falls back only to the detail payload's season, while the
 * panel additionally falls back to the first merged (provider) season — so a
 * page that requested no season at all could answer `season: null` forever
 * while the panel showed Season 1. Nothing further was ever requested, no
 * error was set, and the skeleton stayed on screen permanently.
 *
 * Pending means one of:
 *  - the hook says a fetch is running (`loading` / `refreshing`), or
 *  - the request was built for this very season, that request has **not
 *    settled yet** (`extrasSettled` false), and the data on hand still answers
 *    a different season — the gap between the URL changing and the hook
 *    flipping its flags, which is what keeps a season switch from flashing
 *    the empty copy.
 *
 * Anything else — notably a request built for a *different* (or no) season —
 * is terminal: render the honest empty/provider state instead of loading
 * forever.
 *
 * Two further permanent-skeleton paths this closes:
 *
 *  - **Specials (season 0).** The season tabs allow 0, but the extras route
 *    refuses it ("specials are not season one") and answers the first real
 *    season instead. Requested and active would both be 0 while the response
 *    can never describe 0, so the season comparison alone stayed pending
 *    forever. A season the extras endpoint cannot answer is never inferred as
 *    pending; S00 shows whatever the local payload holds, or the honest empty
 *    copy.
 *  - **Signed-out / unauthorized extras.** `useApiQuery`'s
 *    `emptyOnUnauthorized` settles with `data: null`, `error: null`,
 *    `loading: false` — a state indistinguishable from "not started" by data
 *    alone. `extrasSettled` is the positive signal that a request really is
 *    outstanding, so a settled empty answer is terminal, not a skeleton.
 */
export function extrasRequestPending({
  activeSeason,
  requestedSeason,
  extrasDescribeActiveSeason,
  extrasLoading,
  extrasRefreshing,
  extrasSettled,
}: {
  activeSeason: number | null;
  requestedSeason: number | null;
  extrasDescribeActiveSeason: boolean;
  extrasLoading: boolean;
  extrasRefreshing: boolean;
  /** Has the request for the URL currently being asked for finished? */
  extrasSettled: boolean;
}): boolean {
  if (extrasLoading || extrasRefreshing) return true;
  if (activeSeason == null) return false;
  if (!extrasCanAnswerSeason(activeSeason)) return false;
  if (extrasSettled) return false;
  return requestedSeason === activeSeason && !extrasDescribeActiveSeason;
}

/**
 * Seasons the extras endpoint is able to answer for.
 *
 * Mirrors the route's own rule (`season != null && season >= 1`): season 0 —
 * Specials — is never described by the provider lookup, so the panel must not
 * wait on an answer that can never come.
 */
export function extrasCanAnswerSeason(season: number | null): boolean {
  return season != null && Number.isFinite(season) && season >= 1;
}

export function episodeSeasonSummary(
  season: number,
  rowCount: number,
  state: EpisodeListLoadState,
): string {
  if (state.status === "loading" && rowCount === 0) {
    return `Loading season ${season}`;
  }
  if (state.status === "error" && rowCount === 0) {
    return `Could not load season ${season}`;
  }
  return rowCount > 0 ? `${rowCount} in season ${season}` : `Season ${season}`;
}

/**
 * Count label for the season toolbar, where the season is already named by the
 * select. Avoids "Season 1 · 7 in season 1".
 */
export function episodeSeasonCountLabel(
  rowCount: number,
  state: EpisodeListLoadState,
  season: number,
): string {
  if (state.status === "loading" && rowCount === 0) {
    // No visible count label while loading; the skeleton region carries the
    // busy state. The toolbar caller guards on truthiness, so "" renders
    // nothing.
    return "";
  }
  if (state.status === "error" && rowCount === 0) {
    return `Could not load season ${season}`;
  }
  if (rowCount <= 0) return "No episodes yet";
  return rowCount === 1 ? "1 episode" : `${rowCount} episodes`;
}
