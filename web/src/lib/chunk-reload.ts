const RELOAD_KEY = "tf:chunk-reload-at";
const RELOAD_WINDOW_MS = 10_000;

/** True for the errors browsers throw when a page chunk from an older build is gone. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

/**
 * The app was updated while this tab was open, so its page chunks moved.
 * Reloads once to pick up the new build. Returns false when a reload already
 * happened moments ago, so a real outage shows an error instead of looping.
 */
export function reloadForNewBuild(href?: string): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < RELOAD_WINDOW_MS) return false;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  if (href) window.location.assign(href);
  else window.location.reload();
  return true;
}
