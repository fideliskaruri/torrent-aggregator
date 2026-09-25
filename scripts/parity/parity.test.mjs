import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { createCases, discoverGetRoutes, normalize } from "./cases.mjs";
import { compare, markdown, structuralDiff } from "./diff.mjs";
import { parseOptions, request, snapshot } from "./run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const caseStub = { normalizer: normalize };
const response = (body, status = 200) => ({
  status, headers: { "content-type": "application/json", "cache-control": null }, body,
});

test("structural differences retain missing, extra, null, arrays, types and values", () => {
  assert.deepEqual(structuralDiff({ a: 1, b: null, c: [1, 2], d: false }, { a: "1", c: [3], d: false, e: 1 })
    .map((d) => [d.path, d.kind]), [
    ["$.a", "type"], ["$.b", "missing"], ["$.c[0]", "value"], ["$.c[1]", "missing"], ["$.e", "extra"],
  ]);
  assert.deepEqual(structuralDiff(null, {}), [{ path: "$", kind: "type", expected: "null", actual: "object" }]);
});

test("normalization masks volatile values without hiding keys, types or meaningful order", () => {
  const options = { replacements: [["D:\\isolated", "<data>"]], unordered: ["$.entries"] };
  const a = { timestamp: "one", durationMs: 1, build: { id: "next" }, entries: ["b", "a"], path: "D:\\isolated\\film", durationSec: 5 };
  const b = { ...a, timestamp: "two", durationMs: 50, build: { id: "dotnet" }, entries: ["a", "b"] };
  assert.deepEqual(normalize(a, options), normalize(b, options));
  assert.equal(normalize(a, options).path, "<data>\\film");
  assert.notDeepEqual(normalize(a), normalize({ ...a, timestamp: 100 }));
  assert.notDeepEqual(normalize(a), normalize({ ...a, durationSec: 6 }));
  assert.notDeepEqual(normalize({ results: [1, 2] }), normalize({ results: [2, 1] }));
});

test("bare missing routes are not ported; implemented JSON 404s are compared", () => {
  assert.equal(compare(caseStub, response({ error: "missing" }, 404),
    { status: 404, headers: { "content-type": null, "cache-control": null }, body: "" }).outcome, "not ported");
  assert.equal(compare(caseStub, response({ error: "missing" }, 404), response({ error: "missing" }, 404)).outcome, "pass");
  assert.equal(compare(caseStub, response({}), response({ error: "missing" }, 404)).outcome, "fail");
  assert.equal(compare(caseStub, { error: "timeout" }, response({})).outcome, "error");
});

test("status and both headers are independently checked", () => {
  const expected = response({});
  const actual = response({}, 201);
  actual.headers["content-type"] += "; charset=utf-8";
  actual.headers["cache-control"] = "no-store";
  const diff = compare(caseStub, expected, actual);
  assert.equal(diff.statusMatch, false);
  assert.equal(diff.headers["content-type"].match, false);
  assert.equal(diff.headers["cache-control"].match, false);
  assert.deepEqual(diff.differences, []);
});

test("options validate flags and regex patterns", () => {
  assert.equal(parseOptions(["--no-next-build", "--only", "health|watchlist", "--db", "source.db"])["no-next-build"], true);
  assert.equal(parseOptions(["--only", "HEALTH"]).filter.test("GET /api/health"), true);
  assert.throws(() => parseOptions(["--wat"]));
  assert.throws(() => parseOptions(["--only", "["]));
});

test("snapshot includes WAL, preserves source, sanitizes both copies and parameterizes real rows", async () => {
  const reports = path.join(root, "scripts", "parity", "reports");
  await mkdir(reports, { recursive: true });
  const dir = await mkdtemp(path.join(reports, "test-"));
  const sourcePath = path.join(dir, "source.db"), next = path.join(dir, "next.db"), dotnet = path.join(dir, "dotnet.db");
  const source = createClient({ url: pathToFileURL(sourcePath).href });
  const opened = [source];
  try {
    await source.executeMultiple(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE EngineTorrent (hash TEXT, status TEXT, magnet TEXT, torrentUrl TEXT, savePath TEXT, origin TEXT);
      CREATE TABLE ClientSettings (clientType TEXT, host TEXT, automationIntervalMinutes INTEGER, preProbeScope TEXT);
      CREATE TABLE Work (workKey TEXT);
      CREATE TABLE WatchListItem (id TEXT);
      CREATE TABLE AutoRule (enabled INTEGER);
      INSERT INTO EngineTorrent VALUES ('0123456789abcdef0123456789abcdef01234567', 'downloading', 'magnet:test', NULL, 'D:\\original', 'stream');
      INSERT INTO EngineTorrent VALUES ('finished', 'downloaded', NULL, NULL, 'D:\\original', 'user');
      INSERT INTO ClientSettings VALUES ('qbittorrent', 'http://external', 5, 'watching');
      INSERT INTO Work VALUES ('real-title-2026');
      INSERT INTO WatchListItem VALUES ('watch-real');
      INSERT INTO AutoRule VALUES (1);
    `);
    const before = (await source.execute("SELECT * FROM EngineTorrent ORDER BY hash")).rows;
    await snapshot(sourcePath, next, dotnet, path.join(dir, "data"));
    const a = createClient({ url: pathToFileURL(next).href }), b = createClient({ url: pathToFileURL(dotnet).href });
    opened.push(a, b);
    const query = "SELECT * FROM EngineTorrent ORDER BY hash";
    assert.deepEqual((await source.execute(query)).rows, before);
    assert.deepEqual((await a.execute(query)).rows, (await b.execute(query)).rows);
    assert.equal((await a.execute(query)).rows[0].status, "paused");
    assert.equal((await a.execute(query)).rows[0].magnet, null);
    assert.equal((await a.execute(query)).rows[1].status, "downloaded");
    assert.equal((await a.execute("SELECT * FROM ClientSettings")).rows[0].automationIntervalMinutes, 0);
    assert.equal((await source.execute("SELECT * FROM ClientSettings")).rows[0].clientType, "qbittorrent");
    const suite = await createCases(root, a);
    assert.equal(suite.cases.filter((c) => c.method === "GET" && c.label === "read").length, suite.routes.length);
    assert.ok(suite.cases.some((c) => c.path === "/api/title/real-title-2026"));
    assert.ok(suite.cases.some((c) => c.path.includes("0123456789abcdef0123456789abcdef01234567")));
    assert.ok(suite.cases.some((c) => c.path.includes("watch-real")));
    assert.ok(suite.cases.filter((c) => c.method === "POST").every((c) => JSON.stringify(c.body) === "{}"));
    const api = path.join(dir, "src", "app", "api", "new-route");
    await mkdir(api, { recursive: true });
    await writeFile(path.join(api, "route.ts"), "export { read as GET } from './handler';");
    assert.deepEqual(await discoverGetRoutes(dir), ["/api/new-route"]);
    await assert.rejects(createCases(dir, a), /Review new GET routes/);
    await writeFile(path.join(dir, "empty.db"), "");
    await assert.rejects(snapshot(path.join(dir, "empty.db"), next, dotnet, dir), /empty or invalid/);
  } finally {
    for (const db of opened) db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("HTTP capture includes body/header/errors and does not follow redirects", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/json" }); res.end(); }
    else if (req.url === "/bad") { res.setHeader("content-type", "application/json"); res.end("invalid"); }
    else { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual((await request(base, { method: "GET", path: "/json" })).body, { ok: true });
    assert.equal((await request(base, { method: "GET", path: "/redirect" })).status, 302);
    assert.ok((await request(base, { method: "GET", path: "/bad" })).error);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("markdown reports aggregate counts and per-request details", () => {
  const c = { ...caseStub, method: "GET", route: "/api/test", path: "/api/test", label: "read" };
  const text = markdown({ generatedAt: "test", routes: [c.route], results: [{ ...c, ...compare(c, response({ x: 1 }), response({ x: 2 })) }] });
  assert.match(text, /\| fail \| 1 \|/);
  assert.match(text, /\$\.x/);
  assert.match(text, /GET \/api\/test/);
});
