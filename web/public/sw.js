/**
 * TorrentFlow service worker — install shell only.
 *
 * Caches the app shell: navigations resolve network-first (falling back to a
 * cached index.html), and hashed /assets/* resolve cache-first. Everything
 * else — especially /api/*, Range/stream requests and media — is left alone.
 *
 * Cache policy predicates live in web/src/lib/pwa/sw-cache-rules.ts for tests;
 * keep the two in lockstep when changing rules.
 */

const CACHE_PREFIX = "torrentflow-shell-";
const CACHE_VERSION = "v2";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const SHELL_URL = "/index.html";

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
const MEDIA_DESTINATIONS = ["video", "audio", "track"];

function headerValue(request, name) {
  try {
    return request.headers && request.headers.get
      ? request.headers.get(name)
      : null;
  } catch {
    return null;
  }
}

function isAppAssetPath(pathname) {
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

/**
 * @returns {"bypass"|"navigate"|"asset"}
 */
function routeFor(request, scopeOrigin) {
  if (request.method !== "GET") return "bypass";

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== scopeOrigin) return "bypass";
  if (headerValue(request, "Range")) return "bypass";
  if (MEDIA_DESTINATIONS.includes(request.destination)) return "bypass";

  const pathname = url.pathname;
  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "bypass";
  if (MEDIA_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext))) {
    return "bypass";
  }

  if (request.mode === "navigate" || pathname === "/" || pathname === "/index.html") {
    return "navigate";
  }
  if (isAppAssetPath(pathname)) return "asset";
  return "bypass";
}

/** True when the response may be stored in the shell cache. */
function shouldCache(urlString, init) {
  const route = routeFor(
    {
      url: urlString,
      method: (init && init.method) || "GET",
      mode: init && init.mode,
      destination: init && init.destination,
      headers: init && init.headers,
    },
    self.location.origin,
  );
  return route === "asset";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(SHELL_URL))
      .catch((error) => {
        console.error("[sw] shell precache failed", error);
        throw error;
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "TORRENTFLOW_SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function handleNavigate(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_URL, { cacheName: CACHE_NAME });
    if (cached) return cached;
    console.error("[sw] shell missing offline", error);
    return new Response(
      "TorrentFlow cannot reach your server, and the app shell is not cached.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }
}

async function handleAsset(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (route === "bypass") return;
  if (route === "navigate") {
    event.respondWith(handleNavigate(event.request));
    return;
  }
  event.respondWith(handleAsset(event.request));
});

self.torrentflowServiceWorker = {
  CACHE_NAME,
  CACHE_PREFIX,
  SHELL_URL,
  routeFor,
  shouldCache,
  handleNavigate,
};
