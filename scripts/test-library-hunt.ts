/**
 * Live library hunt integration (backend only).
 * Run: npx tsx scripts/test-library-hunt.ts
 */
import assert from "node:assert/strict";
import {
  afterSuccessfulGrab,
  resolveHuntCursor,
} from "../src/lib/library/cursor";
import { searchTorrents } from "../src/lib/torrents/aggregator";
import { parseEpisode } from "../src/lib/torrents/episodes";

async function main() {
  const item = {
    title: "Family Guy",
    mediaType: "tv",
    fromSeason: 9,
    fromEpisode: 1,
    cursorSeason: 9,
    cursorEpisode: 1,
    lastEpisode: null as string | null,
    nextEpisodeHint: "Family Guy S09E01",
  };

  const hunt = resolveHuntCursor(item);
  console.log("1) hunt.query:", hunt.query);
  assert.equal(hunt.query, "Family Guy S09E01");
  assert.deepEqual(hunt.cursor, { season: 9, episode: 1 });

  console.log("2) live search…");
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

  console.log(
    "   totalCount:",
    result.totalCount,
    "returned:",
    result.results.length,
  );
  console.log(
    "   sources:",
    (result.sources || [])
      .map((s) => `${s.id}:${s.count}${s.error ? " ERR" : ""}`)
      .join(" · "),
  );

  assert.ok(
    result.results.length > 0,
    "expected at least one result for Family Guy S09E01",
  );

  const withMagnet = result.results.filter(
    (t) => t.magnet && (t.seeders ?? 0) > 0,
  );
  assert.ok(withMagnet.length > 0, "expected seeded magnet");

  const matched = withMagnet.find((t) => {
    const ep = parseEpisode(t.title);
    return ep.season === 9 && ep.episode === 1;
  });
  const best = matched ?? withMagnet[0];
  console.log("3) best:", best.seeders, "seeds");
  console.log("   title:", best.title.slice(0, 100));
  console.log("   exact S09E01 parse match:", Boolean(matched));

  for (let i = 1; i < result.results.length; i++) {
    assert.ok(
      (result.results[i].score ?? 0) <=
        (result.results[i - 1].score ?? 0) + 1e-6,
      "scores non-increasing",
    );
  }

  let leaks = 0;
  for (const t of result.results) {
    const ep = parseEpisode(t.title);
    if (ep.season != null && ep.season !== 9) leaks++;
    if (ep.episode != null && ep.episode !== 1) leaks++;
  }
  console.log("4) parseable S/E filter leaks:", leaks);
  assert.equal(leaks, 0, "season/episode filter leaked wrong eps");

  const advanced = afterSuccessfulGrab(item.title, hunt.cursor, best.title);
  console.log("5) afterSuccessfulGrab:", advanced);
  if (matched) {
    assert.equal(advanced.lastEpisode, "S09E01");
    assert.equal(advanced.cursorSeason, 9);
    assert.equal(advanced.cursorEpisode, 2);
    assert.equal(advanced.nextEpisodeHint, "Family Guy S09E02");
  } else {
    console.warn(
      "   WARN: no title parsed as S09E01 — cursor uses hunt/parsed ep",
    );
    assert.ok(advanced.cursorEpisode >= 1);
  }

  const movie = resolveHuntCursor({
    title: "Dune Part Two",
    mediaType: "movie",
  });
  assert.equal(movie.query, "Dune Part Two");
  assert.equal(movie.cursor, null);
  console.log("6) movie path: bare title OK");

  console.log("\nPASS: library hunt integration");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
