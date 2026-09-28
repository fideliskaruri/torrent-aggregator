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

const api = await server.ssrLoadModule("/src/lib/api-json.ts");
const watch = await server.ssrLoadModule("/src/lib/connection-watch.ts");

test("readJsonBody turns empty and non-JSON bodies into null", async () => {
  assert.equal(await api.readJsonBody(new Response(null, { status: 404 })), null);
  assert.equal(await api.readJsonBody(new Response("<html>login</html>")), null);
  assert.deepEqual(await api.readJsonBody(new Response('{"a":1}')), { a: 1 });
});

test("sendErrorFromBody ties new {error, field} errors to the right field", () => {
  assert.equal(api.sendErrorFromBody({ error: "magnet must contain…", field: "magnet" }, 400).field, "source");
  assert.equal(api.sendErrorFromBody({ error: "savePath is not writable", field: "savePath" }, 400).field, "savePath");
  // Old shape: a 400 that only says the folder is unwritable.
  assert.equal(api.sendErrorFromBody({ error: "Save path is not writable" }, 400).field, "savePath");
});

test("sendErrorFromBody keeps old {ok,message} messages and never shows raw JSON errors", () => {
  assert.deepEqual(api.sendErrorFromBody({ ok: false, message: "Configure a client first." }, 400), {
    message: "Configure a client first.",
    field: null,
  });
  const empty = api.sendErrorFromBody(null, 502);
  assert.match(empty.message, /HTTP 502/);
  assert.doesNotMatch(empty.message, /JSON/);
  assert.doesNotMatch(api.sendErrorFromBody({ error: "retention must be one of: keep", field: "retention" }, 400).message, /must be one of/);
});

function res(status, { type, auth, redirected = false } = {}) {
  const headers = new Headers();
  if (type) headers.set("Content-Type", type);
  if (auth) headers.set("X-TorrentFlow-Auth", auth);
  return { status, redirected, headers };
}

test("classifyApiResponse spots Cloudflare sign-in and tunnel-down answers", () => {
  assert.equal(watch.classifyApiResponse(res(401, { auth: "required", type: "application/json" }), "tunnel"), "sign-in");
  assert.equal(watch.classifyApiResponse(res(200, { type: "text/html" }), "tunnel"), "sign-in");
  assert.equal(watch.classifyApiResponse(res(200, { type: "text/html", redirected: true }), "tunnel"), "sign-in");
  assert.equal(watch.classifyApiResponse(res(530, { type: "text/html" }), "tunnel"), "unreachable");
  assert.equal(watch.classifyApiResponse(res(502, {}), "tunnel"), "unreachable");
});

test("classifyApiResponse leaves ordinary API answers alone", () => {
  assert.equal(watch.classifyApiResponse(res(200, { type: "application/json" }), "tunnel"), "ok");
  assert.equal(watch.classifyApiResponse(res(503, { type: "application/json" }), "local"), "ok");
  assert.equal(watch.classifyApiResponse(res(401, { auth: "misconfigured", type: "application/json" }), "tunnel"), "ok");
  assert.equal(watch.classifyApiResponse(res(404, {}), "local"), "ok");
  assert.equal(watch.classifyApiResponse(res(200, { type: "text/html" }), "local"), "ok");
});
