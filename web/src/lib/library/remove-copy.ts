export interface RemoveFromLibraryCopy {
  /** Dialog heading. */
  title: string;
  /** The sentence that has to carry the promise. */
  body: string;
  /** Names the destructive outcome before the owner confirms it. */
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
      `${subject} leaves your library and TorrentFlow stops looking for it. ` +
      `Any files for this title are deleted from your disk. This cannot be undone.`,
    confirmLabel: "Remove and delete files",
  };
}
