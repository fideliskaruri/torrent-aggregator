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
  | { kind: "rows"; dim: boolean };

export function episodeListView(
  state: EpisodeListLoadState,
  rowCount: number,
): EpisodeListView {
  if (rowCount > 0) {
    return { kind: "rows", dim: state.status === "loading" };
  }
  if (state.status === "loading") {
    return { kind: "loading", skeletonRows: SKELETON_ROWS };
  }
  if (state.status === "error") {
    return { kind: "error", message: state.message };
  }
  return { kind: "empty", copy: EMPTY_EPISODES_COPY };
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
    return `Loading season ${season}…`;
  }
  if (state.status === "error" && rowCount === 0) {
    return `Could not load season ${season}`;
  }
  if (rowCount <= 0) return "No episodes yet";
  return rowCount === 1 ? "1 episode" : `${rowCount} episodes`;
}
