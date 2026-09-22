/**
 * Behavioural tests for the install-shell service worker (`public/sw.js`).
 *
 * The worker is a classic script, not a module, so it is loaded into a `vm`
 * context with a fake `self`. That is deliberate: the routing policy is the
 * thing that can quietly turn dangerous (one careless prefix and the worker
 * starts serving a stale `/api/transfers`), and it is only meaningful to test
 * against the real file the browser downloads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  const done = (err?: unknown) => {
    if (err) {
      failures += 1;
      console.error(`  ✗ ${name}: ${(err as Error).message}`);
    } else {
      console.log(`  ✓ ${name}`);
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(() => done(), done);
    done();
  } catch (err) {
    done(err);
  }
  return Promise.resolve();
}

type Listeners = Record<string, ((event: unknown) => void)[]>;

type WorkerScope = {
  listeners: Listeners;
  internals: {
    CACHE_NAME: string;
    CACHE_PREFIX: string;
    OFFLINE_URL: string;
    SHELL_ASSETS: string[];
    routeFor: (request: unknown, origin: string) => string;
    handleNavigate: (request: unknown) => Promise<Response>;
  };
  caches: FakeCacheStorage;
  skipWaitingCalls: () => number;
  setFetch: (fn: (request: unknown) => Promise<Response>) => void;
};

class FakeCache {
  store = new Map<string, Response>();
  async addAll(urls: string[]) {
    for (const url of urls) this.store.set(url, new Response(`body:${url}`));
  }
  async match(key: string) {
    return this.store.get(key);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  deleted: string[] = [];
  async open(name: string) {
    const existing = this.caches.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.caches.set(name, created);
    return created;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
  async match(key: string, options?: { cacheName?: string }) {
    if (options?.cacheName) {
      return this.caches.get(options.cacheName)?.match(key);
    }
    for (const cache of this.caches.values()) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    return undefined;
  }
}

function loadWorker(): WorkerScope {
  const source = fs.readFileSync(
    path.join(process.cwd(), "public", "sw.js"),
    "utf8",
  );
  const listeners: Listeners = {};
  const cacheStorage = new FakeCacheStorage();
  let fetchImpl: (request: unknown) => Promise<Response> = async () =>
    new Response("network");
  let skipWaitingCalls = 0;

  const self: Record<string, unknown> = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    location: { origin: "http://127.0.0.1:3000" },
    clients: { claim: async () => undefined },
    skipWaiting: () => {
      skipWaitingCalls += 1;
    },
  };
  const sandbox: Record<string, unknown> = {
    self,
    caches: cacheStorage,
    console,
    Response,
    Request,
    URL,
    Promise,
    fetch: (request: unknown) => fetchImpl(request),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    listeners,
    internals: self.torrentflowServiceWorker as WorkerScope["internals"],
    caches: cacheStorage,
    skipWaitingCalls: () => skipWaitingCalls,
    setFetch: (fn) => {
      fetchImpl = fn;
    },
  };
}

/** Minimal request stand-in: the worker only reads these fields. */
function req(
  url: string,
  init: {
    method?: string;
    mode?: string;
    destination?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(init.headers ?? {});
  return {
    url,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
    destination: init.destination ?? "",
    headers,
  };
}

const ORIGIN = "http://127.0.0.1:3000";

async function main() {
  const worker = loadWorker();
  const { routeFor } = worker.internals;

  console.log("service worker: requests that must never be intercepted…");

  await check("POST to an API route is bypassed", () => {
    assert.equal(
      routeFor(req(`${ORIGIN}/api/transfers`, { method: "POST" }), ORIGIN),
      "bypass",
    );
  });

  await check("GET on /api/* is bypassed", () => {
    assert.equal(routeFor(req(`${ORIGIN}/api/downloads`), ORIGIN), "bypass");
    assert.equal(
      routeFor(req(`${ORIGIN}/api/auth/session`), ORIGIN),
      "bypass",
    );
  });

  await check("auth routes are bypassed", () => {
    assert.equal(routeFor(req(`${ORIGIN}/auth/signin`), ORIGIN), "bypass");
  });

  await check("range requests are bypassed", () => {
    assert.equal(
      routeFor(
        req(`${ORIGIN}/offline.html`, { headers: { Range: "bytes=0-1023" } }),
        ORIGIN,
      ),
      "bypass",
    );
  });

  await check("media destinations and media extensions are bypassed", () => {
    for (const destination of ["video", "audio", "track"]) {
      assert.equal(
        routeFor(req(`${ORIGIN}/stream/abc`, { destination }), ORIGIN),
        "bypass",
        destination,
      );
    }
    for (const file of ["/media/a.mp4", "/media/a.m3u8", "/media/seg.ts"]) {
      assert.equal(routeFor(req(ORIGIN + file), ORIGIN), "bypass", file);
    }
  });

  await check("Next RSC payloads are bypassed", () => {
    assert.equal(
      routeFor(req(`${ORIGIN}/downloads?_rsc=1a2b`, { mode: "navigate" }), ORIGIN),
      "bypass",
    );
    assert.equal(
      routeFor(
        req(`${ORIGIN}/downloads`, {
          mode: "navigate",
          headers: { RSC: "1" },
        }),
        ORIGIN,
      ),
      "bypass",
    );
    assert.equal(
      routeFor(
        req(`${ORIGIN}/downloads`, {
          mode: "navigate",
          headers: { Accept: "text/x-component" },
        }),
        ORIGIN,
      ),
      "bypass",
    );
  });

  await check("build output under /_next is bypassed", () => {
    assert.equal(
      routeFor(req(`${ORIGIN}/_next/static/chunks/main.js`), ORIGIN),
      "bypass",
    );
  });

  await check("cross-origin requests are bypassed", () => {
    assert.equal(
      routeFor(req("https://image.tmdb.org/t/p/w500/x.jpg"), ORIGIN),
      "bypass",
    );
  });

  await check("user-specific pages are not cached as assets", () => {
    assert.equal(routeFor(req(`${ORIGIN}/watchlist`), ORIGIN), "bypass");
    assert.equal(routeFor(req(`${ORIGIN}/settings`), ORIGIN), "bypass");
  });

  console.log("service worker: routes that are handled…");

  await check("document navigations use the navigate strategy", () => {
    assert.equal(
      routeFor(req(`${ORIGIN}/title/abc`, { mode: "navigate" }), ORIGIN),
      "navigate",
    );
  });

  await check("only the explicit shell assets are cache-served", () => {
    for (const asset of worker.internals.SHELL_ASSETS) {
      assert.equal(routeFor(req(ORIGIN + asset), ORIGIN), "shell", asset);
    }
    assert.equal(routeFor(req(`${ORIGIN}/health.json`), ORIGIN), "bypass");
  });

  console.log("service worker: failure paths…");

  await check("install precaches exactly the shell allowlist", async () => {
    const install = worker.listeners.install?.[0];
    assert.ok(install, "install listener registered");
    let waited: Promise<unknown> | undefined;
    install({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    const cache = worker.caches.caches.get(worker.internals.CACHE_NAME);
    assert.ok(cache, "own cache opened");
    assert.deepEqual(
      [...cache.store.keys()].sort(),
      [...worker.internals.SHELL_ASSETS].sort(),
    );
  });

  await check("a failed navigation serves the offline shell", async () => {
    worker.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const response = await worker.internals.handleNavigate(
      req(`${ORIGIN}/search`, { mode: "navigate" }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "body:/offline.html");
  });

  await check("a successful navigation is served from the network", async () => {
    worker.setFetch(async () => new Response("live page"));
    const response = await worker.internals.handleNavigate(
      req(`${ORIGIN}/search`, { mode: "navigate" }),
    );
    assert.equal(await response.text(), "live page");
  });

  await check(
    "offline navigation with no cached shell returns an explicit 503",
    async () => {
      const bare = loadWorker();
      bare.setFetch(async () => {
        throw new TypeError("Failed to fetch");
      });
      const response = await bare.internals.handleNavigate(
        req(`${ORIGIN}/search`, { mode: "navigate" }),
      );
      assert.equal(response.status, 503);
    },
  );

  await check("activate deletes only this worker's older caches", async () => {
    const scope = loadWorker();
    await scope.caches.open(`${scope.internals.CACHE_PREFIX}v0`);
    await scope.caches.open(scope.internals.CACHE_NAME);
    await scope.caches.open("some-other-app-cache");
    const activate = scope.listeners.activate?.[0];
    assert.ok(activate, "activate listener registered");
    let waited: Promise<unknown> | undefined;
    activate({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    assert.deepEqual(scope.caches.deleted, [
      `${scope.internals.CACHE_PREFIX}v0`,
    ]);
  });

  await check("skipWaiting only runs on an explicit message", async () => {
    const scope = loadWorker();
    const source = fs.readFileSync(
      path.join(process.cwd(), "public", "sw.js"),
      "utf8",
    );
    const occurrences = [...source.matchAll(/self\.skipWaiting\(\)/g)];
    assert.equal(
      occurrences.length,
      1,
      "skipWaiting appears exactly once, in the message handler",
    );
    const before = source.slice(
      Math.max(0, (occurrences[0].index ?? 0) - 300),
      occurrences[0].index,
    );
    assert.match(
      before,
      /TORRENTFLOW_SKIP_WAITING/,
      "skipWaiting is guarded by the explicit message",
    );
    assert.equal(scope.skipWaitingCalls(), 0, "nothing on load");

    const activate = scope.listeners.activate?.[0];
    assert.ok(activate, "activate listener registered");
    let waited: Promise<unknown> | undefined;
    activate({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    assert.equal(scope.skipWaitingCalls(), 0, "nothing on activate");

    const message = scope.listeners.message?.[0];
    assert.ok(message, "message listener registered");
    message({ data: { type: "SOMETHING_ELSE" } });
    assert.equal(scope.skipWaitingCalls(), 0, "ignores unrelated messages");
    message({ data: { type: "TORRENTFLOW_SKIP_WAITING" } });
    assert.equal(scope.skipWaitingCalls(), 1, "honours the explicit request");
  });

  if (failures > 0) {
    console.error(`\n${failures} service worker check(s) failed`);
    process.exit(1);
  }
  console.log("\nservice worker: all checks passed");
}

void main();
