/**
 * Lightweight unit checks for ranking helpers.
 * Run with: npx tsx --test src/lib/torrents/ranking.test.ts
 * (or any test runner that loads this file)
 */
import assert from "node:assert/strict";
import {
  dedupeResults,
  extractTags,
  rankResults,
  stripReleaseGroup,
} from "./ranking";
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

// stripReleaseGroup — the release group must not survive into the group key
{
  const cases: [string, string][] = [
    ["[SubsPlease] One Piece - 1170 (1080p) [F1B2C3D4]", "One Piece - 1170"],
    ["[Erai-raws] One Piece - 1170 [1080p][Multiple Subtitle]", "One Piece - 1170"],
    ["(Judas) One Piece - 1170", "One Piece - 1170"],
    ["【ToonsHub】One Piece - 1170", "One Piece - 1170"],
    ["Severance.S02E01.1080p.WEB-DL.x264-NTb", "Severance.S02E01.1080p.WEB-DL.x264"],
    ["The Bear S03E01 1080p", "The Bear S03E01 1080p"],
    // A title that is nothing but a tag must not collapse to empty.
    ["[SomeGroup]", "[SomeGroup]"],
    // Hyphenated show names must survive — "Man" is a word, not a scene tag,
    // but the rule cannot tell, so verify the common real-world shape instead.
    ["Spider-Man Across the Spider-Verse 2160p", "Spider-Man Across the Spider-Verse 2160p"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripReleaseGroup(input), expected, `stripReleaseGroup(${input})`);
  }
}

// Different fansub groups releasing the same episode form ONE group, so only
// one row is badged "Best".
{
  const ranked = rankResults(
    [
      base({ title: "[SubsPlease] One Piece - 1170 (1080p)", id: "a", seeders: 900 }),
      base({ title: "[Erai-raws] One Piece - 1170 [1080p]", id: "b", seeders: 400 }),
      base({ title: "[ToonsHub] One Piece - 1170 (1080p)", id: "c", seeders: 100 }),
      base({ title: "[Judas] One Piece - 1171 (1080p)", id: "d", seeders: 800 }),
    ],
    "One Piece",
  );

  const bestPicks = ranked.filter((r) => r.bestPick);
  assert.equal(
    bestPicks.length,
    2,
    `expected one best per episode, got ${bestPicks.length}`,
  );

  // The best pick for episode 1170 must be the most-seeded of that episode.
  const ep1170 = ranked.filter((r) => r.title.includes("1170"));
  const best1170 = ep1170.find((r) => r.bestPick);
  assert.equal(best1170?.id, "a", "best pick should be the strongest release");
  assert.equal(
    ep1170.filter((r) => r.bestPick).length,
    1,
    "exactly one best pick per episode",
  );

  // A different episode is its own group and keeps its own best pick.
  assert.ok(ranked.find((r) => r.id === "d")?.bestPick, "1171 has its own best");
}

// Different episodes of the same show never share a group.
{
  const ranked = rankResults(
    [
      base({ title: "[Group] Frieren - 01 (1080p)", id: "e1" }),
      base({ title: "[Group] Frieren - 02 (1080p)", id: "e2" }),
      base({ title: "[Group] Frieren - 03 (1080p)", id: "e3" }),
    ],
    "Frieren",
  );
  assert.equal(
    ranked.filter((r) => r.bestPick).length,
    3,
    "each episode is its own group",
  );
}

// Unrelated shows must not be merged just because their tags were stripped.
{
  const ranked = rankResults(
    [
      base({ title: "[Group] Severance - 01 (1080p)", id: "s1" }),
      base({ title: "[Group] The Bear - 01 (1080p)", id: "b1" }),
    ],
    "",
  );
  assert.equal(
    ranked.filter((r) => r.bestPick).length,
    2,
    "different shows stay in different groups",
  );
}

// The exact variants observed in QA: four rows, same episode, one "Best".
{
  const ranked = rankResults(
    [
      base({ title: "One Piece - 1170.mkv", id: "v1", seeders: 50 }),
      base({
        title: "One Piece - Ep1170 TVer AAC2.0 H.264",
        id: "v2",
        seeders: 900,
      }),
      base({
        title: "One Piece - Ep1170 REPACK CR AAC2.0 H.264",
        id: "v3",
        seeders: 300,
      }),
      base({ title: "One Piece - 1170", id: "v4", seeders: 100 }),
    ],
    "One Piece",
  );
  const picks = ranked.filter((r) => r.bestPick);
  assert.equal(
    picks.length,
    1,
    `same episode across encodes = one group, got ${picks.length}`,
  );
  assert.equal(picks[0]?.id, "v2", "best pick is the strongest of the group");
}

// Four-digit anime numbering must not be treated as a different show per row.
{
  const ranked = rankResults(
    [
      base({ title: "[A] One Piece - 1170 (1080p)", id: "n1" }),
      base({ title: "[B] One Piece - 1170 [720p]", id: "n2" }),
      base({ title: "[C] One Piece - 1171 (1080p)", id: "n3" }),
    ],
    "One Piece",
  );
  assert.equal(
    ranked.filter((r) => r.bestPick).length,
    2,
    "two episodes → two groups, regardless of the four-digit number",
  );
}

// Visual QC found Ep 1170 carrying four "Best" badges: the streaming-platform
// token was the only difference between rows, and the no-separator fansub form
// never parsed an episode at all so it grouped on its own.
{
  const ranked = rankResults(
    [
      base({ title: "[SubsPlease] One Piece - 1170 (1080p)", id: "p1", seeders: 900 }),
      base({ title: "One Piece - 1170 [Bili 1080p]", id: "p2", seeders: 40 }),
      base({ title: "One Piece - 1170 [iQ WEB-DL 1080p]", id: "p3", seeders: 30 }),
      base({ title: "[HatSubs] One Piece 1170 (WEB 1080p)", id: "p4", seeders: 20 }),
      base({ title: "One Piece - 1170 [B-Global 2160p]", id: "p5", seeders: 10 }),
    ],
    "One Piece",
  );
  const picks = ranked.filter((r) => r.bestPick);
  assert.equal(
    picks.length,
    1,
    `one episode across platforms = one group, got ${picks.length}: ` +
      ranked.map((r) => `${r.id}=${r.groupKey}`).join(", "),
  );
  assert.equal(picks[0]?.id, "p1");
}

// The bare-number rule is gated on the fansub "[Group]" prefix and rejects
// years, so film titles that end in a number keep their identity.
{
  const ranked = rankResults(
    [
      base({ title: "[Group] Blade Runner 2049 (2160p)", id: "y1" }),
      base({ title: "Blade Runner 2049 1080p BluRay x264", id: "y2" }),
      base({ title: "[Group] Akira 1988 1080p", id: "y3" }),
    ],
    "Blade Runner",
  );
  for (const r of ranked) {
    assert.ok(
      !/\|E/.test(r.groupKey ?? ""),
      `a year was parsed as an episode: ${r.title} → ${r.groupKey}`,
    );
  }
  assert.equal(
    ranked.filter((r) => r.bestPick).length,
    2,
    "two distinct films stay in two groups",
  );
}

console.log("ranking.test.ts: all assertions passed");
