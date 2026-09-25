import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  await server.close();
});

const expiry = await server.ssrLoadModule("/src/lib/session-expiry.ts");

function response(status, { redirected = false, auth } = {}) {
  const res = new Response(null, {
    status,
    headers: auth ? { "X-TorrentFlow-Auth": auth } : {},
  });
  if (redirected) Object.defineProperty(res, "redirected", { value: true });
  return res;
}

beforeEach(() => {
  expiry.clearSessionExpired();
  expiry.setSessionVia("tunnel");
});

test("tunnel: a followed redirect is an expired session", () => {
  assert.equal(expiry.detectSessionExpiry("/api/me", { response: response(200, { redirected: true }) }), true);
  assert.equal(expiry.isSessionExpired(), true);
});

test("tunnel: 401 with X-TorrentFlow-Auth: required is an expired session", () => {
  assert.equal(expiry.detectSessionExpiry("/api/downloads", { response: response(401, { auth: "required" }) }), true);
  assert.equal(expiry.isSessionExpired(), true);
});

test("tunnel: 401 misconfigured is not expiry (reloading cannot fix it)", () => {
  assert.equal(expiry.detectSessionExpiry("/api/me", { response: response(401, { auth: "misconfigured" }) }), false);
  assert.equal(expiry.detectSessionExpiry("/api/me", { response: response(401) }), false);
  assert.equal(expiry.isSessionExpired(), false);
});

test("local or unknown via never reports expiry", () => {
  for (const via of ["local", null]) {
    expiry.setSessionVia(via);
    assert.equal(expiry.detectSessionExpiry("/api/me", { response: response(200, { redirected: true }) }), false);
    assert.equal(expiry.detectSessionExpiry("/api/me", { response: response(401, { auth: "required" }) }), false);
  }
  assert.equal(expiry.isSessionExpired(), false);
});

test("non-/api URLs are ignored", () => {
  assert.equal(expiry.detectSessionExpiry("/assets/app.js", { response: response(401, { auth: "required" }) }), false);
  assert.equal(expiry.detectSessionExpiry("https://example.com/api/me", { response: response(200, { redirected: true }) }), false);
  assert.equal(expiry.isSessionExpired(), false);
});

test("a successful poll clears the expired flag", () => {
  expiry.reportSessionExpired();
  assert.equal(expiry.isSessionExpired(), true);
  expiry.clearSessionExpired();
  assert.equal(expiry.isSessionExpired(), false);
});

test("a rejected fetch is only expiry when /api/me confirms a sign-in redirect", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    assert.equal(await expiry.confirmSessionExpiry("/api/me", new TypeError("Failed to fetch")), false);
    assert.equal(await expiry.confirmSessionExpiry("/api/me", new Error("bug in select")), false);

    globalThis.fetch = async () => ({ type: "opaqueredirect", status: 0, headers: new Headers() });
    assert.equal(await expiry.confirmSessionExpiry("/api/me", new TypeError("Failed to fetch")), true);
    assert.equal(expiry.isSessionExpired(), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
