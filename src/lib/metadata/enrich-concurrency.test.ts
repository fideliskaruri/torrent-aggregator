/**
 * Enrichment latency contract.
 *
 * One page of results used to ask the catalogs the same question once per
 * release title, sequentially behind a primary lookup that could have run
 * while the indexers were still answering. Both are latency bugs, and both
 * must stay fixed without changing a single attached record.
 *
 * Run: npx tsx src/lib/metadata/enrich-concurrency.test.ts
 */
import assert from "node:assert/strict";
import type { MediaMetadata, TorrentResult } from "@/lib/torrents/types";
import { enrichResultsWithMetadata } from "./enrich";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

const ANILIST_WORK = {
  id: 90210,
  title: { romaji: "Zephyr Chronicle", english: "Zephyr Chronicle", native: null },
  coverImage: { large: "https://s4.anilist.co/cover.jpg", extraLarge: null },
  bannerImage: "https://s4.anilist.co/banner.jpg",
  description: "A test work.",
  averageScore: 80,
  seasonYear: 2021,
  startDate: { year: 2021, month: 4, day: 3 },
  genres: ["Action"],
  format: "TV",
  episodes: 12,
  nextAiringEpisode: null,
};

function result(title: string, index: number): TorrentResult {
  return {
    id: `t${index}`,
    source: "nyaa",
    title,
    magnet: `magnet:?xt=urn:btih:${index.toString(16).padStart(40, "0")}`,
    sizeBytes: 1_000_000,
    seeders: 10,
    leechers: 1,
    category: "anime",
    publishedAt: null,
  } as unknown as TorrentResult;
}

/** Counts the distinct AniList search terms one enrichment pass asks for. */
function countingFetch(terms: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("graphql.anilist.co")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { search?: string };
      };
      terms.push(body.variables?.search ?? "");
      return new Response(
        JSON.stringify({ data: { Page: { media: [ANILIST_WORK] } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function main() {
  console.log("metadata/enrich concurrency");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  delete process.env.TMDB_API_KEY;

  try {
    const terms: string[] = [];
    globalThis.fetch = countingFetch(terms);

    const results = Array.from({ length: 8 }, (_, i) =>
      result(`Zephyr Chronicle S01E0${i + 1} 1080p WEB-DL x265`, i),
    );
    const enriched = await enrichResultsWithMetadata(
      results,
      "Zephyr Chronicle",
      "anime",
    );

    check("every release still gets the catalog record", () => {
      assert.equal(enriched.length, 8);
      for (const row of enriched) {
        assert.equal(row.metadata?.externalId, "90210");
        assert.equal(row.metadata?.title, "Zephyr Chronicle");
      }
    });

    check("the same question is asked upstream exactly once", () => {
      const distinct = new Set(terms.map((t) => t.toLowerCase()));
      assert.equal(
        distinct.size,
        1,
        `expected one distinct catalog term, saw ${[...distinct].join(", ")}`,
      );
      assert.equal(
        terms.length,
        1,
        `six title lookups plus the primary must share one request, saw ${terms.length}`,
      );
    });

    // The caller may start the query's own lookup alongside the indexer
    // fan-out and hand the promise over. Whatever it resolves to must be the
    // record enrichment treats as `primary` — the overlap must not change a
    // single attached row.
    terms.length = 0;
    const handedOver: MediaMetadata = {
      source: "anilist",
      mediaType: "anime",
      externalId: "90210",
      title: "Zephyr Chronicle",
      posterUrl: "https://s4.anilist.co/cover.jpg",
      backdropUrl: null,
      synopsis: null,
      rating: null,
      year: 2021,
      releaseDate: "2021-04-03",
      genres: [],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const overlapped = await enrichResultsWithMetadata(
      [result("Zephyr Chronicle S02E01 2160p WEB-DL", 99)],
      "Zephyr Chronicle",
      "anime",
      Promise.resolve(handedOver),
    );
    check("an already-started primary lookup is the one that is used", () => {
      assert.equal(overlapped[0].metadata?.externalId, "90210");
    });

    const noPrimary = await enrichResultsWithMetadata(
      [result("Totally Unrelated Release 2160p", 98)],
      "Totally Unrelated Release",
      "anime",
      Promise.resolve(handedOver),
    );
    check("a handed-over primary is still rejected when it does not match", () => {
      assert.equal(noPrimary[0].metadata, null);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = originalKey;
  }

  if (failures > 0) {
    console.error(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("  all passed");
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
