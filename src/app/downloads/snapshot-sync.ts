/**
 * How the /downloads page is allowed to react to a torrent-list snapshot.
 *
 * Three rules the page depends on, kept pure here so they can be tested
 * without a browser and so the page cannot quietly regress them:
 *
 *  - **A failed read is not evidence of an empty client.** The 5s poll runs
 *    against a laptop that sleeps, a Wi-Fi drop, a dev server restarting.
 *    Blanking the list on any of those tells the user their downloads are
 *    gone, force-closes an open series dialog and announces a deletion that
 *    never happened. A failure surfaces an error and *keeps the last good
 *    data*; only a successful read replaces it — including replacing it with
 *    nothing, since failure bodies carry an empty `torrents: []` that must
 *    not be mistaken for proof the client is empty.
 *  - **Only an authoritative snapshot may auto-close the series dialog.** The
 *    dialog closes itself when its series really disappears (deleted). A
 *    quiet network failure must never trigger that path, so the close is
 *    gated on the last applied snapshot having actually succeeded.
 *  - **Older responses never overwrite newer ones.** Loads, polls and
 *    post-action refreshes race; a slow poll that started before a delete can
 *    land after the refresh that followed it and resurrect the deleted rows.
 *    Each request takes a monotonic generation and a response is applied only
 *    if it is at least as new as the newest already applied.
 */

/** Everything a snapshot is allowed to change on the page. */
export interface SnapshotState<T> {
  torrents: T[];
  error: string | null;
  offline: boolean;
  /** The last applied snapshot was a complete, successful read of the client. */
  authoritative: boolean;
}

export type SnapshotResult<T> =
  | { ok: true; torrents: T[] }
  /** The request completed but the client is unreachable / errored. */
  | { ok: false; error: string; offline: boolean; torrents?: T[] }
  /** The request itself failed (network, bad JSON, aborted). */
  | { ok: false; error: string; offline?: undefined; torrents?: undefined };

export function emptySnapshotState<T>(): SnapshotState<T> {
  return { torrents: [], error: null, offline: false, authoritative: false };
}

/**
 * Fold a snapshot result into the page state. A success is authoritative and
 * replaces the rows; a failure keeps the last good rows and marks the state
 * non-authoritative so nothing downstream treats "we could not look" as "it
 * is not there".
 */
export function applySnapshot<T>(
  prev: SnapshotState<T>,
  result: SnapshotResult<T>,
): SnapshotState<T> {
  if (result.ok) {
    return { torrents: result.torrents, error: null, offline: false, authoritative: true };
  }
  // An offline/errored client can still report rows it knows about; prefer
  // those. But a failure list is never authoritative emptiness: our own API
  // ships `torrents: []` on every failure body (400/500 and the 502/503
  // client-unreachable branch), so `result.torrents ?? prev.torrents` would
  // still wipe the last good rows and force-close the series dialog on a
  // sleeping laptop. An absent *or empty* failure list means "we could not
  // look", which is exactly when the last good list is the honest thing to
  // show. Only a successful read may empty the page.
  const reported = result.torrents;
  const torrents = reported && reported.length > 0 ? reported : prev.torrents;
  return {
    torrents,
    error: result.error,
    offline: Boolean(result.offline),
    authoritative: false,
  };
}

/**
 * Whether a response carrying generation `seq` may be applied, given the
 * newest generation already applied. Equal generations are allowed so a
 * single request can commit in more than one step.
 */
export function shouldApplySnapshot(seq: number, latestApplied: number): boolean {
  return seq >= latestApplied;
}

/**
 * Whether the open series dialog should close because its group is gone.
 * Requires proof: an open key, no group in the current derivation, and a last
 * snapshot that actually succeeded.
 */
export function shouldCloseMissingGroup(input: {
  openKey: string | null;
  groupFound: boolean;
  authoritative: boolean;
}): boolean {
  return Boolean(input.openKey) && !input.groupFound && input.authoritative;
}

/**
 * Select-all reflects the rows the user can actually see. Set-size equality
 * is wrong here because the series dialog writes into the *same* selection
 * set from rows the page's filters hide — three episodes checked inside a
 * dialog can equal the count of two visible rows and light up "all selected"
 * for a page where nothing is checked.
 */
export function areAllVisibleSelected(
  visibleHashes: readonly string[],
  selected: ReadonlySet<string>,
): boolean {
  return visibleHashes.length > 0 && visibleHashes.every((hash) => selected.has(hash));
}

/**
 * Toggling select-all only ever adds or removes the visible rows — selections
 * made inside the dialog for hidden rows are left alone.
 */
export function toggleVisibleSelection(
  visibleHashes: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (areAllVisibleSelected(visibleHashes, selected)) {
    for (const hash of visibleHashes) next.delete(hash);
    return next;
  }
  for (const hash of visibleHashes) next.add(hash);
  return next;
}
