import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";

// Every useApiQuery in the session and requester modules answers from this table.
let responses = {};
globalThis.__requesterQuery = (url, options = {}) => {
  const key = url == null || options.enabled === false ? null : Object.keys(responses).find((k) => url.startsWith(k));
  const json = key ? responses[key] : undefined;
  if (json === undefined) {
    return { data: null, loading: false, refreshing: false, error: null, settled: false, refetch() {} };
  }
  if (json instanceof Error) {
    return { data: null, loading: false, refreshing: false, error: json.message, settled: true, refetch() {} };
  }
  return {
    data: options.select ? options.select(json) : json,
    loading: false, refreshing: false, error: null, settled: true, refetch() {},
  };
};

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  plugins: [{
    name: "mock-requester-query",
    enforce: "pre",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      if (!file.endsWith("/lib/session.tsx") && !file.includes("/components/requester/")) return;
      return code.replace(
        'import { useApiQuery } from "@/hooks/use-api-query";',
        "const useApiQuery = globalThis.__requesterQuery;",
      );
    },
  }],
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  delete globalThis.__requesterQuery;
  await server.close();
});

const { SessionProvider, parseMe } = await server.ssrLoadModule("/src/lib/session.tsx");
const { ShellGate, isLoopbackHost } = await server.ssrLoadModule("/src/components/requester/shell-gate.tsx");
const { RequestSearch } = await server.ssrLoadModule("/src/components/requester/request-search.tsx");
const { MyRequests } = await server.ssrLoadModule("/src/components/requester/my-requests.tsx");
const requests = await server.ssrLoadModule("/src/components/requester/requests.ts");

function render(element, url = "/") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, element));
}

function gate(me, url = "/") {
  responses = me === undefined ? {} : { "/api/me": me };
  return render(
    createElement(SessionProvider, null,
      createElement(ShellGate, { owner: createElement("div", { "data-owner-shell": "" }, "OWNER") })),
    url,
  );
}

test("parseMe reads the role and keeps the pending count for the owner only", () => {
  assert.deepEqual(parseMe({ via: "tunnel", email: "f@x.com", role: "requester", pendingRequests: 4 }), {
    role: "requester", via: "tunnel", email: "f@x.com", pendingRequests: null,
  });
  assert.equal(parseMe({ via: "local", role: "owner", pendingRequests: 3 }).pendingRequests, 3);
  assert.equal(parseMe({ role: "admin" }).role, "owner");
  assert.equal(parseMe({ role: "owner", pendingRequests: -1 }).pendingRequests, null);
});

test("a requester gets the trimmed shell and never the owner tree", () => {
  const html = gate({ via: "tunnel", email: "friend@example.com", role: "requester", pendingRequests: null });
  assert.match(html, /data-requester-shell/);
  assert.doesNotMatch(html, /data-owner-shell/);
  assert.match(html, /data-requester-nav-item="search"/);
  assert.match(html, /data-requester-nav-item="requests"/);
  for (const owner of ["/downloads", "/settings", "/watchlist", "/activity", "/history", "/rules", "/client"]) {
    assert.doesNotMatch(html, new RegExp(`href="${owner}"`), `requester shell links to ${owner}`);
  }
});

test("owner routes show requester views for a requester", () => {
  const me = { via: "tunnel", email: "friend@example.com", role: "requester" };
  assert.match(gate(me, "/settings"), /data-requester-search/);
  assert.match(gate(me, "/downloads"), /data-requester-search/);
  assert.match(gate(me, "/requests"), /data-requester-requests/);
});

test("the owner keeps the full shell; remote pages wait for /api/me", () => {
  assert.match(gate({ via: "tunnel", email: "owner@example.com", role: "owner", pendingRequests: 2 }), /data-owner-shell/);
  // No answer yet on a non-loopback host (SSR has no window): nothing owner-side mounts.
  const pending = gate(undefined);
  assert.match(pending, /data-shell-pending/);
  assert.doesNotMatch(pending, /data-owner-shell/);
  // A failed /api/me on a remote host offers a retry instead of guessing the owner shell.
  const failed = gate(new Error("offline"));
  assert.match(failed, /data-shell-failed/);
  assert.doesNotMatch(failed, /data-owner-shell/);
});

test("loopback detection", () => {
  for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["tf.example.com", "192.168.1.5", "127.0.0.1.example.com"]) assert.equal(isLoopbackHost(host), false, host);
});

const titles = {
  results: [
    { key: "dune-2021", title: "Dune", year: 2021, mediaType: "movie", isSeries: false, format: null, category: "movies",
      provider: "tmdb", providerId: "438631", posterUrl: null, overview: "Spice.", releaseDate: "2021-10-22",
      inLibrary: true, requestStatus: null, requestId: null, filePath: "C:\\media\\dune.mkv", magnet: "magnet:?xt=urn:btih:abc" },
    { key: "arrival-2016", title: "Arrival", year: 2016, mediaType: "movie", isSeries: false, format: null, category: "movies",
      provider: "tmdb", providerId: "329865", posterUrl: null, overview: null, releaseDate: "2016-11-11",
      inLibrary: false, requestStatus: "pending", requestId: "r1" },
    { key: "severance", title: "Severance", year: 2022, mediaType: "tv", isSeries: true, format: null, category: "tv",
      provider: "tmdb", providerId: "95396", posterUrl: null, overview: null, releaseDate: "2022-02-18",
      inLibrary: false, requestStatus: null, requestId: null },
  ],
  partial: false,
};

test("title search shows library and request state with Request buttons, no title links", () => {
  responses = { "/api/requester/titles": titles };
  const html = render(createElement(RequestSearch), "/?q=dune");
  assert.match(html, /data-requester-in-library/);
  assert.match(html, /data-requester-requested="pending"/);
  assert.match(html, /data-requester-request="severance"/);
  assert.doesNotMatch(html, /data-requester-request="dune-2021"/);
  assert.doesNotMatch(html, /data-requester-request="arrival-2016"/);
  assert.doesNotMatch(html, /href="\/title\//);
  assert.doesNotMatch(html, /magnet:|dune\.mkv/);
});

test("title search has explicit empty, error and idle states", () => {
  responses = {};
  assert.match(render(createElement(RequestSearch), "/"), /Search for a title/);
  responses = { "/api/requester/titles": { results: [], partial: false } };
  assert.match(render(createElement(RequestSearch), "/?q=zzz"), /Nothing found/);
  responses = { "/api/requester/titles": new Error("Title search failed.") };
  assert.match(render(createElement(RequestSearch), "/?q=zzz"), /Search didn&#x27;t work/);
});

test("my requests: status labels, scope and cancel only while pending", () => {
  responses = {
    "/api/requester/requests": {
      requests: [
        { id: "a", title: "Arrival", year: 2016, mediaType: "movie", provider: "tmdb", providerId: "1", posterUrl: null,
          scope: "movie", seasons: [], note: null, status: "pending", decisionReason: null, decidedAt: null,
          createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "b", title: "Severance", year: 2022, mediaType: "tv", provider: "tmdb", providerId: "2", posterUrl: null,
          scope: "seasons", seasons: [1, 2, 3, 5], note: "thanks", status: "declined", decisionReason: "Not available",
          decidedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    },
  };
  const html = render(createElement(MyRequests), "/requests");
  assert.match(html, /data-requester-cancel="a"/);
  assert.doesNotMatch(html, /data-requester-cancel="b"/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Seasons 1–3, 5/);
  assert.match(html, /Not available/);
  responses = { "/api/requester/requests": { requests: [] } };
  assert.match(render(createElement(MyRequests), "/requests"), /No requests yet/);
});

test("pure request helpers", () => {
  assert.equal(requests.requesterView("/requests/"), "requests");
  assert.equal(requests.requesterView("/settings"), "search");
  assert.equal(requests.formatSeasons([2]), "Season 2");
  assert.equal(requests.formatSeasons([3, 1, 2, 7]), "Seasons 1–3, 7");

  const parsed = requests.parseTitles(titles).results;
  assert.equal(parsed.length, 3);
  for (const row of parsed) {
    assert.equal("filePath" in row, false);
    assert.equal("magnet" in row, false);
  }
  const [dune, arrival, severance] = parsed;
  assert.equal(requests.canRequest(dune), false);
  assert.equal(requests.canRequest(arrival), false);
  assert.equal(requests.canRequest(severance), true);
  assert.equal(requests.canRequest({ ...severance, requestStatus: "pending" }), true, "series can ask for more seasons");

  assert.deepEqual(requests.createRequestBody(severance, { scope: "seasons", seasons: [3, 1, 3], note: "  " }), {
    provider: "tmdb", providerId: "95396", mediaType: "tv", title: "Severance", year: 2022, posterUrl: null,
    scope: "seasons", seasons: [1, 3], note: null,
  });
  assert.equal(requests.createRequestBody(arrival, { scope: "seasons", seasons: [1], note: "hi" }).scope, "movie");
  assert.deepEqual(requests.createRequestBody(arrival, { scope: "seasons", seasons: [1], note: "hi" }).seasons, []);
  assert.deepEqual(requests.parseSeasons({ seasons: [3, 1, 0, 1, 2.5, 501, "4"] }), [1, 3]);
  assert.equal(requests.requestErrorMessage("duplicate"), "You've already asked for this.");
});

test("pending badge: nothing at zero or unknown, capped at 99+", () => {
  assert.equal(requests.pendingBadge(null), null);
  assert.equal(requests.pendingBadge(undefined), null);
  assert.equal(requests.pendingBadge(0), null);
  assert.equal(requests.pendingBadge(-2), null);
  assert.equal(requests.pendingBadge(Number.NaN), null);
  assert.equal(requests.pendingBadge(1), "1");
  assert.equal(requests.pendingBadge(99), "99");
  assert.equal(requests.pendingBadge(100), "99+");
});

test("owner inbox rows: pending first, then approved, then declined; history hidden", () => {
  const row = (id, status, createdAt) => ({ id, title: id, status, scope: "movie", createdAt, requestedBy: "f@x.com" });
  const parsed = requests.parseOwnerRequests({
    requests: [row("a", "approved", "2026-01-03"), row("p1", "pending", "2026-01-01"), row("c", "cancelled", "2026-01-05"),
      row("p2", "pending", "2026-01-04"), row("d", "declined", "2026-01-06"), row("f", "fulfilled", "2026-01-07")],
    pendingCount: 2,
  });
  assert.equal(parsed.pendingCount, 2);
  assert.equal(parsed.requests[0].requestedBy, "f@x.com");
  assert.deepEqual(requests.inboxRows(parsed.requests).map((r) => r.id), ["p2", "p1", "a", "d"]);
  assert.equal(requests.parseOwnerRequests({ requests: [row("x", "pending", "2026-01-01")] }).pendingCount, 1);
});

test("requester library: /library and /watchlist show it read-only, unknown routes fall back to search", () => {
  const me = { via: "tunnel", email: "friend@example.com", role: "requester" };
  responses = { "/api/me": me, "/api/requester/library": { titles: [{ key: "dune-2021", title: "Dune", year: 2021, mediaType: "movie", posterUrl: null, filePath: "C:\\x" }] } };
  const render2 = (url) => render(
    createElement(SessionProvider, null, createElement(ShellGate, { owner: createElement("div", null, "OWNER") })), url);
  for (const url of ["/library", "/watchlist"]) {
    const html = render2(url);
    assert.match(html, /data-requester-library-item="dune-2021"/);
    assert.match(html, /data-requester-nav-item="library"/);
    assert.doesNotMatch(html, /C:\\|filePath|<video|Play|Open folder/i);
  }
  assert.match(render2("/no/such/page"), /data-requester-search/);
  assert.equal(requests.requesterView("/Library/"), "library");
  assert.deepEqual(requests.parseLibrary({ titles: [{ key: "k" }, { key: "k2", title: "T" }] }).map((t) => t.key), ["k2"]);
});