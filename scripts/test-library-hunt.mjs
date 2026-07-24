/**
 * Integration: library aggregator hunt path (no HTTP auth).
 * - cursor resolve
 * - live search for Family Guy S09E01
 * - advance after "grab"
 *
 * Run: node scripts/test-library-hunt.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

// Load TS modules via tsx
const { spawnSync } = await import("node:child_process");
const r = spawnSync(
  "npx",
  [
    "tsx",
    "-e",
    `
import assert from "node:assert/strict";
import { resolveHuntCursor, afterSuccessfulGrab, episodeSearchQuery } from "./src/lib/library/cursor.ts";
import { searchTorrents } from "./src/lib/torrents/aggregator.ts";
import { parseEpisode } from "./src/lib/torrents/episodes.ts";

const item = {
  title: "Family Guy",
  mediaType: "tv",
  fromSeason: 9,
  fromEpisode: 1,
  cursorSeason: 9,
  cursorEpisode: 1,
  lastEpisode: null,
  nextEpisodeHint: "Family Guy S09E01",
};

const hunt = resolveHuntCursor(item);
console.log("hunt.query:", hunt.query);
assert.equal(hunt.query, "Family Guy S09E01");
assert.deepEqual(hunt.cursor, { season: 9, episode: 1 });

console.log("searching live…");
const result = await searchTorrents({
  query: hunt.query,
  category: "tv",
  limit: 15,
  enrich: false,
  skipCache: true,
  filters: {
    hasMagnet: true,
    minSeeders: 1,
    season: 9,
    episode: 1,
  },
});

console.log("totalCount:", result.totalCount, "sources:", result.sources?.map(s => s.id+":"+s.count+(s.error?"!"+s.error:"")).join(", "));
assert.ok(result.results.length > 0, "expected at least one result for Family Guy S09E01");

const withMagnet = result.results.filter(t => t.magnet && (t.seeders ?? 0) > 0);
assert.ok(withMagnet.length > 0, "expected seeded magnet");

const matched = withMagnet.find(t => {
  const ep = parseEpisode(t.title);
  return ep.season === 9 && ep.episode === 1;
});
const best = matched ?? withMagnet[0];
console.log("best:", best.seeders, "seeds ·", best.title.slice(0, 90));
console.log("parse match S09E01:", Boolean(matched));

// Ranking: scores non-increasing
for (let i = 1; i < result.results.length; i++) {
  assert.ok(
    (result.results[i].score ?? 0) <= (result.results[i - 1].score ?? 0) + 1e-6,
    "scores must be sorted",
  );
}

// Filter: if season filter kept a result with wrong season when parseable, fail
for (const t of result.results) {
  const ep = parseEpisode(t.title);
  if (ep.season != null && ep.season !== 9) {
    throw new Error("filter leaked wrong season: " + t.title);
  }
  if (ep.episode != null && ep.episode !== 1) {
    throw new Error("filter leaked wrong episode: " + t.title);
  }
}
console.log("season/episode filter: no leaks among parseable titles");

const advanced = afterSuccessfulGrab(item.title, hunt.cursor, best.title);
console.log("after grab:", advanced);
assert.equal(advanced.lastEpisode, matched ? "S09E01" : advanced.lastEpisode);
if (matched) {
  assert.equal(advanced.cursorSeason, 9);
  assert.equal(advanced.cursorEpisode, 2);
  assert.equal(advanced.nextEpisodeHint, "Family Guy S09E02");
}

// Movie path
const movie = resolveHuntCursor({ title: "Dune Part Two", mediaType: "movie" });
assert.equal(movie.query, "Dune Part Two");
assert.equal(movie.cursor, null);

console.log("\\nPASS: library hunt integration");
`,
  ],
  { cwd: root, encoding: "utf8", shell: true, timeout: 120000 },
);

process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
