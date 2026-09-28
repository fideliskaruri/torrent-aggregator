/**
 * Connection state for the installed app, fed by every same-origin `/api`
 * `fetch` (not only `useApiQuery`), so a dropped tunnel or an expired
 * Cloudflare Access sign-in becomes one clear banner instead of a page full of
 * broken lists and "Unexpected token '<'" errors.
 *
 * - "offline": the device says it has no network.
 * - "unreachable": the device is online but TorrentFlow didn't answer (the
 *   tunnel or the PC is down). A background probe reconnects on its own.
 * - Sign-in expiry is reported through `session-expiry` and shown by the
 *   session prompt; it is never shown as "unreachable".
 */
import {
  SESSION_EXPIRED_MESSAGE,
  confirmSessionExpiry,
  reportSessionExpired,
  sessionVia,
} from "@/lib/session-expiry";

export type ConnectionState = "online" | "offline" | "unreachable";

export const UNREACHABLE_MESSAGE =
  "Can't reach TorrentFlow right now. It will reconnect on its own.";

let state: ConnectionState = "online";
const listeners = new Set<() => void>();

export function connectionState(): ConnectionState {
  return state;
}

export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
  if (next === "online") stopProbe();
  else startProbe();
}

function isSameOriginApi(url: string): boolean {
  try {
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export type ApiResponseVerdict = "ok" | "sign-in" | "unreachable";

/**
 * What one `/api` response says about the connection. `/api` never answers
 * with HTML, so an HTML body is someone else talking: Cloudflare's sign-in
 * page (2xx/401/403 through the tunnel) or its "tunnel is down" page (5xx).
 */
export function classifyApiResponse(
  res: Pick<Response, "status" | "redirected"> & { headers: Pick<Headers, "get"> },
  via: "local" | "tunnel" | null,
): ApiResponseVerdict {
  if (res.status === 401 && res.headers.get("X-TorrentFlow-Auth") === "required") {
    return "sign-in";
  }
  const type = (res.headers.get("Content-Type") ?? "").toLowerCase();
  const html = type.includes("text/html");
  if (via === "tunnel" && res.redirected && html) return "sign-in";
  if (html && res.status >= 500) return "unreachable";
  if (html && via !== "local") return "sign-in";
  // Cloudflare's tunnel errors (502/504/52x/530) with no TorrentFlow JSON behind them.
  if (!type.includes("json") && (res.status === 502 || res.status === 504 || (res.status >= 520 && res.status <= 530))) {
    return "unreachable";
  }
  return "ok";
}

let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelay = 3_000;
let rawFetch: typeof fetch | null = null;

function stopProbe(): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  probeDelay = 3_000;
}

function startProbe(): void {
  if (probeTimer || typeof window === "undefined") return;
  probeTimer = setTimeout(() => void probeNow(), probeDelay);
}

/** Asks the server once; the banner's "Try now" calls this directly. */
export async function probeNow(): Promise<boolean> {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  const doFetch = rawFetch ?? fetch;
  try {
    const res = await doFetch("/api/me", { cache: "no-store", redirect: "manual" });
    if (res.type === "opaqueredirect") {
      reportSessionExpired();
      setState("online");
      return true;
    }
    const verdict = classifyApiResponse(res, sessionVia());
    if (verdict === "sign-in") {
      reportSessionExpired();
      setState("online");
      return true;
    }
    if (verdict === "ok") {
      setState("online");
      window.dispatchEvent(new Event("torrentflow:reconnected"));
      return true;
    }
  } catch {
    // Still down; fall through to the next attempt.
  }
  probeDelay = Math.min(probeDelay * 2, 30_000);
  if (state !== "online") startProbe();
  return false;
}

/** Wraps `window.fetch` once so every `/api` call feeds the connection state. */
export function installConnectionWatch(): void {
  if (typeof window === "undefined" || rawFetch) return;
  const original = window.fetch.bind(window);
  rawFetch = original;

  window.addEventListener("offline", () => setState("offline"));
  window.addEventListener("online", () => void probeNow());
  if (navigator.onLine === false) setState("offline");

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    // The expiry probe in session-expiry asks with redirect: "manual"; let it through untouched.
    if (!isSameOriginApi(url) || init?.redirect === "manual") return original(input, init);
    let res: Response;
    try {
      res = await original(input, init);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      if (await confirmSessionExpiry(url, err)) throw new Error(SESSION_EXPIRED_MESSAGE);
      setState(navigator.onLine === false ? "offline" : "unreachable");
      throw new Error(
        navigator.onLine === false
          ? "You're offline. TorrentFlow will reconnect when you're back online."
          : UNREACHABLE_MESSAGE,
      );
    }
    const verdict = classifyApiResponse(res, sessionVia());
    if (verdict === "sign-in") {
      reportSessionExpired();
      throw new Error(SESSION_EXPIRED_MESSAGE);
    }
    if (verdict === "unreachable") {
      setState("unreachable");
      throw new Error(UNREACHABLE_MESSAGE);
    }
    setState("online");
    return res;
  };
}
