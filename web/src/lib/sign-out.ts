/**
 * Signing out of a remote session.
 *
 * TorrentFlow has no sign-in of its own: Cloudflare Access holds the session in
 * its `CF_Authorization` cookie, and its logout page on this host clears it. The
 * next visit shows the Access sign-in, where another email can be used.
 *
 * The app keeps no cookie or token of its own. What it does keep per tab is
 * sessionStorage (the owner's "View as requester" preview, the last automation
 * summary), which belongs to the person who is leaving, so it is cleared first.
 * The service worker never caches `/api/*` or `/cdn-cgi/*`, so no identity
 * survives in its cache.
 */
export const SIGN_OUT_URL = "/cdn-cgi/access/logout";

export function signOut(): void {
  try {
    window.sessionStorage.clear();
  } catch {
    // Storage blocked: nothing was stored either.
  }
  window.location.assign(SIGN_OUT_URL);
}
