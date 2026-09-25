/**
 * What the Library says when you press the bin.
 *
 * ## The defect this fixes
 *
 * The dialog used to read: *"'X' will be removed from your library. This does
 * not affect your torrent client."* Both halves were a problem.
 *
 * The first is what a person reads when a trash icon is involved, and the icon
 * has already told them "destroy". Nothing in that sentence says the 40 GB of
 * episodes they downloaded survive, so the safe reading — the one a careful
 * user makes — is that they do not, and the control becomes unusable for its
 * actual purpose: *stop following this show*.
 *
 * The second was a claim about the wrong system. "Your torrent client" is
 * TorrentFlow's own built-in engine for almost every install, so the sentence
 * either meant nothing or meant the opposite of the truth.
 *
 * ## The invariant
 *
 * Removing a title from the Library stops tracking and keeps every file. That
 * is the product rule (`DELETE /api/watchlist` promotes the title's streams to
 * kept before it removes the row, precisely so this promise holds), and this
 * copy is the only place the user is told about it. If the behaviour ever
 * changes, this string has to change with it — which is why it is a tested
 * export and not a literal buried in a 1000-line page.
 */

export interface RemoveFromLibraryCopy {
  /** Dialog heading. */
  title: string;
  /** The sentence that has to carry the promise. */
  body: string;
  /**
   * The confirm button.
   *
   * It states the outcome rather than repeating the verb. A button labelled
   * only "Remove" beside a red trash icon is read as "delete everything", and a
   * user who is unsure will cancel — which is the failure mode this whole file
   * exists to end.
   */
  confirmLabel: string;
}

export function removeFromLibraryCopy(
  title: string | null | undefined,
): RemoveFromLibraryCopy {
  const name = (title ?? "").trim();
  // A row with no usable title still has to be removable, and quoting an empty
  // string produces `“”`, which reads as a rendering bug.
  const subject = name ? `“${name}”` : "This title";
  return {
    title: "Remove from library?",
    body:
      `${subject} leaves your library and TorrentFlow stops looking for new ` +
      `episodes. Downloaded files are kept — nothing is removed from your disk. ` +
      `To remove the files too, use “Delete files” under More options before you ` +
      `remove the title.`,
    confirmLabel: "Remove, keep files",
  };
}
