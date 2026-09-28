import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const src = (file) => readFileSync(path.resolve("src", file), "utf8");
const header = src("components/layout/header.tsx");
const mobileNav = src("components/layout/mobile-nav.tsx");
const dialog = src("components/requests/request-dialog.tsx");
const about = src("app/about/page.tsx");

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(() => server.close());
const requests = await server.ssrLoadModule("/src/lib/requests.ts");

/** The JSX of the one `data-preview-toggle` button in a file. */
function previewButton(source) {
  const at = source.indexOf("data-preview-toggle");
  assert.notEqual(at, -1, "view-as control exists");
  assert.equal(source.indexOf("data-preview-toggle", at + 1), -1, "one view-as control per surface");
  const start = source.lastIndexOf("<button", at);
  return source.slice(start, source.indexOf("</button>", at));
}

test("view as requester: one control per surface with a single accessible name", () => {
  for (const [name, source] of [["header", header], ["mobile-nav", mobileNav]]) {
    const button = previewButton(source);
    assert.match(button, /aria-label="View as requester"/, name);
    assert.doesNotMatch(button, /sr-only/, `${name}: no second hidden copy of the name`);
    const copies = button.match(/>\s*View as requester\s*(?:<|$)/g) ?? [];
    assert.ok(copies.length <= 1, `${name}: at most one text label`);
    assert.equal((button.match(/View as requester/g) ?? []).length - copies.length, 1, `${name}: name only in aria-label`);
    assert.match(button, /setPreviewAsRequester\(true\)/, name);
  }
  assert.match(header, /caps\.canPreview && isDesktop \?/, "header control is owner-only and never a hidden twin on phones");
  assert.match(header, /useMediaQuery\("\(min-width: 768px\)"\)/);
  assert.match(mobileNav, /showPreviewToggle = caps\.canPreview/, "More sheet control is owner-only");
});

test("the More sheet can always scroll its last control into reach", () => {
  const sheet = mobileNav.slice(mobileNav.indexOf("data-mobile-more-sheet"));
  assert.match(sheet, /max-h-\[calc\(100dvh-var\(--header-h\)\)\] overflow-y-auto/);
});

test("nav badges are 12px or larger and use the accent/primary-foreground pair", () => {
  const badges = [...`${header}\n${mobileNav}`.matchAll(/data-nav-[a-z-]+\s+aria-label=[^\n]+\n\s+className="([^"]+)"/g)];
  assert.ok(badges.length >= 5, `found ${badges.length} badges`);
  for (const [, cls] of badges) {
    const size = Number(/text-\[(\d+)px\]/.exec(cls)?.[1]);
    assert.ok(size >= 12, `badge text ${size}px: ${cls}`);
    assert.match(cls, /bg-\[var\(--accent\)\]/);
    assert.match(cls, /text-\[var\(--primary-foreground\)\]/);
  }
  for (const source of [header, mobileNav]) assert.doesNotMatch(source, /text-\[(9|10|11)px\]/);
});

test("mobile tabs keep 44px touch targets", () => {
  const tabs = mobileNav.match(/relative flex min-h-\[44px\]/g) ?? [];
  assert.ok(tabs.length >= 2);
});

const series = {
  key: "breaking-bad", title: "Breaking Bad", year: 2008, mediaType: "tv", isSeries: true, format: null, category: "tv",
  provider: "tmdb", providerId: "1396", posterUrl: null, overview: null, releaseDate: null, inLibrary: false,
  requestStatus: null, requestId: null,
};

test("preview reads seasons through the owner's session so the season picker renders", () => {
  const owner = requests.requestSeasonsUrl(series, true);
  assert.ok(owner.startsWith("/api/title/breaking-bad/extras?"), owner);
  const q = new URL(owner, "http://x").searchParams;
  assert.equal(q.get("t"), "Breaking Bad");
  assert.equal(q.get("y"), "2008");
  assert.equal(q.get("type"), "tv");
  assert.equal(q.get("provider"), "tmdb");
  assert.equal(q.get("providerId"), "1396");
  assert.equal(q.get("series"), "1");

  const mine = requests.requestSeasonsUrl(series, false);
  assert.ok(mine.startsWith("/api/requester/seasons?"), mine);
  assert.equal(new URL(mine, "http://x").searchParams.get("providerId"), "1396");

  assert.equal(requests.requestSeasonsUrl({ ...series, isSeries: false }, true), null);
  assert.equal(requests.requestSeasonsUrl(null, false), null);
  const noId = new URL(requests.requestSeasonsUrl({ ...series, providerId: null, year: null, title: "Twin Peaks ✦" }, true), "http://x");
  assert.equal(noId.searchParams.get("providerId"), null);
  assert.equal(noId.searchParams.get("y"), null);
  assert.equal(noId.searchParams.get("t"), "Twin Peaks ✦");

  // Extras answer { seasons: [0, 1, …] }; specials never become a choice.
  assert.deepEqual(requests.parseSeasons({ seasons: [0, 2, 1, 2] }), [1, 2]);
});

test("request dialog: preview fetches seasons, shows the picker and a plain note, never sends", () => {
  assert.match(dialog, /requestSeasonsUrl\(title, ownerSession\)/);
  assert.doesNotMatch(dialog, /enabled: open && !previewing/, "preview must not skip the season list");
  assert.match(dialog, /data-request-seasons/);
  assert.match(dialog, /data-request-preview-note/);
  assert.match(dialog, /Preview: requests aren&apos;t sent/);
  assert.match(dialog, /const canSubmit = !busy && !previewing/);
});

test("about: shared page, owner setup details only for the owner", () => {
  assert.match(about, /const \{ canManage \} = useCapabilities\(\)/);
  const secret = about.indexOf("AUTH_SECRET");
  assert.ok(about.lastIndexOf("{canManage ? (", secret) !== -1);
  assert.match(about, /: "h browse · s search · w watchlist · a notifications"/);
});
