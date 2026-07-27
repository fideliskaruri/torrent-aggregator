/**
 * Library aggregator core: cursor + live filter/rank + storage budget.
 * Uses real shipped modules (searchTorrents, assertStorageBudget, cursor).
 * Run: npx tsx src/lib/library/library-core.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterSuccessfulGrab,
  resolveHuntCursor,
} from "./cursor";
import { selectSeriesCandidateWithPackPreference } from "@/lib/torrents/pack-preference";
import {
  assertStorageBudget,
  DEFAULT_MAX_STORAGE_BYTES,
} from "./disk-space";
import { searchTorrents } from "@/lib/torrents/aggregator";
import { parseEpisode } from "@/lib/torrents/episodes";
import type { TorrentResult } from "@/lib/torrents/types";

function torrent(overrides: Partial<TorrentResult>): TorrentResult {
  return {
    id: overrides.id ?? overrides.title ?? "torrent",
    title: overrides.title ?? "Example Show S01E05 1080p",
    magnet: overrides.magnet ?? "magnet:?xt=urn:btih:test",
    infoHash: overrides.infoHash ?? overrides.id ?? "test",
    sizeBytes: overrides.sizeBytes ?? 1_000_000_000,
    seeders: overrides.seeders ?? 50,
    leechers: overrides.leechers ?? 0,
    source: overrides.source ?? "torrentscsv",
    sourceUrl: overrides.sourceUrl ?? "https://example.invalid",
    tags: overrides.tags ?? ["1080p"],
    ...overrides,
  };
}

async function main() {
  const hunt = resolveHuntCursor({
    title: "Family Guy",
    mediaType: "tv",
    fromSeason: 9,
    fromEpisode: 1,
    cursorSeason: 9,
    cursorEpisode: 1,
  });
  assert.equal(hunt.query, "Family Guy S09E01");

  const search = await searchTorrents({
    query: "Dune Part Two",
    category: "movies",
    limit: 20,
    enrich: false,
    skipCache: true,
    filters: { resolution: "2160p", minSeeders: 5, maxSizeBytes: 8e9 },
  });
  assert.ok(search.results.length > 0, "need 4k results");
  for (const r of search.results) {
    const hay = `${r.title} ${(r.tags || []).join(" ")}`.toLowerCase();
    assert.ok(/2160p|4k|uhd/.test(hay), `resolution leak: ${r.title}`);
    assert.ok((r.seeders ?? 0) >= 5, `seeders: ${r.title}`);
    if (r.sizeBytes != null) assert.ok(r.sizeBytes <= 8e9);
  }
  for (let i = 1; i < search.results.length; i++) {
    assert.ok(
      (search.results[i].score ?? 0) <=
        (search.results[i - 1].score ?? 0) + 1e-6,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cap-"));
  try {
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(5000));
    const blocked = await assertStorageBudget({
      root: dir,
      maxStorageBytes: 1000,
      incomingBytes: 2000,
    });
    assert.equal(blocked.ok, false);
    const allowed = await assertStorageBudget({
      root: dir,
      maxStorageBytes: DEFAULT_MAX_STORAGE_BYTES,
      incomingBytes: 1000,
    });
    assert.equal(allowed.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const adv = afterSuccessfulGrab(
    "Family Guy",
    { season: 9, episode: 1 },
    "Family.Guy.S09E01.HDTV.XviD",
  );
  assert.equal(adv.lastEpisode, "S09E01");
  assert.equal(adv.cursorEpisode, 2);
  assert.equal(adv.nextEpisodeHint, "Family Guy S09E02");

  const packPreferenceCases = [
    {
      name: "pack preferred over episode when both exist",
      results: [
        torrent({ id: "episode", title: "Example Show S01E05 1080p", sizeBytes: 1_000_000_000 }),
        torrent({ id: "pack", title: "Example Show S01 1080p Complete", sizeBytes: 18_000_000_000 }),
      ],
      expectId: "pack",
    },
    {
      name: "single-season pack beats complete range when both cover cursor",
      results: [
        torrent({ id: "episode", title: "Example Show S01E05 1080p", sizeBytes: 1_000_000_000 }),
        torrent({ id: "range", title: "Example Show S01-S05 Complete 1080p", sizeBytes: 70_000_000_000 }),
        torrent({ id: "season", title: "Example Show Season 1 1080p", sizeBytes: 18_000_000_000 }),
      ],
      expectId: "season",
    },
    {
      name: "multi-season pack covering cursor beats episode when no season pack exists",
      results: [
        torrent({ id: "episode", title: "Example Show S02E03 1080p", sizeBytes: 1_000_000_000 }),
        torrent({ id: "wrong-season", title: "Example Show Season 1 1080p", sizeBytes: 18_000_000_000 }),
        torrent({ id: "range", title: "Example Show S01-S03 Complete 1080p", sizeBytes: 55_000_000_000 }),
      ],
      target: { season: 2, episode: 3 },
      expectId: "range",
    },
    {
      name: "no pack available falls back to the episode unchanged",
      results: [
        torrent({ id: "episode", title: "Example Show S01E05 1080p", sizeBytes: 1_000_000_000 }),
      ],
      expectId: "episode",
    },
    {
      name: "oversized pack rejected by guard falls back to episode",
      results: [
        torrent({ id: "episode", title: "Example Show S01E05 1080p", sizeBytes: 1_000_000_000 }),
        torrent({ id: "huge", title: "Example Show S01-S09 Complete 1080p", sizeBytes: 500_000_000_000 }),
      ],
      expectId: "episode",
    },
  ];

  for (const tc of packPreferenceCases) {
    const picked = selectSeriesCandidateWithPackPreference(
      tc.results,
      tc.target ?? { season: 1, episode: 5 },
    );
    assert.equal(picked?.id, tc.expectId, tc.name);
  }

  const huntSearch = await searchTorrents({
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
  assert.ok(huntSearch.results.length > 0);
  for (const r of huntSearch.results) {
    const ep = parseEpisode(r.title);
    if (ep.season != null) assert.equal(ep.season, 9);
    if (ep.episode != null) assert.equal(ep.episode, 1);
  }

  console.log("library-core.test.ts: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
