/**
 * Remote-session expiry signal, kept free of React so `use-api-query` can
 * report into it without importing the provider (which itself uses the hook).
 *
 * Only a tunnel session can expire: Cloudflare Access answers an expired
 * session with a redirect to its sign-in page. For `fetch` that is either a
 * followed redirect (`res.redirected`) or, because the redirect is
 * cross-origin, a rejected fetch — which is only reported after
 * {@link confirmSessionExpiry} rules out an ordinary network failure. On the
 * local listener none of this means "signed out", so nothing is reported.
 */

export type SessionVia = "local" | "tunnel";

let currentVia: SessionVia | null = null;
let expired = false;
const listeners = new Set<() => void>();

export function setSessionVia(via: SessionVia | null): void {
  currentVia = via;
}

export function sessionVia(): SessionVia | null {
  return currentVia;
}

export function isSessionExpired(): boolean {
  return expired;
}

export function subscribeSessionExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const listener of listeners) listener();
}

/** A successful `/api/me` proves the session is alive again (e.g. signed in in another tab). */
export function clearSessionExpired(): void {
  if (!expired) return;
  expired = false;
  for (const listener of listeners) listener();
}

function isApiUrl(url: string): boolean {
  try {
    const origin =
      typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * Inspects one `/api` response and reports an expired remote session. Returns
 * true when it did, so the caller can show that instead of a generic error.
 * A 401 marked `misconfigured` (settings or key outage) is not expiry:
 * reloading cannot fix it, so it is left to surface as a normal error.
 */
export function detectSessionExpiry(
  url: string,
  outcome: { response: Response },
): boolean {
  if (currentVia !== "tunnel" || !isApiUrl(url)) return false;
  const { response } = outcome;
  const expiredNow =
    response.redirected ||
    (response.status === 401 &&
      response.headers.get("X-TorrentFlow-Auth") === "required");
  if (expiredNow) reportSessionExpired();
  return expiredNow;
}

/**
 * A rejected `fetch` on the tunnel is ambiguous: Cloudflare's cross-origin
 * sign-in redirect looks exactly like a phone going offline or cloudflared
 * restarting. Offline is ruled out directly; otherwise `/api/me` is asked with
 * `redirect: "manual"`, where only a real sign-in redirect comes back as an
 * `opaqueredirect`.
 */
export async function confirmSessionExpiry(
  url: string,
  error: unknown,
): Promise<boolean> {
  if (currentVia !== "tunnel" || !isApiUrl(url)) return false;
  if (!(error instanceof TypeError)) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const probe = await fetch("/api/me", {
      redirect: "manual",
      cache: "no-store",
    });
    const expiredNow =
      probe.type === "opaqueredirect" ||
      (probe.status === 401 &&
        probe.headers.get("X-TorrentFlow-Auth") === "required");
    if (expiredNow) reportSessionExpired();
    return expiredNow;
  } catch {
    return false;
  }
}

/**
 * `fetch` for same-origin `/api` calls made outside `useApiQuery`: throws
 * {@link SESSION_EXPIRED_MESSAGE} when the remote session has expired.
 */
export async function sessionAwareFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if ((err as Error)?.name !== "AbortError" && (await confirmSessionExpiry(url, err))) {
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    throw err;
  }
  if (detectSessionExpiry(url, { response: res })) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  return res;
}

export const SESSION_EXPIRED_MESSAGE =
  "Your remote session expired. Reload to sign in again.";
