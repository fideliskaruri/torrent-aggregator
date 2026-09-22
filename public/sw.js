/**
 * TorrentFlow service worker — install shell only.
 *
 * TorrentFlow is a client for *your* server: search, metadata, transfers and
 * playback all require it. So this worker deliberately does NOT try to make
 * the app work offline. Its entire job is:
 *
 *   1. make the app installable, and
 *   2. replace the browser's "no internet" error page with a shell that says
 *      the server is unreachable and offers a retry.
 *
 * Everything else is passed straight to the network. In particular it never
 * touches:
 *   - non-GET requests (every mutation),
 *   - `/api/*` (private data, transfer state, credentials) and `/auth/*`,
 *   - any request carrying a `Range` header, or a media/HLS destination —
 *     caching or even reconstructing those breaks seeking and streaming,
 *   - Next's RSC payloads (`?_rsc=`, `RSC: 1`, `text/x-component`) — a stale
 *     flight response renders a stale page with no way to notice,
 *   - `/_next/*` build output — chunk hashes change per build and a stale
 *     chunk cached here would outlive the deploy that produced it,
 *   - cross-origin requests (artwork CDNs, indexers).
 *
 * It also never calls `skipWaiting()` on its own. An update that activates
 * under a page that is streaming would be free to reload it; a new worker
 * waits until every tab is gone, unless the page explicitly asks.
 */

const CACHE_PREFIX = "torrentflow-shell-";
const CACHE_VERSION = "v1";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

/**
 * The complete list of things this worker is allowed to store. Public, static,
 * and small. Adding anything user-specific here is a bug.
 */
const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

const BYPASS_PREFIXES = ["/api/", "/auth/", "/_next/", "/downloads/"];

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

/** True when the request is an RSC/flight payload rather than a document. */
function isRscRequest(request, url) {
  if (url.searchParams.has("_rsc")) return true;
  if (headerValue(request, "RSC")) return true;
  const accept = headerValue(request, "Accept") || "";
  return accept.includes("text/x-component");
}

/**
 * Decide what to do with a request. Exported onto `self` for tests — the
 * routing policy is the part worth asserting, and it is much easier to assert
 * directly than through a stack of fake Cache objects.
 *
 * @returns {"bypass"|"navigate"|"shell"}
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
  if (isRscRequest(request, url)) return "bypass";

  const pathname = url.pathname;
  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return "bypass";
  }
  if (MEDIA_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext))) {
    return "bypass";
  }

  if (request.mode === "navigate") return "navigate";
  if (SHELL_ASSETS.includes(pathname)) return "shell";
  return "bypass";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch((error) => {
        // A failed precache must not leave a half-installed worker claiming to
        // serve an offline page it does not have.
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
  // Only ever activates early when a page explicitly asks for it.
  if (event.data && event.data.type === "TORRENTFLOW_SKIP_WAITING") {
    self.skipWaiting();
  }
});

async function handleNavigate(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
    if (cached) return cached;
    console.error("[sw] offline shell missing", error);
    return new Response(
      "TorrentFlow cannot reach your server, and the offline shell is not cached.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }
}

async function handleShellAsset(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (route === "bypass") return;
  if (route === "navigate") {
    event.respondWith(handleNavigate(event.request));
    return;
  }
  event.respondWith(handleShellAsset(event.request));
});

// Test surface. Intentionally the only thing this worker exposes.
self.torrentflowServiceWorker = {
  CACHE_NAME,
  CACHE_PREFIX,
  OFFLINE_URL,
  SHELL_ASSETS,
  routeFor,
  handleNavigate,
};
