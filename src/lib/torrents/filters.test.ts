/**
 * Filter + ranking checks (Dune Part Two–style scenarios).
 * Run: npx tsx src/lib/torrents/filters.test.ts
 */
import assert from "node:assert/strict";
import { applyFilters, parseFiltersFromParams } from "./filters";
import { extractTags, rankResults } from "./ranking";
import type { TorrentResult } from "./types";

function item(
  partial: Partial<TorrentResult> & { title: string },
): TorrentResult {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    sizeBytes: partial.sizeBytes ?? 5_000_000_000,
    seeders: partial.seeders ?? 10,
    leechers: partial.leechers ?? 1,
    source: partial.source ?? "torrentscsv",
    sourceUrl: partial.sourceUrl ?? "https://example.com",
    tags: partial.tags ?? extractTags(partial.title),
    magnet: partial.magnet ?? "magnet:?xt=urn:btih:abc",
    infoHash: partial.infoHash,
    publishedAt: partial.publishedAt,
    sizeLabel: partial.sizeLabel,
  };
}

// --- parseFiltersFromParams ---
{
  const p = new URLSearchParams(
    "resolution=2160p&codec=x265&minSeeders=5&maxSize=8000000000",
  );
  const f = parseFiltersFromParams(p);
  assert.equal(f.resolution, "2160p");
  assert.equal(f.codec, "x265");
  assert.equal(f.minSeeders, 5);
  assert.equal(f.maxSizeBytes, 8_000_000_000);
}

// --- 4K / 2160p / UHD filter for "Dune Part Two" pool ---
{
  const pool = [
    item({
      title: "Dune Part Two (2024) [1080p] [WEBRip]",
      seeders: 1088,
    }),
    item({
      title: "Dune Part Two (2024) [1080p] [BluRay]",
      seeders: 487,
    }),
    item({
      title: "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]",
      seeders: 195,
    }),
    item({
      title: "Dune Part Two (2024) [720p] [BluRay]",
      seeders: 120,
    }),
    item({
      title:
        "Dune - Part Two (2024) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Tigole)",
      seeders: 69,
    }),
    item({
      title:
        "Dune Part Two 2024 UHD BluRay 2160p DV HEVC HDR10+ TrueHD Atmos 7.1 x265-E",
      seeders: 37,
    }),
    item({
      title: "Dune Part Two 2024 UHD REMUX (no res token besides UHD)",
      seeders: 40,
      tags: ["UHD"],
    }),
  ];

  const as2160 = applyFilters(pool, { resolution: "2160p" });
  const as4k = applyFilters(pool, { resolution: "4k" });

  assert.equal(as2160.length, 4, "2160p keeps 2160p/4K/UHD only");
  assert.equal(as4k.length, 4, "4k alias same count as 2160p");
  assert.deepEqual(
    as2160.map((r) => r.title).sort(),
    as4k.map((r) => r.title).sort(),
    "4k alias must match 2160p set",
  );
  assert.ok(
    as2160.every(
      (r) =>
        /2160p|4k|uhd/i.test(`${r.title} ${r.tags.join(" ")}`),
    ),
    "every filtered row must look like 4K",
  );
  assert.ok(
    !as2160.some((r) => /\[1080p\]|\[720p\]/i.test(r.title)),
    "must not leak 1080p/720p",
  );
}

// --- Production order: filter THEN rank (not rank-then-slice) ---
{
  const pool = [
    item({
      title: "Dune Part Two (2024) [1080p] [WEBRip]",
      seeders: 1088,
    }),
    item({
      title: "Dune Part Two (2024) [2160p] [4K] [WEB]",
      seeders: 195,
    }),
    item({
      title: "Dune - Part Two (2024) (2160p BluRay x265)",
      seeders: 69,
    }),
    item({
      title: "Dune Part Two 2024 UHD BluRay 2160p",
      seeders: 37,
    }),
  ];

  // Unfiltered: rank full pool
  const unfiltered = rankResults(pool, "Dune Part Two");
  assert.equal(
    unfiltered[0].seeders,
    1088,
    "unfiltered: mega-seeded 1080p ranks first",
  );

  // Filtered: narrow set first, then rank that set only
  const only4k = rankResults(
    applyFilters(pool, { resolution: "2160p" }),
    "Dune Part Two",
  );
  assert.equal(only4k.length, 3);
  assert.equal(
    only4k[0].seeders,
    195,
    "4K set ranks highest-seeded 4K first",
  );
  assert.equal(only4k[0].bestPick, true, "bestPick is among filtered set");
  assert.ok(
    !only4k.some((r) => /1080p/i.test(r.title)),
    "1080p never enters ranked 4K set",
  );
  for (let i = 1; i < only4k.length; i++) {
    assert.ok(
      (only4k[i].score ?? 0) <= (only4k[i - 1].score ?? 0) + 1e-6,
      `score order at ${i}`,
    );
  }
}

// --- codec filter stacks with resolution ---
{
  const pool = [
    item({
      title: "Dune Part Two 2160p x264",
      seeders: 100,
      tags: ["2160p", "x264"],
    }),
    item({
      title: "Dune Part Two 2160p x265 HEVC",
      seeders: 50,
      tags: ["2160p", "x265", "HEVC"],
    }),
  ];
  const out = applyFilters(pool, { resolution: "2160p", codec: "x265" });
  assert.equal(out.length, 1);
  assert.match(out[0].title, /x265/i);
}

// --- minSeeders ---
{
  const pool = [
    item({ title: "Dune Part Two 2160p A", seeders: 5 }),
    item({ title: "Dune Part Two 2160p B", seeders: 50 }),
  ];
  const out = applyFilters(pool, { resolution: "2160p", minSeeders: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0].seeders, 50);
}

// --- releaseKind: packs vs episodes ---
{
  const pool = [
    item({ title: "Breaking Bad S01E03 1080p WEB-DL" }),
    item({ title: "Breaking Bad Season 1 Complete 1080p" }),
    item({ title: "Breaking Bad S01-S05 Complete 1080p BluRay" }),
    item({ title: "[SubsPlease] One Piece - 1090 (1080p)" }),
    item({ title: "Frieren Complete 1080p Batch" }),
  ];

  const packs = applyFilters(pool, { releaseKind: "packs" });
  const episodes = applyFilters(pool, { releaseKind: "episodes" });

  assert.equal(packs.length, 3, "expected 3 packs");
  for (const p of packs) {
    assert.match(p.title, /complete|batch/i);
  }

  assert.equal(episodes.length, 2, "expected 2 single episodes");
  for (const e of episodes) {
    assert.doesNotMatch(e.title, /complete|batch/i);
  }

  // The two kinds must partition the pool exactly — no release may be dropped
  // by both filters, or it becomes unreachable from the UI.
  assert.equal(
    packs.length + episodes.length,
    pool.length,
    "packs + episodes must cover every release exactly once",
  );

  // Absent filter means no filtering at all.
  assert.equal(applyFilters(pool, {}).length, pool.length);
}

// --- releaseKind uses the pre-parsed episode when the adapter supplied one ---
{
  const pool = [
    {
      ...item({ title: "Ambiguously Named Release" }),
      episode: {
        label: "S01 pack",
        isBatch: true,
        isSeasonPack: true,
        season: 1,
      },
    },
  ];
  assert.equal(applyFilters(pool, { releaseKind: "packs" }).length, 1);
  assert.equal(applyFilters(pool, { releaseKind: "episodes" }).length, 0);
}

console.log("filters.test.ts: all assertions passed");
