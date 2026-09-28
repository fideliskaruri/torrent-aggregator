import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import path from "node:path";

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent",
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(() => server.close());
const { titlesFromSearchHits } = await server.ssrLoadModule("/src/components/search/title-search.ts");
const { TitleResultCard } = await server.ssrLoadModule("/src/components/search/title-result-card.tsx");

const hit = (extra = {}) => ({
  workKey: "sintel-2010", title: "Sintel", year: 2010, category: "movies", provider: "cinemeta",
  providerId: "tt1727587", aliases: [], mediaType: "movie", titleMediaType: "movie", isSeries: false,
  format: null, posterUrl: null, overview: null, releaseDate: null, href: "/title/sintel-2010", ...extra,
});
const card = (title) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TitleResultCard, { title })));

test("owner hits carry no request state and render no status chip", () => {
  const [title] = titlesFromSearchHits([hit()]);
  assert.equal(title.request, null);
  assert.ok(!card(title).includes("data-title-request-status"));
});

test("requester hits show requested, approved, declined and in-library on the card", () => {
  for (const [extra, label, attr] of [
    [{ inLibrary: false, requestStatus: "pending", requestId: "r1" }, "Requested", "pending"],
    [{ inLibrary: false, requestStatus: "approved", requestId: "r1" }, "Approved", "approved"],
    [{ inLibrary: false, requestStatus: "declined", requestId: "r1" }, "Declined", "declined"],
    [{ inLibrary: true, requestStatus: null, requestId: null }, "Available", "available"],
  ]) {
    const [title] = titlesFromSearchHits([hit(extra)]);
    const html = card(title);
    assert.ok(html.includes(`data-title-request-status="${attr}"`), attr);
    assert.ok(html.includes(`>${label}<`), label);
    assert.ok(html.includes(`— ${label}"`), `accessible name carries ${label}`);
  }
});

test("a requester hit with nothing requested shows no chip", () => {
  const [title] = titlesFromSearchHits([hit({ inLibrary: false, requestStatus: null, requestId: null })]);
  assert.ok(title.request);
  assert.ok(!card(title).includes("data-title-request-status"));
});

test("the search overlay renders inside the <main> landmark", () => {
  const src = readFileSync("src/components/search/search-overlay.tsx", "utf8");
  assert.match(src, /getElementById\("main-content"\)/);
  assert.match(src, /createPortal\(overlay, host\)/);
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /<main\s+id="main-content"/);
});
