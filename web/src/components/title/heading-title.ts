/**
 * What the title page may print as its heading.
 *
 * When no catalog has answered yet, the server falls back to a prettified work
 * key, so a provider id like `tmdb:movie:550` arrives as "Tmdb:movie:550". That
 * is an identifier, not a name, and it must never reach the H1. Slug keys
 * ("the-quiet-2020" becomes "The Quiet 2020") read as names and pass through.
 */
const PROVIDER_KEY =
  /^(?:tmdb|anilist|tvmaze|cinemeta|itunes|imdb|tvdb|kitsu|mal|anidb|work)\s*:/i;

/** True for an empty title or one that is really a provider key or bare IMDb id. */
export function isProviderKeyTitle(raw: string | null | undefined): boolean {
  const title = (raw ?? "").trim();
  if (!title) return true;
  return PROVIDER_KEY.test(title) || /^tt\d{5,}$/i.test(title);
}

/**
 * The first human title on offer: the payload's, then the one the link carried.
 * Null means nothing printable is known yet, so the caller shows a skeleton
 * while metadata is still arriving and a neutral label once it has settled.
 */
export function headingTitle(
  payloadTitle: string | null | undefined,
  routeTitle: string | null | undefined,
): string | null {
  for (const candidate of [payloadTitle, routeTitle]) {
    if (!isProviderKeyTitle(candidate)) return (candidate ?? "").trim();
  }
  return null;
}
