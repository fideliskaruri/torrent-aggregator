/**
 * "Find another source": replace a download with a different release of the
 * same film or episode (docs/audio-language-plan.md, section 6). Downloads and
 * the title page offer it under one name and by one rule, both kept here.
 * Owner only: callers show it only where the viewer can download.
 */

/** The action's one name, for menu items, buttons, aria-labels and the dialog title. */
export const FIND_ANOTHER_SOURCE_LABEL = "Find another source";

/**
 * Whether the server can replace a finished download, keeping the current
 * files until the new source is ready. Until that lands it answers 409 for a
 * finished download, so only unfinished ones offer the action. Flip to true
 * when the server's deferred swap ships (plan section 6.4.4).
 */
export const FINISHED_SWAP_ENABLED = false;

export interface SourceSwapFacts {
  /** TorrentFlow's own download engine holds it; another app's downloads can't be replaced. */
  builtin: boolean;
  /** The download's info hash; there is nothing to replace without one. */
  hash: string | null | undefined;
  /** A season pack row, or an episode held only inside a season pack. */
  pack: boolean;
  /** Finished as the server counts it: downloaded, or its progress reached 100%. */
  finished: boolean;
}

/** Whether to offer Find another source. The server checks again, and the dialog shows any refusal. */
export function canFindAnotherSource(facts: SourceSwapFacts): boolean {
  if (!facts.builtin || facts.pack || !facts.hash?.trim()) return false;
  return FINISHED_SWAP_ENABLED || !facts.finished;
}
