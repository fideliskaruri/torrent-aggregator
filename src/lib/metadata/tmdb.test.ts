/**
 * The TMDB key gate.
 *
 * `.env` carried `TMDB_API_KEY=xx` and the old gate was
 * `process.env.TMDB_API_KEY || undefined`, so TMDB reported itself configured,
 * every request 401'd, `enrich` swallowed the throw, and every movie and TV
 * card rendered as a grey letter tile for months with no error anywhere. The
 * gate has to make that state look exactly like "no key", so the keyless
 * providers take over — while still accepting a real 32-character key.
 */
import assert from "node:assert/strict";

import {
  backdropUrl,
  hasTmdbKey,
  isUsableTmdbKey,
  posterUrl,
  searchTmdbCandidates,
  tmdbApiKey,
} from "./tmdb";

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

/** Shape of a real TMDB v3 key: 32 hex characters. */
const REAL_SHAPED_KEY = "6f1a2b3c4d5e6f708192a3b4c5d6e7f8";

async function main() {
  const originalKey = process.env.TMDB_API_KEY;
  const originalFetch = globalThis.fetch;

  try {
    console.log("metadata/tmdb key gate");

    // The whole point: a real key must still work. A gate that rejects the key
    // the user just configured is worse than the bug it fixes.
    const ACCEPT = [
      REAL_SHAPED_KEY,
      `  ${REAL_SHAPED_KEY}  `,
      "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI2ZjFhMmIzYyJ9.abcdef",
      "abc1234567",
    ];
    for (const key of ACCEPT) {
      check(`accepts a real key (${key.trim().length} chars)`, () => {
        assert.equal(isUsableTmdbKey(key), true);
      });
    }

    const REJECT = [
      undefined,
      "",
      "   ",
      "xx",
      "XX",
      "xxxxxxxxxxxxxxxxxxxx",
      "00000000000000000000",
      "--------------------",
      "changeme",
      "placeholder",
      "your_api_key_here",
      "YOUR_TMDB_API_KEY",
      "<your api key>",
      "put-your-key-here",
      "todo",
      "short",
    ];
    for (const key of REJECT) {
      check(`rejects ${JSON.stringify(key)}`, () => {
        assert.equal(isUsableTmdbKey(key), false);
      });
    }

    process.env.TMDB_API_KEY = `  ${REAL_SHAPED_KEY}  `;
    check("the key is trimmed before use", () => {
      assert.equal(tmdbApiKey(), REAL_SHAPED_KEY);
      assert.equal(hasTmdbKey(), true);
    });

    process.env.TMDB_API_KEY = "xx";
    check("a placeholder reads as no key at all", () => {
      assert.equal(tmdbApiKey(), null);
      assert.equal(hasTmdbKey(), false);
    });

    // A gate that still fires the request is not a gate.
    let requests = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      requests += 1;
      return new Response("{}", { status: 200 });
    };
    const gated = await searchTmdbCandidates("movie", "Dune", { year: 2021 });
    check("a placeholder key issues no request at all", () => {
      assert.deepEqual(gated, []);
      assert.equal(requests, 0);
    });

    console.log("metadata/tmdb search");

    process.env.TMDB_API_KEY = REAL_SHAPED_KEY;
    const seen: string[] = [];
    (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      return new Response(
        JSON.stringify({
          results: [
            {
              id: 438631,
              media_type: "movie",
              title: "Dune",
              release_date: "2021-09-15",
              poster_path: "/gDzOcq0pfeCeqMBwKIJlSmQpjkZ.jpg",
              backdrop_path: "/qVgZu5BTx6pu4owCvVOm4zjTfOi.jpg",
              popularity: 34.12,
              vote_count: 12000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const movies = await searchTmdbCandidates("movie", "Dune", { year: 2021 });
    check("a movie search sends year=", () => {
      assert.ok(seen[0].includes("/search/movie"), seen[0]);
      assert.ok(seen[0].includes("year=2021"), seen[0]);
    });
    check("posters and backdrops are built at usable sizes", () => {
      assert.equal(
        movies[0].posterUrl,
        "https://image.tmdb.org/t/p/w500/gDzOcq0pfeCeqMBwKIJlSmQpjkZ.jpg",
      );
      assert.equal(
        movies[0].backdropUrl,
        "https://image.tmdb.org/t/p/w1280/qVgZu5BTx6pu4owCvVOm4zjTfOi.jpg",
      );
      assert.equal(movies[0].year, 2021);
      assert.equal(movies[0].popularity, 34.12);
    });

    seen.length = 0;
    await searchTmdbCandidates("tv", "Severance", { year: 2022 });
    check("a tv search sends first_air_date_year=", () => {
      assert.ok(seen[0].includes("/search/tv"), seen[0]);
      assert.ok(seen[0].includes("first_air_date_year=2022"), seen[0]);
      assert.ok(!seen[0].includes("&year="), seen[0]);
    });

    seen.length = 0;
    await searchTmdbCandidates("multi", "Severance", { year: 2022 });
    check("multi-search sends no year — the endpoint has no such filter", () => {
      assert.ok(seen[0].includes("/search/multi"), seen[0]);
      assert.ok(!seen[0].includes("year="), seen[0]);
    });

    check("nothing without art is dropped on the floor by mistake", () => {
      assert.equal(posterUrl(null), null);
      assert.equal(backdropUrl(undefined), null);
      assert.equal(posterUrl("/x.jpg"), "https://image.tmdb.org/t/p/w500/x.jpg");
    });

    // Rate limits are the expected failure under a browse-heavy UI. They must
    // read as "no candidates", never as an exception a page has to catch.
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response("rate limited", { status: 429 });
    const limited = await searchTmdbCandidates("movie", "Dune", {});
    check("a 429 returns no candidates instead of throwing", () => {
      assert.deepEqual(limited, []);
    });

    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("ENOTFOUND api.themoviedb.org");
    };
    const offline = await searchTmdbCandidates("movie", "Dune", {});
    check("a dead network returns no candidates instead of throwing", () => {
      assert.deepEqual(offline, []);
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
