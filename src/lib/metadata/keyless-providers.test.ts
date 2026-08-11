/**
 * The keyless providers.
 *
 * These are not decoration. TMDB rate-limits under a browse-heavy UI, a key can
 * be revoked, and a fresh clone of this repo has no key at all — in every one of
 * those states these two are the only thing between the user and a wall of grey
 * letter tiles.
 *
 * Both suites pin the two things that are easy to get wrong and invisible until
 * a human looks at the page: iTunes' square 100x100 crop in a 2:3 poster slot,
 * and the `media=movie` parameter that returns zero results through this
 * network's proxy.
 */
import assert from "node:assert/strict";

import { searchItunes, upscaleItunesArtwork } from "./itunes";
import { getTvmazeEpisodes, searchTvmazeShows } from "./tvmaze";

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

const originalFetch = globalThis.fetch;
let seen: string[] = [];

function stub(body: unknown, status = 200) {
  seen = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    seen.push(String(input));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Trimmed from a real response to `?term=dune&limit=8`. */
const ITUNES_DUNE = {
  resultCount: 5,
  results: [
    {
      trackId: 1,
      trackName: "Dune",
      kind: "feature-movie",
      releaseDate: "2021-09-15T07:00:00Z",
      artworkUrl100:
        "https://is1-ssl.mzstatic.com/image/thumb/Video116/v4/15/53/b9/pr_source.lsr/100x100bb.jpg",
    },
    {
      trackId: 2,
      trackName: "Season 11, Episode 2: Frank Falls Out the Window",
      kind: "tv-episode",
      releaseDate: "2016-01-13T08:00:00Z",
      artworkUrl100:
        "https://is1-ssl.mzstatic.com/image/thumb/Video211/v4/80/82/ce/art.png/100x100bb.png",
    },
    {
      // Audiobooks arrive with no kind and no trackName whatsoever.
      trackId: 3,
      releaseDate: "2007-05-29T07:00:00Z",
      artworkUrl100:
        "https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/6a/c7/3a/9781427201447.jpg/100x100bb.jpg",
    },
    {
      trackId: 4,
      trackName: "Dune (Original Motion Picture Soundtrack)",
      kind: "song",
      releaseDate: "2021-09-17T07:00:00Z",
      artworkUrl100:
        "https://is1-ssl.mzstatic.com/image/thumb/Music/song/100x100bb.jpg",
    },
    {
      trackId: 5,
      trackName: "Dune: Part Two",
      kind: "feature-movie",
      releaseDate: "2024-03-01T08:00:00Z",
      artworkUrl100:
        "https://is1-ssl.mzstatic.com/image/thumb/Video221/v4/71/a8/31/DUNE_PART2.lsr/100x100bb.jpg",
    },
  ],
};

/** Trimmed from a real response to `?q=severance`. */
const TVMAZE_SEVERANCE = [
  {
    score: 0.9032606,
    show: {
      id: 41425,
      name: "Severance",
      premiered: "2022-02-18",
      image: {
        medium: "https://static.tvmaze.com/uploads/images/medium/548/1371406.jpg",
        original:
          "https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg",
      },
    },
  },
  {
    score: 0.20988819,
    show: {
      id: 71234,
      name: "Aligned Reverence",
      premiered: "2025-12-05",
      image: { original: "https://static.tvmaze.com/uploads/images/o/603/1509559.jpg" },
    },
  },
  {
    score: 0.1,
    show: { id: 9, name: "No Art Here", premiered: null, image: null },
  },
];

async function main() {
  try {
    console.log("metadata/itunes artwork sizing");

    // A 100x100 square dropped into a 2:3 poster slot looks like a bug. The
    // path segment is a resize instruction, so it can be rewritten.
    check("the square 100x100 crop is rewritten to a poster shape", () => {
      assert.equal(
        upscaleItunesArtwork("https://is1-ssl.mzstatic.com/image/thumb/a/b/100x100bb.jpg"),
        "https://is1-ssl.mzstatic.com/image/thumb/a/b/600x900bb.jpg",
      );
    });
    check("a png source is rewritten too", () => {
      assert.equal(
        upscaleItunesArtwork("https://is1-ssl.mzstatic.com/image/thumb/a/b.png/100x100bb.png"),
        "https://is1-ssl.mzstatic.com/image/thumb/a/b.png/600x900bb.jpg",
      );
    });
    check("an unfamiliar URL yields nothing rather than a square", () => {
      assert.equal(upscaleItunesArtwork("https://example.com/cover.jpg"), null);
      assert.equal(upscaleItunesArtwork(null), null);
      assert.equal(upscaleItunesArtwork(undefined), null);
    });

    console.log("metadata/itunes search");

    stub(ITUNES_DUNE);
    const films = await searchItunes("dune");

    // Verified live from this machine, twice: adding media=movie or
    // entity=movie returns resultCount 0 while the bare query returns films.
    // The proxy appears to strip it. Filtering happens client-side instead.
    check("the request carries no media/entity filter", () => {
      assert.equal(seen.length, 1);
      assert.ok(!/[?&]media=/.test(seen[0]), seen[0]);
      assert.ok(!/[?&]entity=/.test(seen[0]), seen[0]);
      assert.ok(seen[0].includes("term=dune"), seen[0]);
    });
    check("only films survive the client-side kind filter", () => {
      assert.deepEqual(
        films.map((f) => f.title),
        ["Dune", "Dune: Part Two"],
      );
    });
    check("release years are parsed off the ISO timestamp", () => {
      assert.equal(films[0].year, 2021);
      assert.equal(films[1].year, 2024);
    });
    check("every returned poster is poster-shaped", () => {
      for (const film of films) {
        assert.ok(film.posterUrl?.includes("600x900bb.jpg"), String(film.posterUrl));
        assert.ok(!film.posterUrl?.includes("100x100"), String(film.posterUrl));
      }
    });

    stub("nope", 503);
    const failed = await searchItunes("dune");
    check("a 503 yields no candidates rather than an exception", () => {
      assert.deepEqual(failed, []);
    });

    console.log("metadata/tvmaze search");

    stub(TVMAZE_SEVERANCE);
    const shows = await searchTvmazeShows("severance");
    check("the original image is preferred over the small one", () => {
      assert.equal(
        shows[0].posterUrl,
        "https://static.tvmaze.com/uploads/images/original_untouched/548/1371406.jpg",
      );
    });
    check("premiered becomes a year", () => {
      assert.equal(shows[0].year, 2022);
      assert.equal(shows[1].year, 2025);
    });
    check("a show with no premiere date and no art still parses", () => {
      assert.equal(shows[2].title, "No Art Here");
      assert.equal(shows[2].year, null);
      assert.equal(shows[2].posterUrl, null);
    });
    check("TVmaze's own weak fuzzy scores are carried, not applied", () => {
      // TVmaze returned "Aligned Reverence" for a "severance" query. Whoever
      // consumes this has to judge the title; the score is a tie-break at best.
      assert.ok(shows[1].score < 0.3, String(shows[1].score));
      assert.equal(shows.length, 3);
    });

    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("ENOTFOUND api.tvmaze.com");
    };
    const offline = await searchTvmazeShows("severance");
    check("a dead network is an empty list, not an exception", () => {
      assert.deepEqual(offline, []);
    });

    stub({ not: "an array" });
    const garbage = await searchTvmazeShows("severance");
    check("an unexpected body shape is an empty list", () => {
      assert.deepEqual(garbage, []);
    });

    console.log("metadata/tvmaze episodes");

    stub([
      {
        season: 2,
        number: 1,
        name: "A Rickle in Time",
        airdate: "2015-07-26",
        runtime: 30,
        image: {
          medium: "https://static.tvmaze.com/medium.jpg",
          original: "https://static.tvmaze.com/original.jpg",
        },
      },
      {
        season: 0,
        number: 1,
        name: "Special",
        airdate: "2015-01-01",
        runtime: 10,
        image: null,
      },
      {
        season: 2,
        number: null,
        name: "Unnumbered",
      },
    ]);
    const episodes = await getTvmazeEpisodes(216);
    check("canonical numbered episodes are parsed without specials", () => {
      assert.deepEqual(episodes, [{
        season: 2,
        episode: 1,
        name: "A Rickle in Time",
        airDate: "2015-07-26",
        runtimeMin: 30,
        stillUrl: "https://static.tvmaze.com/original.jpg",
      }]);
    });
    check("the episode endpoint is scoped to the resolved show", () => {
      assert.equal(seen.length, 1);
      assert.ok(seen[0].endsWith("/shows/216/episodes"), seen[0]);
    });

    stub([], 503);
    const missingEpisodes = await getTvmazeEpisodes(216);
    check("episode provider failure yields no fabricated rows", () => {
      assert.deepEqual(missingEpisodes, []);
    });
  } finally {
    globalThis.fetch = originalFetch;
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
