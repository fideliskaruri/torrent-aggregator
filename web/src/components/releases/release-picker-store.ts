/**
 * "Pick a release yourself" can be offered from anywhere a grab failed: a
 * title page toast, a request row, the activity log. They all open the one
 * dialog mounted by `ReleasePickerHost`, through this tiny store.
 */
export interface ReleasePickTarget {
  workKey: string;
  title: string;
  season?: number | null;
  episode?: number | null;
  /** The search we used; the dialog starts from it. The server's default is used when absent. */
  query?: string | null;
  /** Set when the pick is for a request, so the transfer joins that request. */
  requestId?: string | null;
  /** Called after a release started, e.g. to refresh the page that offered the pick. */
  onPicked?: () => void;
}

export const PICK_RELEASE_LABEL = "Pick a release yourself";

type Listener = (target: ReleasePickTarget) => void;
const listeners = new Set<Listener>();

export function openReleasePicker(target: ReleasePickTarget): void {
  for (const listener of listeners) listener(target);
}

export function subscribeReleasePicker(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A toast button that opens the picker; the toast closes as the dialog opens. */
export function pickReleaseToastButton(target: ReleasePickTarget) {
  return { label: PICK_RELEASE_LABEL, onClick: () => openReleasePicker(target) };
}

/**
 * Toast classes for any toast carrying the pick button (alone or beside Retry):
 * on a phone the buttons wrap under the message instead of squeezing it.
 */
export const PICK_TOAST_CLASSNAMES = {
  toast: "max-sm:flex-wrap",
  content: "max-sm:basis-[calc(100%-2.5rem)]!",
  actionButton: "max-sm:ml-8! max-sm:min-h-11 max-sm:px-4!",
  cancelButton: "max-sm:min-h-11 max-sm:px-4!",
} as const;

/** Plain words for what the picker is for: "Haibane Renmei, season 1, episode 8". */
export function releasePickSubject(target: Pick<ReleasePickTarget, "title" | "season" | "episode">): string {
  if (target.season != null && target.episode != null) {
    return `${target.title}, season ${target.season}, episode ${target.episode}`;
  }
  if (target.season != null) return `${target.title}, season ${target.season}`;
  return target.title;
}
