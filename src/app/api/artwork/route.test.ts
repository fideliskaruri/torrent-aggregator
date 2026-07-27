/**
 * The batch artwork endpoint is the only seam between a client-rendered list
 * of release names and the artwork resolver, so three separate promises are
 * made here and all three used to be assumed rather than checked:
 *
 *  - it answers keyed the way its callers key their rows, or every page shows
 *    letter tiles while the network tab shows a perfectly good 200;
 *  - it is *bounded*, because the Client page polls every five seconds and a
 *    caller with a thousand rows must not become a thousand upstream lookups;
 *  - it never fails the caller, because artwork is decoration and a page of
 *    letter tiles is a working page while a 500 is a broken one.
 *
 * Nothing here touches the network: `globalThis.fetch` is stubbed, so the
 * assertions are about this route's behaviour and not about TMDB's mood.
 */
import assert from "node:assert/strict";
import { POST } from "./route";
import { resetArtworkCache } from "@/lib/metadata/artwork";
import { artworkKey } from "@/lib/metadata/release-art";

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

const KEY = "0123456789abcdef0123456789abcdef";

let searchCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;

/**
 * TMDB answers every query with one exactly-matching film, dated to whatever
 * year was asked for. Echoing the year matters: the resolver deliberately
 * re-searches without the year when a year-scoped search matched nothing, so a
 * stub that always answered "2024" would make every call look like two.
 */
function installFetch(titleFor: (query: string) => string = (q) => q) {
  searchCalls = [];
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input instanceof URL ? input.toString() : input);
    searchCalls.push(url);
    const params = new URL(url).searchParams;
    const query = decodeURIComponent(params.get("query") ?? "");
    const year =
      params.get("year") ?? params.get("first_air_date_year") ?? "2024";
    const body = url.includes("api.themoviedb.org")
      ? {
          results: [
            {
              id: 1,
              media_type: "movie",
              title: titleFor(query),
              release_date: `${year}-02-27`,
              poster_path: "/p.jpg",
              backdrop_path: "/b.jpg",
              popularity: 9,
            },
          ],
        }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function post(body: string): Request {
  return new Request("http://localhost/api/artwork", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

interface ArtworkBody {
  artwork: Record<string, { posterUrl: string | null; backdropUrl: string | null }>;
}

async function main() {
  originalFetch = globalThis.fetch;
  const originalKey = process.env.TMDB_API_KEY;
  try {
    await answers();
    await bounded();
    await neverFails();
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

async function answers() {
  console.log("api/artwork answers");

  resetArtworkCache();
  process.env.TMDB_API_KEY = KEY;
  installFetch();

  const res = await POST(
    post(
      JSON.stringify({
        items: [
          { title: "Dune Part Two", year: 2024, mediaType: "movie" },
          { title: "Arrival", year: 2016, mediaType: "movie" },
        ],
      }),
    ),
  );
  const body = (await res.json()) as ArtworkBody;

  check("answers are keyed the way callers key their rows", () => {
    // Not "some key exists" — the exact key the pages compute from a release
    // name, which is the whole contract between this route and the hook.
    assert.ok(body.artwork[artworkKey("Dune Part Two", 2024)]);
    assert.ok(body.artwork[artworkKey("Arrival", 2016)]);
  });

  check("posters and backdrops both come back", () => {
    const art = body.artwork[artworkKey("Dune Part Two", 2024)];
    assert.equal(art.posterUrl, "https://image.tmdb.org/t/p/w500/p.jpg");
    assert.equal(art.backdropUrl, "https://image.tmdb.org/t/p/w1280/b.jpg");
  });

  check("a row nothing matched is reported, not omitted as an error", () => {
    assert.equal(
      Object.keys(body.artwork).length,
      2,
      "every requested row should appear in the answer",
    );
  });

  resetArtworkCache();
  // Every search now answers with a *different instalment* of the franchise,
  // which the matcher must refuse rather than dress the row in.
  installFetch(() => "Dune: Part Two");
  const refused = await POST(
    post(
      JSON.stringify({
        items: [{ title: "Dune", year: 2021, mediaType: "movie" }],
      }),
    ),
  );
  const refusedBody = (await refused.json()) as ArtworkBody;

  check("a refused match is still reported, as nulls, under its own key", () => {
    // The caller must be able to tell "asked and there is none" from "not
    // asked yet" — that difference is what stops the hook re-querying a
    // hopeless title on every five-second poll.
    const art = refusedBody.artwork[artworkKey("Dune", 2021)];
    assert.ok(art, "the key must be present even when nothing matched");
    assert.equal(art.posterUrl, null);
    assert.equal(art.backdropUrl, null);
  });

  resetArtworkCache();
  installFetch();
  const blanks = await POST(
    post(
      JSON.stringify({
        items: [
          { title: "   " },
          { title: "" },
          { title: null },
          { title: "Arrival", year: 2016, mediaType: "movie" },
        ],
      }),
    ),
  );
  const blankBody = (await blanks.json()) as ArtworkBody;

  check("empty titles are dropped before anything is queried", () => {
    assert.equal(Object.keys(blankBody.artwork).length, 1);
    assert.equal(
      searchCalls.filter((u) => u.includes("api.themoviedb.org")).length,
      1,
    );
  });
}

async function bounded() {
  console.log("api/artwork bounds");

  resetArtworkCache();
  process.env.TMDB_API_KEY = KEY;
  installFetch();

  const items = Array.from({ length: 200 }, (_, i) => ({
    title: `Distinct Work ${i}`,
    year: 2000 + (i % 20),
    mediaType: "movie" as const,
  }));
  const res = await POST(post(JSON.stringify({ items })));
  const body = (await res.json()) as ArtworkBody;

  check("a caller cannot ask for more than the cap", () => {
    assert.equal(Object.keys(body.artwork).length, 60);
  });

  check("the cap is enforced before the lookups, not after", () => {
    // Trimming the *response* would still have sent 200 requests upstream,
    // which is the thing the cap exists to prevent.
    const searches = searchCalls.filter((u) => u.includes("api.themoviedb.org"));
    assert.equal(searches.length, 60);
  });
}

async function neverFails() {
  console.log("api/artwork never fails the caller");

  resetArtworkCache();
  process.env.TMDB_API_KEY = KEY;
  installFetch();

  const malformed = await POST(post("{not json at all"));
  check("a malformed body is an empty answer, not a 400", () => {
    assert.equal(malformed.status, 200);
  });
  check("a malformed body queries nothing", () => {
    assert.equal(searchCalls.length, 0);
  });

  const wrongShape = await POST(post(JSON.stringify({ items: "nope" })));
  const wrongBody = (await wrongShape.json()) as ArtworkBody;
  check("a body of the wrong shape is an empty answer", () => {
    assert.equal(wrongShape.status, 200);
    assert.deepEqual(wrongBody.artwork, {});
  });

  resetArtworkCache();
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("network is down");
  };
  let dead: Response | null = null;
  let threw: unknown = null;
  try {
    dead = await POST(
      post(
        JSON.stringify({
          items: [{ title: "Arrival", year: 2016, mediaType: "movie" }],
        }),
      ),
    );
  } catch (err) {
    threw = err;
  }
  const deadBody = dead ? ((await dead.json()) as ArtworkBody) : null;
  check("a dead network degrades to nulls, never to a status the caller must handle", () => {
    assert.equal(threw, null, "the route must not throw");
    assert.equal(dead?.status, 200);
    assert.deepEqual(deadBody?.artwork[artworkKey("Arrival", 2016)], {
      posterUrl: null,
      backdropUrl: null,
    });
  });
}

main().then(
  () => undefined,
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
