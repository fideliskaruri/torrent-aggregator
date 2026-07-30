/**
 * Title-grouping rule class — the pure heart of the title-centric search.
 *
 * Table-driven so a regression in any one rule (collapse to one card per work,
 * best-match-first ordering, future-gating, unknown-date never gated) fails
 * loudly across many inputs rather than passing on the one example that was in
 * the complaint.
 */
import assert from "node:assert/strict";
import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import { groupTitles } from "./group-titles";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

let seq = 0;
function rel(title: string, overrides: Partial<TorrentResult> = {}): TorrentResult {
  seq += 1;
  return {
    id: `r-${seq}`,
    title,
    magnet: `magnet:?xt=urn:btih:${seq}`,
    sizeBytes: 1_000_000_000,
    seeders: 100,
    leechers: 1,
    source: "apibay",
    sourceUrl: "https://example.test",
    tags: [],
    ...overrides,
  };
}

function meta(overrides: Partial<MediaMetadata>): MediaMetadata {
  return {
    source: "tmdb",
    mediaType: "movie",
    externalId: "x",
    title: "Untitled",
    ...overrides,
  };
}

const NOW = new Date("2026-07-28T00:00:00Z");

console.log("group-titles: title-centric collapse + gating…");

check("collapses many releases of one film into a single card", () => {
  const titles = groupTitles(
    [
      rel("Dune Part Two 2024 2160p WEB-DL x265"),
      rel("Dune Part Two 2024 1080p BluRay x264"),
      rel("Dune.Part.Two.2024.1080p.WEBRip"),
    ],
    NOW,
  );
  assert.equal(titles.length, 1, "one work, one card");
  assert.equal(titles[0].releases.length, 3, "all prints kept under the card");
});

check("keeps two films that share a name but differ by year apart", () => {
  const titles = groupTitles(
    [rel("Dune 2021 2160p WEB-DL"), rel("Dune 1984 1080p BluRay")],
    NOW,
  );
  assert.equal(titles.length, 2, "1984 and 2021 are different films");
  const years = titles.map((t) => t.year).sort();
  assert.deepEqual(years, [1984, 2021]);
});

check("emits works best-match-first, preserving server rank order", () => {
  const titles = groupTitles(
    [
      rel("Some Show S01E01 1080p"),
      rel("Another Movie 2020 1080p"),
      rel("Some Show S01E02 1080p"),
    ],
    NOW,
  );
  // Group order follows the first-seen release of each work.
  assert.equal(titles[0].isSeries, true);
  assert.match(titles[0].name, /Some Show/i);
  assert.match(titles[1].name, /Another Movie/i);
});

check("a query reorders cards by name relevance, not release rank", () => {
  // Release rank (server order) would put the well-seeded substring match first;
  // the exact-name match arrived last. With the query, the exact title wins and
  // the tangential substring match ("Maelstrom …") sinks below it.
  const titles = groupTitles(
    [
      rel("Maelstrom The Odyssey of Waterworld 2018 1080p WEB-DL"),
      rel("Troy The Odyssey 2017 1080p BluRay"),
      rel("The Odyssey XXX Part 1 2026 1080p"),
      rel("The Odyssey 1997 1080p BluRay"),
    ],
    NOW,
    "the odyssey",
  );
  assert.match(titles[0].name, /^The Odyssey$/i); // exact name is now best match
  const exactIndex = titles.findIndex((t) => /^The Odyssey$/i.test(t.name));
  const maelstromIndex = titles.findIndex((t) => /Maelstrom/i.test(t.name));
  assert.ok(
    exactIndex < maelstromIndex,
    "exact-name match must rank above the tangential substring match",
  );
});

check("without a query, order stays at server rank (no relevance pass)", () => {
  const titles = groupTitles(
    [
      rel("Maelstrom The Odyssey of Waterworld 2018 1080p"),
      rel("The Odyssey 1997 1080p"),
    ],
    NOW,
  );
  assert.match(titles[0].name, /Maelstrom/i); // unchanged: first-seen wins
});

check("groups a series' episodes into one card, marked as a series", () => {
  const titles = groupTitles(
    [
      rel("The Boys S05E01 1080p WEB h264"),
      rel("The Boys S05E02 1080p WEB h264"),
      rel("The Boys S05E03 2160p WEB h265"),
    ],
    NOW,
  );
  assert.equal(titles.length, 1);
  assert.equal(titles[0].isSeries, true);
  assert.equal(titles[0].releases.length, 3);
});

check("future-dated work is gated: unreleased + Coming label, actions blocked", () => {
  const titles = groupTitles(
    [
      rel("The Odyssey 2026 1080p WEB-DL", {
        metadata: meta({ title: "The Odyssey", releaseDate: "2027-05-01" }),
      }),
    ],
    NOW,
  );
  assert.equal(titles.length, 1);
  assert.equal(titles[0].status.unreleased, true, "in the future → gated");
  assert.ok(titles[0].status.comingLabel, "carries a Coming label");
});

check("unknown release date is NEVER gated", () => {
  const titles = groupTitles(
    [
      rel("Mystery Film 2025 1080p WEB-DL", {
        metadata: meta({ title: "Mystery Film", releaseDate: null }),
      }),
    ],
    NOW,
  );
  assert.equal(titles[0].status.unreleased, false, "no date is not a future date");
  assert.equal(titles[0].status.comingLabel, null);
});

check("past release date behaves as a normal, playable result", () => {
  const titles = groupTitles(
    [
      rel("Old Classic 1994 1080p BluRay", {
        metadata: meta({ title: "Old Classic", releaseDate: "1994-09-10" }),
      }),
    ],
    NOW,
  );
  assert.equal(titles[0].status.unreleased, false);
  assert.equal(titles[0].status.released, true);
});

check("a mis-matched catalog date cannot gate a work it does not name", () => {
  // Catalog title disagrees with the release's own name, so its future date
  // must not gray out a title that is actually available.
  const titles = groupTitles(
    [
      rel("Children of Dune 2003 1080p", {
        metadata: meta({ title: "Dune", releaseDate: "2099-01-01" }),
      }),
    ],
    NOW,
  );
  assert.equal(
    titles[0].status.unreleased,
    false,
    "an untrusted catalog match may not gate the work",
  );
});

check("named works expose a title-page href; best is the top release", () => {
  const titles = groupTitles(
    [rel("Inception 2010 1080p BluRay"), rel("Inception 2010 2160p WEB-DL")],
    NOW,
  );
  assert.equal(titles.length, 1);
  assert.ok(titles[0].href && titles[0].href.startsWith("/title/"));
  assert.equal(titles[0].best.id, titles[0].releases[0].id, "best = rank #1");
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll group-titles tests passed.");
