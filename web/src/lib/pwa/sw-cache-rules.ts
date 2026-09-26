/**
 * Service-worker cache policy as pure predicates.
 *
 * Kept out of `public/sw.js` so node tests can assert the rules without a
 * service-worker runtime. `sw.js` must stay in lockstep with these helpers —
 * if you change one, change the other.
 */

const API_PREFIXES = ["/api/", "/auth/"];
const MEDIA_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".webm",
  ".m4s",
  ".m4v",
  ".mov",
  ".avi",
  ".mp3",
  ".aac",
  ".m3u8",
  ".ts",
  ".vtt",
  ".srt",
];

export type CacheRoute = "bypass" | "navigate" | "asset";

export type RouteRequest = {
  url: string;
  method?: string;
  mode?: string;
  destination?: string;
  headers?: Record<string, string | undefined> | { get?: (name: string) => string | null };
};

function header(request: RouteRequest, name: string): string | null {
  const headers = request.headers;
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      return (headers as { get: (n: string) => string | null }).get(name);
    } catch {
      return null;
    }
  }
  const direct = (headers as Record<string, string | undefined>)[name]
    ?? (headers as Record<string, string | undefined>)[name.toLowerCase()];
  return direct ?? null;
}

/** True when this URL is a hashed Vite build asset under /assets/. */
export function isAppAssetPath(pathname: string): boolean {
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

/**
 * Whether the worker may put the response in the shell cache at all.
 * Only hashed /assets/* are stored long-term; navigations are network-first
 * and only refresh index.html as a side effect.
 */
export function shouldCache(urlString: string, init: Omit<RouteRequest, "url"> = {}): boolean {
  return routeFor({ url: urlString, ...init }, null) === "asset";
}

/**
 * Decide how the service worker handles a request.
 * `scopeOrigin` null skips the same-origin check (useful in unit tests).
 */
export function routeFor(request: RouteRequest, scopeOrigin: string | null): CacheRoute {
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET") return "bypass";

  let url: URL;
  try {
    url = new URL(request.url, scopeOrigin ?? "http://torrentflow.local");
  } catch {
    return "bypass";
  }

  if (scopeOrigin && url.origin !== scopeOrigin) return "bypass";
  if (header(request, "Range")) return "bypass";
  if (request.destination === "video" || request.destination === "audio" || request.destination === "track") {
    return "bypass";
  }

  const pathname = url.pathname;
  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "bypass";
  if (MEDIA_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext))) return "bypass";

  if (request.mode === "navigate" || pathname === "/" || pathname === "/index.html") {
    return "navigate";
  }
  if (isAppAssetPath(pathname)) return "asset";
  return "bypass";
}
