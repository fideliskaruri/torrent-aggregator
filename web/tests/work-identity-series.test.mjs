import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import path from "node:path";

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: "silent",
  resolve: { alias: { "@": path.resolve("src") } },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
after(() => server.close());
const { workIdentityFor, hasSeasonEpisodeMarker } = await server.ssrLoadModule("/src/components/title/work-key.ts");
const { isSeriesDownload } = await server.ssrLoadModule("/src/app/downloads/media-filter.ts");

test("a release that states SxxEyy is never a film", () => {
  for (const name of [
    "[SubsPlease] Sousou no Frieren - S02E03 (1080p) [ABC123].mkv",
    "[ASW] Sousou no Frieren - S01E28 [1080p HEVC x265 10Bit][AAC]",
    "[Judas] Frieren - S01E01v2.mkv",
    "Frieren.Beyond.Journeys.End.S01E05.1080p.WEB.H264-GROUP",
    "Frieren (2023) - S01E04 - Killing Magic [1080p]",
    "葬送のフリーレン S01E10 1080p",
  ]) {
    const identity = workIdentityFor(name);
    assert.equal(identity.isSeries, true, name);
    assert.equal(identity.year, null, name);
    assert.ok(identity.key.startsWith("series:"), `${name} → ${identity.key}`);
  }
});

test("prints of one episode across groups share a series key", () => {
  const a = workIdentityFor("[SubsPlease] Sousou no Frieren - S02E03 (1080p) [ABC123].mkv");
  const b = workIdentityFor("[ASW] Sousou no Frieren - S02E07 [1080p HEVC][AAC]");
  const c = workIdentityFor("Sousou no Frieren S02E01 2026 1080p WEB");
  assert.equal(a.key, "series:sousou no frieren");
  assert.equal(b.key, a.key);
  assert.equal(c.key, a.key);
});

test("films keep their film identity", () => {
  for (const [name, key] of [
    ["Dune.2021.2160p.WEB-DL.x265-GROUP", "film:dune:2021"],
    ["Blade Runner 2049 (2017) 1080p", "film:blade runner 2049:2017"],
    ["Sintel.2010.1080p.mkv", "film:sintel:2010"],
    ["Se7en 1995 1080p", "film:se7en:1995"],
  ]) {
    assert.equal(workIdentityFor(name).key, key, name);
  }
  assert.equal(hasSeasonEpisodeMarker("Se7en 1995 1080p"), false);
  assert.equal(hasSeasonEpisodeMarker("Show.S01.E03"), true);
  assert.equal(hasSeasonEpisodeMarker("ClassicS01E01"), false);
});

test("downloads prefer the server's canonical media type and never file SxxEyy as a film", () => {
  assert.equal(isSeriesDownload({ name: "Frieren - S01E01 [1080p]", category: "Movies" }), true);
  assert.equal(isSeriesDownload({ name: "Frieren - S01E01 [1080p]", workMediaType: "movie" }), true);
  assert.equal(isSeriesDownload({ name: "[SubsPlease] Frieren - 28 (1080p)", workMediaType: "anime", category: "Movies" }), true);
  assert.equal(isSeriesDownload({ name: "Frieren Complete", workMediaType: "tv" }), true);
  assert.equal(isSeriesDownload({ name: "Dune.2021.1080p", workMediaType: "movie", category: "TV" }), false);
  assert.equal(isSeriesDownload({ name: "Dune.2021.1080p", category: "Movies" }), false);
});
