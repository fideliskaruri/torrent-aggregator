/**
 * Lightweight unit checks for ranking helpers.
 * Run with: npx tsx --test src/lib/torrents/ranking.test.ts
 * (or any test runner that loads this file)
 */
import assert from "node:assert/strict";
import { dedupeResults, extractTags, rankResults } from "./ranking";
import type { TorrentResult } from "./types";

function base(partial: Partial<TorrentResult> & { title: string }): TorrentResult {
  return {
    id: partial.id ?? partial.title,
    title: partial.title,
    sizeBytes: partial.sizeBytes ?? 1_000_000_000,
    seeders: partial.seeders ?? 10,
    leechers: partial.leechers ?? 1,
    source: partial.source ?? "nyaa",
    sourceUrl: partial.sourceUrl ?? "https://example.com",
    tags: partial.tags ?? extractTags(partial.title),
    magnet: partial.magnet,
    infoHash: partial.infoHash,
    publishedAt: partial.publishedAt,
    sizeLabel: partial.sizeLabel,
  };
}

// extractTags
{
  const tags = extractTags("[SubsPlease] Show - 01 (1080p) [HEVC]");
  assert.ok(tags.includes("1080p"));
  assert.ok(tags.includes("HEVC"));
}

// rankResults prefers more seeders
{
  const ranked = rankResults(
    [
      base({ title: "Show 1080p", seeders: 5 }),
      base({ title: "Show 1080p", seeders: 500 }),
    ],
    "Show",
  );
  assert.equal(ranked[0].seeders, 500);
}

// dedupe by infoHash
{
  const out = dedupeResults([
    base({ title: "A", infoHash: "abc", id: "1" }),
    base({ title: "B", infoHash: "abc", id: "2" }),
    base({ title: "C", infoHash: "def", id: "3" }),
  ]);
  assert.equal(out.length, 2);
}

console.log("ranking.test.ts: all assertions passed");
