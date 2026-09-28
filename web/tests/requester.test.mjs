import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { createServer } from "vite";

// Every useApiQuery in the session and request modules answers from this table.
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
      if (!file.endsWith("/lib/session.tsx") && !file.includes("/components/requests/")) return;
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
const { ShellGate, isLoopbackHost } = await server.ssrLoadModule("/src/components/layout/shell-gate.tsx");
const { CapabilityGuard } = await server.ssrLoadModule("/src/components/layout/capability-guard.tsx");
const { RequestAction } = await server.ssrLoadModule("/src/components/requests/request-action.tsx");
const caps = await server.ssrLoadModule("/src/lib/capabilities.ts");
const nav = await server.ssrLoadModule("/src/lib/navigation.ts");
const requests = await server.ssrLoadModule("/src/lib/requests.ts");

function render(element, url = "/") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, element));
}

function gate(me, url = "/") {
  responses = me === undefined ? {} : { "/api/me": me };
  return render(
    createElement(SessionProvider, null,
      createElement(ShellGate, null, createElement("div", { "data-app-shell": "" }, "APP"))),
    url,
  );
}

const requester = { via: "tunnel", email: "friend@example.com", role: "requester", pendingRequests: null };
const owner = { via: "tunnel", email: "owner@example.com", role: "owner", pendingRequests: 2 };

test("parseMe reads the role and keeps the pending count for the owner only", () => {
  assert.deepEqual(parseMe({ via: "tunnel", email: "f@x.com", role: "requester", pendingRequests: 4 }), {
    role: "requester", via: "tunnel", email: "f@x.com", pendingRequests: null,
  });
  assert.equal(parseMe({ via: "local", role: "owner", pendingRequests: 3 }).pendingRequests, 3);
  assert.equal(parseMe({ role: "admin" }).role, "owner");
  assert.equal(parseMe({ role: "owner", pendingRequests: -1 }).pendingRequests, null);
});

test("one shell for everyone; remote pages wait for /api/me before mounting it", () => {
  assert.match(gate(requester), /data-app-shell/);
  assert.match(gate(owner), /data-app-shell/);
  const pending = gate(undefined);
  assert.match(pending, /data-shell-pending/);
  assert.doesNotMatch(pending, /data-app-shell/);
  const failed = gate(new Error("offline"));
  assert.match(failed, /data-shell-failed/);
  assert.doesNotMatch(failed, /data-app-shell/);
});

test("loopback detection", () => {
  for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["tf.example.com", "192.168.1.5", "127.0.0.1.example.com"]) assert.equal(isLoopbackHost(host), false, host);
});

test("capability matrix: the owner does everything but request; a requester only requests", () => {
  const o = caps.capabilitiesFor("owner");
  const r = caps.capabilitiesFor("requester");
  for (const key of ["canDownload", "canManage", "canStream", "canSeePaths", "canSeeTransfers", "canReviewRequests", "canSeeUpcoming"]) {
    assert.equal(o[key], true, `owner ${key}`);
    assert.equal(r[key], false, `requester ${key}`);
  }
  assert.equal(o.canRequest, false);
  assert.equal(r.canRequest, true);
});

test("preview: only a real owner can render as a requester", () => {
  assert.equal(caps.effectiveRole("owner", "requester"), "requester");
  assert.equal(caps.effectiveRole("owner", null), "owner");
  assert.equal(caps.effectiveRole("owner", "admin"), "owner");
  assert.equal(caps.effectiveRole("requester", "owner"), "requester");
  assert.equal(caps.effectiveRole("requester", null), "requester");
  assert.equal(caps.PREVIEW_ROLE_KEY, "tf_preview_role");
});

test("navigation is filtered by capability", () => {
  const r = caps.capabilitiesFor("requester");
  const o = caps.capabilitiesFor("owner");
  const hrefs = (items) => items.map((item) => item.href);
  assert.deepEqual(hrefs(nav.desktopNavRow(r).items), ["/", "/watchlist", "/notifications", "/requests"]);
  assert.deepEqual(hrefs(nav.desktopNavRow(o).items), ["/", "/watchlist", "/downloads", "/upcoming", "/notifications", "/settings", "/requests"]);
  assert.deepEqual(nav.navFor(nav.MOBILE_PRIMARY_NAV, r).map((i) => [i.href, i.label]), [
    ["/", "Browse"], ["/watchlist", "Library"], ["/requests", "Requests"], ["/notifications", "Alerts"],
  ]);
  assert.deepEqual(nav.navFor(nav.MOBILE_MORE_NAV, r), []);
  assert.deepEqual(hrefs(nav.navFor(nav.MOBILE_MORE_NAV, o)), ["/upcoming", "/requests", "/settings"]);
});

test("owner-only routes need a capability; shared routes need none", () => {
  for (const route of ["/downloads", "/client", "/settings", "/rules", "/upcoming", "/history", "/activity", "/share", "/Settings/"]) {
    assert.notEqual(nav.routeRequirement(route), null, route);
  }
  for (const route of ["/", "/search", "/title/tmdb-movie-1", "/watchlist", "/requests", "/notifications", "/about"]) {
    assert.equal(nav.routeRequirement(route), null, route);
  }
});

function guarded(me, url) {
  responses = { "/api/me": me };
  return render(
    createElement(SessionProvider, null,
      createElement(Routes, null,
        createElement(Route, { element: createElement(CapabilityGuard) },
          createElement(Route, { path: "*", element: createElement("div", { "data-page": "" }, "PAGE") })))),
    url,
  );
}

test("a requester opening an owner page gets Not available, not the page", () => {
  for (const url of ["/downloads", "/settings", "/rules", "/upcoming", "/share"]) {
    const html = guarded(requester, url);
    assert.match(html, /data-not-available/, url);
    assert.match(html, /Go to Browse/);
    assert.doesNotMatch(html, /data-page/);
  }
  assert.match(guarded(requester, "/title/x"), /data-page/);
  assert.match(guarded(owner, "/settings"), /data-page/);
});

test("the Request control says where the request stands", () => {
  const title = { key: "sev", title: "Severance", year: 2022, mediaType: "tv", isSeries: true, format: null, category: "",
    provider: "tmdb", providerId: "95396", posterUrl: null, overview: null, releaseDate: null, inLibrary: false, requestStatus: null, requestId: null };
  const movie = { ...title, key: "arr", title: "Arrival", mediaType: "movie", isSeries: false };
  const html = (t, state) => render(createElement(RequestAction, { title: t, state }));
  const none = { inLibrary: false, requestStatus: null, requestId: null };
  assert.match(html(movie, none), /data-request-button="arr"/);
  assert.match(html(movie, none), />Request</);
  const pending = html(movie, { ...none, requestStatus: "pending" });
  assert.match(pending, /Requested/);
  assert.doesNotMatch(pending, /data-request-button/);
  assert.match(html(title, { ...none, requestStatus: "pending" }), /Request more seasons/);
  assert.match(html(movie, { ...none, requestStatus: "declined" }), /Declined[\s\S]*Request again/);
  const inLibrary = html(movie, { ...none, inLibrary: true });
  assert.match(inLibrary, /Available/);
  assert.doesNotMatch(inLibrary, /data-request-button/);
  assert.match(html(null, none), /disabled/);
});

test("request state parsing and my-requests order", () => {
  assert.deepEqual(requests.parseRequestState({ inLibrary: true, requestStatus: "bogus", requestId: 3 }), {
    inLibrary: true, requestStatus: null, requestId: null,
  });
  assert.deepEqual(requests.parseRequestState(undefined), { inLibrary: false, requestStatus: null, requestId: null });
  assert.equal(requests.requestViewFor({ inLibrary: false, requestStatus: "fulfilled", requestId: "x" }, false).label, "Available");
  const rows = [
    { id: "a", status: "declined", createdAt: "2026-01-05" },
    { id: "b", status: "pending", createdAt: "2026-01-01" },
    { id: "c", status: "approved", createdAt: "2026-01-06" },
  ];
  assert.deepEqual(requests.myRequestRows(rows).map((r) => r.id), ["b", "c", "a"]);
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


test("pure request helpers", () => {
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
  assert.deepEqual(requests.parseLibrary({ titles: [{ key: "k" }, { key: "k2", title: "T" }] }).map((t) => t.key), ["k2"]);
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

test("partial and failed requests stay in the inbox with a retry; partial reads Partly done", () => {
  const row = (id, status, createdAt) => ({ id, title: id, status, scope: "seasons", seasons: [1], createdAt, requestedBy: "f@x.com" });
  const parsed = requests.parseOwnerRequests({
    requests: [row("a", "approved", "2026-01-03"), row("pt", "partial", "2026-01-02"), row("fl", "failed", "2026-01-04"),
      row("p", "pending", "2026-01-01"), row("ok", "fulfilled", "2026-01-05")],
  });
  assert.deepEqual(requests.inboxRows(parsed.requests).map((r) => r.id), ["p", "pt", "fl", "a"]);
  assert.equal(requests.statusLabel("partial"), "Partly done");
  assert.equal(requests.canRetryRequest("partial"), true);
  assert.equal(requests.canRetryRequest("failed"), true);
  assert.equal(requests.canRetryRequest("approved"), false);
  assert.equal(requests.canRetryRequest("fulfilled"), false);
  assert.match(requests.ownerRequestErrorMessage("retry", { code: "not_pending", status: 409 }), /Nothing is left to retry/);
});

test("auto-approve: parse rules, drop none, merge known emails, labels", () => {
  const cfg = requests.parseAutoApprove({
    rules: [
      { email: "A@Ex.Com", mode: "moviesOnly" },
      { email: "skip@ex.com", mode: "none" },
      { email: "", mode: "everything" },
      { email: "b@ex.com", mode: "bogus" },
      { email: "c@ex.com", mode: "everything" },
    ],
    knownEmails: ["z@ex.com", "A@Ex.Com", 12, ""],
  });
  assert.deepEqual(cfg.rules, [
    { email: "a@ex.com", mode: "moviesOnly" },
    { email: "c@ex.com", mode: "everything" },
  ]);
  assert.deepEqual(cfg.knownEmails, ["a@ex.com", "c@ex.com", "z@ex.com"]);
  assert.deepEqual(
    requests.autoApproveRows(cfg, [" New@Ex.Com ", "a@ex.com"]).map((r) => `${r.email}:${r.mode}`),
    ["a@ex.com:moviesOnly", "c@ex.com:everything", "new@ex.com:none", "z@ex.com:none"],
  );
  assert.equal(requests.autoApproveModeLabel("none"), "Off");
  assert.equal(requests.autoApproveModeLabel("moviesOnly"), "Movies only");
  assert.equal(requests.autoApproveModeLabel("everything"), "Everything");
});

test("request errors: plain copy per code and status, never the server's raw text", () => {
  const m = requests.requestErrorMessage;
  assert.equal(m("duplicate"), "You've already asked for this. Follow it under Requests.");
  assert.match(m({ code: "in_library", status: 409 }), /already in the library\. Open Library/);
  assert.match(m({ code: "too_many_open", status: 409 }), /Cancel one under Requests/);
  assert.match(m({ code: "rate_limited", status: 429 }), /Wait a minute/);
  assert.match(m({ code: "not_pending", status: 409 }), /already answered/);
  assert.match(m({ code: "requester_forbidden", status: 403 }), /Sign in with the email/);
  assert.match(m({ code: null, status: 400 }), /couldn't be requested\. Open it again from Search/);
  assert.match(m({ code: "something_new", status: 403 }), /Ask the owner/);
  assert.match(m({ status: 503 }), /Try again in a moment/);
  assert.match(m({ status: 418 }), /didn't go through\. Try again/);
  assert.match(m({}), /Couldn't reach TorrentFlow\. Check your connection/);
  assert.match(m(null), /Couldn't reach TorrentFlow/);
  // Developer-facing validation text must never leak into the UI.
  for (const f of [{ status: 400 }, { status: 409 }, { status: 500 }, {}]) {
    assert.doesNotMatch(m(f), /providerId|mediaType|must be|Unknown field/);
  }
  const o = requests.ownerRequestErrorMessage;
  assert.match(o("approve", { code: "not_pending", status: 409 }), /already answered/);
  assert.match(o("decline", { code: "not_found", status: 404 }), /no longer exists/);
  assert.match(o("auto-approve", { status: 400 }), /full email address/);
  assert.match(o("approve", { status: 500 }), /^Couldn't approve right now/);
  assert.match(o("decline", {}), /Check your connection/);
});