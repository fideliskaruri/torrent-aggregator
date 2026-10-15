/**
 * The Downloads series row's tally line: `12 of 38 in your library · 3 downloading`.
 * Without a known total it drops the "of Y". Queued episodes, when counted
 * apart, follow as their own part. Null when nothing is downloaded or on its way.
 */
export interface SeasonProgress {
  downloaded: number;
  downloading: number;
  /** Waiting in the download queue, kept apart from `downloading` when known. */
  queued?: number;
  aired: number | null;
}

export function seasonProgressLabel(p: SeasonProgress): string | null {
  const total = p.aired != null && p.aired > 0 ? p.aired : null;
  const parts = [
    { count: p.downloaded, word: "in your library" },
    { count: p.downloading, word: "downloading" },
    { count: p.queued ?? 0, word: "queued" },
  ].filter((part) => part.count > 0);
  if (parts.length === 0) return null;
  return parts
    .map((part, index) =>
      index === 0 && total != null ? `${part.count} of ${total} ${part.word}` : `${part.count} ${part.word}`,
    )
    .join(" \u00b7 ");
}