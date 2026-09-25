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
]);

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
  for (const c of cases) {
    // Filesystem enumeration can vary; ranked/paginated arrays stay ordered.
    const unordered = c.route === "/api/settings/browse-folders" ? ["$.entries"] : [];
    c.normalizer = (value) => normalize(value, { ...options, unordered });
  }
  return { cases, routes, fixtures };
}
