/**
 * A link to one download on the Downloads page, as a notification's "View
 * details" writes it: `/downloads?hash=<info hash>`, or, for notifications
 * written before they recorded a hash, `/downloads?release=<release name>`.
 */
export interface DownloadLink {
  hash: string | null;
  release: string | null;
}

const LINK_PARAMS = ["hash", "release"] as const;

export function downloadLinkFrom(params: URLSearchParams): DownloadLink | null {
  const hash = params.get("hash")?.trim().toLowerCase() || null;
  const release = params.get("release") || null;
  return hash || release ? { hash, release } : null;
}

/** Identifies a link, so the page acts on each one once. */
export function downloadLinkKey(link: DownloadLink): string {
  return `${link.hash ?? ""}\n${link.release ?? ""}`;
}

/** The download a link points at, or null when it is no longer in the list. The hash wins when both are given. */
export function findLinkedDownload<T extends { hash: string; name: string }>(
  rows: readonly T[],
  link: DownloadLink,
): T | null {
  if (link.hash) return rows.find((row) => row.hash.toLowerCase() === link.hash) ?? null;
  return rows.find((row) => row.name === link.release) ?? null;
}

/** The same address without the link, once the page has acted on it. */
export function withoutDownloadLink(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of LINK_PARAMS) next.delete(name);
  return next;
}
