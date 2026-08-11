/**
 * Regressions for compact title-search reliability.
 *
 * Live defect: `/api/search/titles?q=moonkn` ranked Moon Knight first, but
 * `MOONKN` intermittently timed out and `/api/suggest?q=MOONKN` dropped Moon
 * Knight out of the top slots while `moonkn` worked. Casing/whitespace variants
 * were reaching the providers verbatim, so each variant took its own cold
 * upstream path. These tests pin one canonical query for every variant, and pin
 * that one provider failing degrades to partial results instead of failing the
 * whole endpoint — while a total failure is still reported truthfully.
 */
import assert from "node:assert/strict";
import { canonicalizeSearchQuery, displaySearchQuery } from "./query-variants";
import {
  AllProvidersFailedError,
  searchWorksByScope,
  type WorkSearchProviders,
} from "./work-search-fanout";
import { collectSuggestions, type SuggestProviders } from "./suggest";
import { workSearchHitFromMetadata, type WorkSearchHit } from "./work-search";
import { searchTmdbByType } from "@/lib/metadata/tmdb";
import { searchAniList } from "@/lib/metadata/anilist";
import type { MediaMetadata } from "@/lib/torrents/types";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

/** Every spelling the owner typed live, plus trimmed/uppercase/spaced forms. */
const QUERY_VARIANTS = [
  "moonkn",
  "moonknight",
  "moonknigt",
  "  moonkn  ",
  "MOONKN",
  "MoonKnight",
  "moon  knight",
  "moon\u00a0knight",
] as const;

const CANONICAL: Record<string, string> = {
  moonkn: "moonkn",
  moonknight: "moonknight",
  moonknigt: "moonknigt",
  "  moonkn  ": "moonkn",
  MOONKN: "moonkn",
  MoonKnight: "moonknight",
  "moon  knight": "moon knight",
  "moon\u00a0knight": "moon knight",
};

function metadata(title: string, source: "tmdb" | "anilist" = "tmdb"): MediaMetadata {
  return {
    source,
    mediaType: source === "anilist" ? "anime" : "tv",
    externalId: `${source}-${title}`,
    title,
    year: 2022,
    posterUrl: null,
    synopsis: null,
    releaseDate: "2022-03-30",
    genres: [],
  };
}

function hit(title: string): WorkSearchHit {
  const value = workSearchHitFromMetadata(metadata(title), "series");
  assert.ok(value);
  return value;
}

async function run() {
  for (const raw of QUERY_VARIANTS) {
    await check(`given "${raw}", canonicalization yields "${CANONICAL[raw]}"`, () => {
      assert.equal(canonicalizeSearchQuery(raw), CANONICAL[raw]);
    });
  }

  await check(
    "suggest drops nonempty irrelevant provider noise",
    async () => {
      const providers: SuggestProviders = {
        anilist: async () => [
          {
            title: "Tsuki",
            mediaType: "anime",
            source: "anilist",
            externalId: "a1",
          },
          {
            title: "Moon",
            mediaType: "anime",
            source: "anilist",
            externalId: "a2",
          },
        ],
        tmdb: async () => [
          {
            title: "Moon Knight",
            mediaType: "tv",
            source: "tmdb",
            externalId: "t1",
          },
        ],
      };
      const outcome = await collectSuggestions("moonknigt", 4, 8, providers);
      assert.deepEqual(
        outcome.suggestions.map((suggestion) => suggestion.title),
        ["Moon Knight"],
      );
    },
  );

  await check(
    "suggest keeps an alias-only title match",
    async () => {
      const providers: SuggestProviders = {
        anilist: async () => [
          {
            title: "Pretty Guardian Sailor Moon",
            aliases: ["Bishoujo Senshi Sailor Moon"],
            mediaType: "anime",
            source: "anilist",
            externalId: "a1",
          },
        ],
        tmdb: async () => [],
      };
      const outcome = await collectSuggestions(
        "bishoujo senshi sailor moon",
        4,
        8,
        providers,
      );
      assert.deepEqual(
        outcome.suggestions.map((suggestion) => suggestion.title),
        ["Pretty Guardian Sailor Moon"],
      );
    },
  );

  await check("display query keeps the typed casing but not the stray spacing", () => {
    assert.equal(displaySearchQuery("  MoonKnight  "), "MoonKnight");
    assert.equal(displaySearchQuery("moon  knight"), "moon knight");
  });

  await check("uppercase and lowercase canonicalize to the identical string", () => {
    assert.equal(
      canonicalizeSearchQuery("MOONKN"),
      canonicalizeSearchQuery("moonkn"),
    );
    assert.equal(
      canonicalizeSearchQuery(" MOON  KNIGHT "),
      canonicalizeSearchQuery("moon knight"),
    );
  });

  for (const raw of QUERY_VARIANTS) {
    await check(`title fan-out sends the canonical query for "${raw}"`, async () => {
      const seen: string[] = [];
      const providers: WorkSearchProviders = {
        movies: async (query) => {
          seen.push(query);
          return [];
        },
        series: async (query) => {
          seen.push(query);
          return [hit("Moon Knight"), hit("Moonlight Mile")];
        },
        anime: async (query) => {
          seen.push(query);
          return [];
        },
      };
      const outcome = await searchWorksByScope("all", raw, 12, providers);
      assert.deepEqual(new Set(seen), new Set([CANONICAL[raw]]));
      assert.equal(outcome.query, CANONICAL[raw]);
      assert.equal(outcome.results[0]?.title, "Moon Knight");
      assert.equal(outcome.partial, false);
      assert.deepEqual(outcome.failed, []);
    });
  }

  await check(
    "given one failing provider, title search returns the categories that answered",
    async () => {
      const providers: WorkSearchProviders = {
        movies: async () => {
          throw new Error("TMDB HTTP 503");
        },
        series: async () => [hit("Moon Knight")],
        anime: async () => [],
      };
      const outcome = await searchWorksByScope("all", "MOONKN", 12, providers);
      assert.equal(outcome.results.length, 1);
      assert.equal(outcome.results[0]?.title, "Moon Knight");
      assert.equal(outcome.partial, true);
      assert.deepEqual(outcome.failed, ["movies"]);
    },
  );

  await check(
    "given every provider fails, title search throws instead of returning an empty success",
    async () => {
      const providers: WorkSearchProviders = {
        movies: async () => {
          throw new Error("TMDB HTTP 503");
        },
        series: async () => {
          throw new Error("TMDB HTTP 503");
        },
        anime: async () => {
          throw new Error("AniList HTTP 500");
        },
      };
      await assert.rejects(
        () => searchWorksByScope("all", "moonkn", 12, providers),
        (error: unknown) => {
          assert.ok(error instanceof AllProvidersFailedError);
          assert.deepEqual(error.failed, ["movies", "series", "anime"]);
          return true;
        },
      );
    },
  );

  await check(
    "given a single-category scope whose provider fails, the failure is total and thrown",
    async () => {
      const providers: WorkSearchProviders = {
        movies: async () => [],
        series: async () => [],
        anime: async () => {
          throw new Error("AniList HTTP 500");
        },
      };
      await assert.rejects(
        () => searchWorksByScope("anime", "moonkn", 12, providers),
        AllProvidersFailedError,
      );
    },
  );

  for (const raw of QUERY_VARIANTS) {
    await check(`suggest ranks Moon Knight first for "${raw}"`, async () => {
      const seen: string[] = [];
      const providers: SuggestProviders = {
        anilist: async (query) => {
          seen.push(query);
          return [
            {
              title: "Moonlight Mile",
              mediaType: "anime",
              source: "anilist",
              externalId: "a1",
            },
          ];
        },
        tmdb: async (query) => {
          seen.push(query);
          return [
            {
              title: "Moon Knight",
              mediaType: "tv",
              source: "tmdb",
              externalId: "t1",
            },
            {
              title: "Moon Knight Special",
              mediaType: "tv",
              source: "tmdb",
              externalId: "t2",
            },
          ];
        },
      };
      const outcome = await collectSuggestions(raw, 4, 8, providers);
      assert.deepEqual(new Set(seen), new Set([CANONICAL[raw]]));
      assert.equal(outcome.suggestions[0]?.title, "Moon Knight");
      assert.equal(outcome.partial, false);
    });
  }

  await check(
    "given one failing suggest provider, the other provider's suggestions still return",
    async () => {
      const providers: SuggestProviders = {
        anilist: async () => {
          throw new Error("AniList HTTP 500");
        },
        tmdb: async () => [
          {
            title: "Moon Knight",
            mediaType: "tv",
            source: "tmdb",
            externalId: "t1",
          },
        ],
      };
      const outcome = await collectSuggestions("MOONKN", 4, 8, providers);
      assert.equal(outcome.suggestions[0]?.title, "Moon Knight");
      assert.equal(outcome.partial, true);
      assert.deepEqual(outcome.failed, ["anilist"]);
    },
  );

  await check(
    "given every suggest provider fails, collectSuggestions throws rather than reporting no matches",
    async () => {
      const providers: SuggestProviders = {
        anilist: async () => {
          throw new Error("AniList HTTP 500");
        },
        tmdb: async () => {
          throw new Error("TMDB HTTP 503");
        },
      };
      await assert.rejects(
        () => collectSuggestions("moonkn", 4, 8, providers),
        (error: unknown) => {
          assert.ok(error instanceof AllProvidersFailedError);
          assert.deepEqual(
            [...error.failed],
            ["anilist", "tmdb"],
            "the outage must name the providers that actually rejected",
          );
          return true;
        },
      );
    },
  );

  await check(
    "provider requests are canonical, so MOONKN and moonkn share one upstream URL",
    async () => {
      const originalFetch = globalThis.fetch;
      const originalKey = process.env.TMDB_API_KEY;
      const requested: string[] = [];
      const anilistSearches: string[] = [];
      try {
        process.env.TMDB_API_KEY = "1234567890abcdef1234567890abcdef";
        globalThis.fetch = (async (
          input: string | URL | Request,
          init?: RequestInit,
        ) => {
          const url = String(input);
          if (url.includes("anilist")) {
            const body = JSON.parse(String(init?.body)) as {
              variables: { search: string };
            };
            anilistSearches.push(body.variables.search);
            return new Response(
              JSON.stringify({ data: { Page: { media: [] } } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          requested.push(url);
          return new Response(
            JSON.stringify({
              results: [
                { id: 1, media_type: "tv", name: "Moon Knight", first_air_date: "2022-03-30" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch;

        await searchTmdbByType("tv", "MOONKN", 5);
        await searchTmdbByType("tv", "  moonkn ", 5);
        assert.deepEqual(
          requested.map((url) => new URL(url).searchParams.get("query")),
          ["moonkn", "moonkn"],
        );
        assert.equal(requested[0], requested[1]);

        await searchAniList("MOON  KNIGHT", 4);
        assert.equal(
          anilistSearches[0],
          "moon knight",
          "the first outbound AniList search must be the canonical query",
        );
      } finally {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.TMDB_API_KEY;
        else process.env.TMDB_API_KEY = originalKey;
      }
    },
  );

  if (failures > 0) {
    console.error(`FAIL search canonicalization (${failures})`);
    process.exit(1);
  }
  console.log("PASS search canonicalization and partial-provider degradation");
}

run().catch((error) => {
  console.error("FAIL search canonicalization", error);
  process.exit(1);
});
