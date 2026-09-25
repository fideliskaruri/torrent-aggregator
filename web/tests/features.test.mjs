import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";

let query = { data: null, loading: true, error: null };
globalThis.__featureQuery = () => query;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { "@": path.resolve("src") } },
  plugins: [{
    name: "mock-feature-query",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/lib/features.tsx")) return;
      return code.replace(
        'import { useApiQuery } from "@/hooks/use-api-query";',
        "const useApiQuery = globalThis.__featureQuery;",
      );
    },
  }],
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(async () => {
  delete globalThis.__featureQuery;
  await server.close();
});

const { FeaturesProvider, useFeatures } = await server.ssrLoadModule("/src/lib/features.tsx");
const { displayPath } = await server.ssrLoadModule("/src/lib/display-path.ts");
const { visibleBrowseRail, missingRailPreviews } = await server.ssrLoadModule("/src/components/browse/first-run.ts");
const { TitleCard } = await server.ssrLoadModule("/src/components/browse/title-card.tsx");
const { HeroBanner } = await server.ssrLoadModule("/src/components/browse/hero-banner.tsx");
const { PlayOverlay } = await server.ssrLoadModule("/src/components/browse/play-overlay.tsx");
const { InlineStreamPlayer } = await server.ssrLoadModule("/src/components/watch/inline-player.tsx");
const { SwarmProbePanel } = await server.ssrLoadModule("/src/components/settings/swarm-probe-panel.tsx");
const { EpisodeList } = await server.ssrLoadModule("/src/components/title/episode-list.tsx");

function render(component, props = {}) {
  return renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(FeaturesProvider, null, createElement(component, props))));
}

function FeatureProbe() {
  return String(useFeatures().streaming);
}

test("folder launching is explicitly enabled and fails closed", () => {
  function FolderProbe() { return String(useFeatures().openFolder); }
  for (const [data, loading, error, expected] of [
    [null, true, null, "false"],
    [{ openFolder: true }, false, "offline", "false"],
    [{ openFolder: "true" }, false, null, "false"],
    [{ openFolder: false, runningInContainer: true }, false, null, "false"],
    [{ openFolder: true, runningInContainer: false }, false, null, "true"],
  ]) {
    query = { data, loading, error };
    assert.equal(render(FolderProbe), expected);
  }
});

test("display mappings preserve filesystem inputs and use the longest directory boundary", () => {
  const mappings = [
    { containerPath: "/media/", hostPath: "\\\\NAS\\media\\" },
    { containerPath: "/media/TV", hostPath: "/mnt/shows/" },
  ];
  assert.equal(displayPath("/media/Movies/a.mkv", mappings), "\\\\NAS\\media\\Movies\\a.mkv");
  assert.equal(displayPath("/media/TV/a.mkv", mappings), "/mnt/shows/a.mkv");
  assert.equal(displayPath("/media", mappings), "\\\\NAS\\media");
  assert.equal(displayPath("/media-other/a", mappings), "/media-other/a");
  assert.equal(displayPath("/MEDIA/a", mappings), "/MEDIA/a");
  assert.equal(displayPath("/data/db", mappings), "/data/db");
  assert.equal(displayPath("/media/a/b", [{ containerPath: "/media", hostPath: "/mnt/back\\slash" }]), "/mnt/back\\slash/a/b");
  assert.equal(displayPath("/media/a", [{ containerPath: "/media", hostPath: "" }]), "/media/a");
  assert.equal(mappings[0].containerPath, "/media/");
});

for (const [name, state, expected] of [
  ["loading", { data: null, loading: true, error: null }, "false"],
  ["error with stale enabled data", { data: { streaming: true }, loading: false, error: "offline" }, "false"],
  ["missing response", { data: null, loading: false, error: null }, "false"],
  ["malformed flag", { data: { streaming: "true" }, loading: false, error: null }, "false"],
  ["disabled", { data: { streaming: false }, loading: false, error: null }, "false"],
  ["enabled", { data: { streaming: true }, loading: false, error: null }, "true"],
]) {
  test(`features fail closed: ${name}`, () => {
    query = state;
    assert.equal(render(FeatureProbe), expected);
  });
}

test("streaming-only rails disappear but library stays", () => {
  assert.equal(visibleBrowseRail("continue-watching", false), false);
  assert.equal(visibleBrowseRail("ready-to-play", false), false);
  assert.equal(visibleBrowseRail("my-library", false), true);
  assert.equal(visibleBrowseRail("ready-to-play", true), true);
  assert.deepEqual(missingRailPreviews([], false).map((rail) => rail.id), ["next-up", "my-library"]);
});

const item = {
  id: "movie", title: "Example", mediaType: "movie", year: 2020,
  availability: "ready", infoHash: "a".repeat(40), filePath: "example.mp4",
  progressFraction: null, resumePositionSec: null, subtitle: null,
  posterUrl: null, backdropUrl: null,
};

test("cards and hero hide Play when disabled, restore it when enabled", () => {
  for (const streaming of [false, true]) {
    query = { data: { streaming }, loading: false, error: null };
    const card = render(TitleCard, { item, onAction() {} });
    const hero = render(HeroBanner, { pick: { item, eyebrow: "Featured" }, onAction() {} });
    assert.equal(card.includes('aria-label="Play'), streaming);
    assert.equal(hero.includes(">Play<"), streaming);
    if (!streaming) assert.match(hero, />Download</);
  }
});

test("player, overlay and swarm probe do not mount when streaming is disabled", () => {
  query = { data: { streaming: false }, loading: false, error: null };
  assert.equal(render(PlayOverlay, { infoHash: item.infoHash, title: item.title, onClose() {} }), "");
  assert.equal(render(InlineStreamPlayer, { infoHash: item.infoHash, title: item.title }), "");
  assert.equal(render(SwarmProbePanel), "");
});

test("episode playback is gated while episode and season downloads remain", () => {
  const props = {
    seasons: [{ season: 1, knownEpisodes: 1, pack: null, transfer: null }],
    season: 1,
    episodes: [{
      season: 1, episode: 1, label: "S01E01", availability: null,
      infoHash: null, filePath: null, downloadFraction: null, watchedFraction: null,
      resumePositionSec: null, watched: false, nextUp: false, fromPack: false,
      transfer: null, meta: null,
    }],
    truncated: false, loadState: { status: "ready" }, busy: false,
    statusFor: () => "idle", seasonGrabStatus: { status: "idle" },
    onSeasonChange() {}, onSeasonGrab() {}, onAction() {},
  };
  for (const streaming of [false, true]) {
    query = { data: { streaming }, loading: false, error: null };
    const html = render(EpisodeList, props);
    assert.equal(html.includes('data-action="stream"'), streaming);
    assert.match(html, /data-action="download"/);
    assert.match(html, /Download season/);
  }
});
