import assert from "node:assert/strict";
import { after, test } from "node:test";
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

const { magnetFromShare } = await server.ssrLoadModule("/src/lib/pwa/magnet-from-share.ts");
const { routeFor, shouldCache, isAppAssetPath } = await server.ssrLoadModule(
  "/src/lib/pwa/sw-cache-rules.ts",
);

const MAGNET =
  "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example";

test("magnetFromShare prefers a bare magnet url, then text/title embeds", () => {
  assert.equal(magnetFromShare({ url: MAGNET }), MAGNET);
  assert.equal(
    magnetFromShare({ text: `grab this ${MAGNET} please` }),
    MAGNET,
  );
  assert.equal(
    magnetFromShare({ title: `Shared ${MAGNET}` }),
    MAGNET,
  );
  assert.equal(
    magnetFromShare({
      url: "https://example.com/x",
      text: `body ${MAGNET}`,
    }),
    MAGNET,
  );
  assert.equal(magnetFromShare({ url: "https://x.test", text: "nope" }), null);
  assert.equal(magnetFromShare({}), null);
});

test("magnetFromShare decodes percent-encoding loosely", () => {
  const encoded = encodeURIComponent(MAGNET);
  assert.equal(magnetFromShare({ text: encoded }), MAGNET);
  assert.equal(
    magnetFromShare({ text: "see+this+" + encodeURIComponent(MAGNET) }),
    MAGNET,
  );
});

test("isAppAssetPath only matches hashed Vite assets", () => {
  assert.equal(isAppAssetPath("/assets/index-abc.js"), true);
  assert.equal(isAppAssetPath("/assets"), true);
  assert.equal(isAppAssetPath("/api/me"), false);
  assert.equal(isAppAssetPath("/icon-192.png"), false);
});

test("routeFor never caches API, auth, media, or non-GET", () => {
  const origin = "https://tf.example.com";
  assert.equal(routeFor({ url: `${origin}/api/me`, method: "GET" }, origin), "bypass");
  assert.equal(routeFor({ url: `${origin}/auth/login`, method: "GET" }, origin), "bypass");
  assert.equal(routeFor({ url: `${origin}/assets/a.js`, method: "POST" }, origin), "bypass");
  assert.equal(
    routeFor({ url: `${origin}/film.mp4`, method: "GET", destination: "video" }, origin),
    "bypass",
  );
  assert.equal(
    routeFor(
      { url: `${origin}/assets/a.js`, method: "GET", headers: { Range: "bytes=0-1" } },
      origin,
    ),
    "bypass",
  );
  assert.equal(routeFor({ url: `${origin}/`, method: "GET", mode: "navigate" }, origin), "navigate");
  assert.equal(routeFor({ url: `${origin}/assets/app.js`, method: "GET" }, origin), "asset");
  assert.equal(shouldCache(`${origin}/api/downloads`), false);
  assert.equal(shouldCache(`${origin}/assets/app.js`), true);
});
