import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export async function discoverGetRoutes(root) {
  const api = path.join(root, "src", "app", "api");
  const routes = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/^route\.[cm]?[jt]s$/.test(entry.name)) {
        const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest);
        const get = source.statements.some((node) => {
          if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
            return node.exportClause.elements.some((e) => e.name.text === "GET");
          if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
          return (ts.isFunctionDeclaration(node) && node.name?.text === "GET") ||
            (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(source) === "GET"));
        });
        if (get) routes.push("/api/" + path.relative(api, dir).split(path.sep).join("/"));
      }
    }
  }
  await walk(api);
  return routes.sort();
}

const volatile = new Set([
  "timestamp", "generatedAt", "createdAt", "updatedAt", "observedAt", "lastChecked",
  "lastUsedAt", "expiresAt", "verifiedAt", "latencyMs", "durationMs", "elapsedMs",
  "uptime", "uptimeSeconds", "requestId", "correlationId", "traceId", "buildId",
  "scannedAtMs",
]);

/** Inert rows seeded into both snapshot copies by run.mjs (see seedFixture). */
export const FIXTURE = {
  workId: "parity-fixture-work", workKey: "parity-fixture-big-buck-bunny-2008",
  watchListItemId: "parity-fixture-item", torrentId: "parity-fixture-torrent", targetId: "parity-fixture-target",
  infoHash: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
};

export function normalize(value, { replacements = [], unordered = [] } = {}, pointer = "$") {
  if (Array.isArray(value)) {
    const values = value.map((v) => normalize(v, { replacements, unordered }, `${pointer}[]`));
    return unordered.includes(pointer)
      ? values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : values;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      // Preserve presence and type: a missing timestamp remains a contract difference.
      volatile.has(key) || (pointer === "$.build" && key === "id")
        ? (value[key] === null ? null : typeof value[key] === "number" ? 0 : typeof value[key] === "string" ? "<volatile>" : value[key])
        : normalize(value[key], { replacements, unordered }, `${pointer}.${key}`),
    ]));
  }
  if (typeof value === "string") {
    for (const [from, to] of replacements) value = value.split(from).join(to);
  }
  return value;
}

export async function createCases(root, db, options = {}) {
  const first = async (sql) => (await db.execute(sql)).rows[0];
  const work = await first('SELECT workKey FROM Work ORDER BY workKey LIMIT 1');
  const torrent = await first('SELECT hash FROM EngineTorrent ORDER BY hash LIMIT 1');
  const item = await first('SELECT id FROM WatchListItem ORDER BY id LIMIT 1');
  const workKey = encodeURIComponent(work?.workKey ?? "parity-missing-work");
  const infoHash = encodeURIComponent(torrent?.hash ?? "0000000000000000000000000000000000000000");
  const watchId = encodeURIComponent(item?.id ?? "parity-missing-item");
  const fixtures = { workKey: work?.workKey ?? null, infoHash: torrent?.hash ?? null, watchListItemId: item?.id ?? null };
  // Every GET must be reviewed for side effects before it enters the harness.
  // In particular, byte-stream GETs can resume downloads: use validation paths.
  const getPaths = {
    "/api/activity": "?limit=20",
    "/api/activity/unread": "",
    "/api/browse": "",
    "/api/client/torrents": "",
    "/api/diagnostics/health": "",
    "/api/health": "",
    "/api/history": "?limit=20",
    "/api/library/delete": `?watchListItemId=${watchId}&scope=show`,
    "/api/playback/hls/[sessionId]/[...segment]": "/api/playback/hls/parity-missing-session/playlist.m3u8",
    "/api/playback/status": "",
    "/api/playback/vod/[vodId]/[...file]": "/api/playback/vod/parity-missing-vod/playlist.m3u8",
    "/api/prewarm": "",
    "/api/prewarm/swarm-probe": "",
    "/api/progress": "",
    "/api/recommendations": "",
    "/api/rules": "",
    "/api/search": "?q=",
    "/api/search/titles": "?q=",
    "/api/settings/browse-folders": "?path=" + encodeURIComponent(options.folder ?? root),
    "/api/settings/client": "",
    "/api/stream/[infoHash]": `/api/stream/${infoHash}`,
    "/api/stream/[infoHash]/[...filePath]": "/api/stream/invalid-infohash/parity-missing.mp4",
    "/api/subtitles/[infoHash]": `/api/subtitles/${infoHash}`,
    "/api/suggest": "?q=",
    "/api/title/[workKey]": `/api/title/${workKey}`,
    "/api/title/[workKey]/extras": `/api/title/${workKey}/extras`,
    "/api/title/[workKey]/progress": `/api/title/${workKey}/progress`,
    "/api/watchlist": "",
  };
  const routes = await discoverGetRoutes(root);
  const unknown = routes.filter((r) => !(r in getPaths));
  if (unknown.length) throw new Error(`Review new GET routes and add safe cases: ${unknown.join(", ")}`);
  const cases = routes.map((route) => ({
    method: "GET", route, path: getPaths[route].startsWith("/api/") ? getPaths[route] : route + getPaths[route],
    body: undefined, label: "read",
  }));
  cases.push(
    { method: "GET", route: "/api/search", path: "/api/search?q=parity&page=0", label: "invalid page" },
    { method: "GET", route: "/api/progress", path: `/api/progress?infoHash=${infoHash}`, label: "real hash" },
    ...["/api/progress", "/api/torrent/send", "/api/playback/plan"].map((route) => ({
      method: "POST", route, path: route, body: {}, label: "invalid empty body",
    })),
  );
  const seeded = (await db.execute({ sql: "SELECT 1 FROM WatchListItem WHERE id = ?", args: [FIXTURE.watchListItemId] })
    .catch(() => ({ rows: [] }))).rows.length > 0;
  if (seeded) {
    const hash = FIXTURE.infoHash, key = encodeURIComponent(FIXTURE.workKey);
    const item = encodeURIComponent(FIXTURE.watchListItemId);
    fixtures.seeded = FIXTURE;
    cases.push(
      ...[
        ["/api/library/delete", `/api/library/delete?watchListItemId=${item}&scope=show`],
        ["/api/progress", `/api/progress?infoHash=${hash}`],
        ["/api/stream/[infoHash]", `/api/stream/${hash}`],
        ["/api/subtitles/[infoHash]", `/api/subtitles/${hash}`],
        ["/api/title/[workKey]", `/api/title/${key}`],
        ["/api/title/[workKey]/progress", `/api/title/${key}/progress`],
      ].filter(([, p]) => !cases.some((c) => c.method === "GET" && c.path === p))
        .map(([route, p]) => ({ method: "GET", route, path: p, label: "seeded fixture" })),
      { method: "POST", route: "/api/library/delete", path: "/api/library/delete",
        body: { watchListItemId: FIXTURE.watchListItemId, scope: "show", confirm: false }, label: "unconfirmed" },
    );
  }
  // Each probe below was checked against the Next handler: it is rejected before any
  // write, engine start, provider call or filesystem change. run.mjs aborts if either
  // host answers a non-GET probe with 2xx. Never add a probe without that review.
  const probe = (method, route, p, extra, label) => ({ method, route, path: p, ...extra, label });
  cases.push(
    probe("GET", "/api/library/delete", "/api/library/delete", {}, "missing id"),
    probe("GET", "/api/library/delete", "/api/library/delete?watchListItemId=parity-missing-item&scope=bad", {}, "invalid scope"),
    probe("GET", "/api/stream/[infoHash]", "/api/stream/not-a-hash", {}, "invalid hash"),
    probe("GET", "/api/subtitles/[infoHash]", "/api/subtitles/not-a-hash?filePath=x", {}, "invalid hash"),
    probe("HEAD", "/api/subtitles/[infoHash]", "/api/subtitles/not-a-hash?filePath=x", {}, "invalid hash"),
    probe("DELETE", "/api/subtitles/[infoHash]", "/api/subtitles/not-a-hash?filePath=x", {}, "invalid hash"),
    probe("HEAD", "/api/playback/hls/[sessionId]/[...segment]", "/api/playback/hls/parity-missing-session/playlist.m3u8", {}, "missing session"),
    probe("POST", "/api/stream/[infoHash]/select", "/api/stream/not-a-hash/select", { body: {} }, "invalid hash"),
    probe("POST", "/api/client/torrents", "/api/client/torrents", { body: {} }, "invalid empty body"),
    probe("POST", "/api/library/delete", "/api/library/delete", { body: {} }, "invalid empty body"),
    probe("POST", "/api/library/ondemand", "/api/library/ondemand", { body: { season: "1" } }, "invalid body"),
    probe("POST", "/api/library/backfill-estimate", "/api/library/backfill-estimate", { rawBody: "{" }, "malformed JSON"),
    probe("POST", "/api/playback/candidates", "/api/playback/candidates", { body: {} }, "invalid empty body"),
    probe("POST", "/api/playback/failover", "/api/playback/failover", { body: {} }, "invalid empty body"),
    probe("POST", "/api/playback/switch", "/api/playback/switch", { body: {} }, "invalid empty body"),
    probe("POST", "/api/prewarm", "/api/prewarm", { body: {} }, "unknown action"),
    probe("PUT", "/api/prewarm/swarm-probe", "/api/prewarm/swarm-probe", { rawBody: "{" }, "malformed JSON"),
    probe("PUT", "/api/settings/client", "/api/settings/client", { body: { clientType: 123 } }, "invalid type"),
    probe("POST", "/api/title/[workKey]", `/api/title/${workKey}`, { body: { scope: "title", preferredResolution: 123 } }, "invalid resolution"),
    probe("POST", "/api/watchlist", "/api/watchlist", { body: {} }, "invalid empty body"),
    probe("PATCH", "/api/watchlist", "/api/watchlist", { body: {} }, "invalid empty body"),
    probe("DELETE", "/api/watchlist", "/api/watchlist", {}, "missing id"),
    probe("POST", "/api/watchlist", "/api/watchlist", { rawBody: "{}", headers: { "content-type": "text/plain" } }, "wrong content type"),
    probe("POST", "/api/rules", "/api/rules", { body: {} }, "invalid empty body"),
    probe("PATCH", "/api/rules", "/api/rules", { body: {} }, "invalid empty body"),
    probe("DELETE", "/api/rules", "/api/rules", {}, "missing id"),
    probe("POST", "/api/rules/run", "/api/rules/run", { headers: { "sec-fetch-site": "cross-site" } }, "cross-site"),
    probe("POST", "/api/settings/open-folder", "/api/settings/open-folder", { body: { path: 123 } }, "invalid type"),
    probe("POST", "/api/settings/untracked-files", "/api/settings/untracked-files", { body: {} }, "invalid empty body"),
    probe("POST", "/api/settings/retention-sweep", "/api/settings/retention-sweep", { body: {} }, "invalid empty body"),
  );
  for (const c of cases) {
    // Filesystem enumeration can vary; ranked/paginated arrays stay ordered.
    const unordered = c.route === "/api/settings/browse-folders" ? ["$.entries"] : [];
    c.normalizer = (value) => normalize(value, { ...options, unordered });
  }
  // The .NET stream index resumes a known, paused transfer to serve it (Next only reads a live
  // client). The fixture has no magnet, so that resume flips it to error; run those reads last so
  // title/progress cases see the seeded state on both hosts.
  const resumes = (c) => c.method === "GET" && c.route === "/api/stream/[infoHash]";
  cases.sort((a, b) => Number(resumes(a)) - Number(resumes(b)));
  return { cases, routes, fixtures };
}
