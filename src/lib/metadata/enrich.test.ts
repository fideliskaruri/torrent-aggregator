/**
 * Catalogs are full of a film and a series that share a name. "Severance" is a
 * 2015 horror comedy and a 2022 Apple TV+ series, both an exact title match, so
 * whichever TMDB listed first used to win — and the wrong id was then written
 * to the library row, where every later episode hunt used it.
 */
import assert from "node:assert/strict";
import { resolveMetadata } from "./enrich";

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

const TMDB_SEVERANCE = {
  results: [
    {
      id: 348669,
      media_type: "movie",
      title: "Severance",
      release_date: "2015-07-15",
      poster_path: "/movie.jpg",
      vote_average: 5.8,
      genre_ids: [27, 35],
      original_language: "en",
    },
    {
      id: 95396,
      media_type: "tv",
      name: "Severance",
      first_air_date: "2022-02-17",
      poster_path: "/tv.jpg",
      vote_average: 8.4,
      genre_ids: [18, 9648],
      original_language: "en",
    },
  ],
};

function stubFetch(payload: unknown) {
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("api.themoviedb.org")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // AniList and anything else contribute nothing to this scenario.
    return new Response(JSON.stringify({ data: { Page: { media: [] } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function main() {
  console.log("metadata/enrich media-type arbitration");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = "test-key";
  stubFetch(TMDB_SEVERANCE);

  try {
    const asTv = await resolveMetadata("Severance", "tv");
    check("a tv request takes the series, not the same-named film", () => {
      assert.equal(asTv?.mediaType, "tv");
      assert.equal(asTv?.externalId, "95396");
    });

    const asMovie = await resolveMetadata("Severance ", "movies");
    check("a movies request takes the film", () => {
      assert.equal(asMovie?.mediaType, "movie");
      assert.equal(asMovie?.externalId, "348669");
    });

    const unfiltered = await resolveMetadata("Severance  ", "all");
    check("with no category stated, either answer is acceptable", () => {
      assert.ok(unfiltered, "expected a match");
      assert.ok(["95396", "348669"].includes(unfiltered.externalId));
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
