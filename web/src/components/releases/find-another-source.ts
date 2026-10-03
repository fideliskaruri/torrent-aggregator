/** The action's one name for menus, buttons and accessible labels. */
export const FIND_ANOTHER_SOURCE_LABEL = "Find another";

export interface FindAnotherFacts {
  /** TorrentFlow's own download engine holds it; another app's downloads cannot be reset here. */
  builtin: boolean;
  /** The download's info hash; there is nothing to restart without one. */
  hash: string | null | undefined;
  /** A season pack row, or an episode held only inside a season pack. */
  pack: boolean;
  /** Finished as the server counts it: downloaded, or its progress reached 100%. */
  finished: boolean;
}

/** Whether a row can discard its unfinished built-in download and search again. */
export function canFindAnotherSource(facts: FindAnotherFacts): boolean {
  if (!facts.builtin || facts.pack || !facts.hash?.trim()) return false;
  return !facts.finished;
}
