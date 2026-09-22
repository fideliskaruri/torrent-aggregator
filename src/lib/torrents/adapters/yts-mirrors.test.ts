/**
 * YTS must survive a blocked mirror without going silently dark.
 *
 * Observed on a real network: `yts.mx` and `yts.lt` answered with a challenge
 * page / a redirect to an HTML portal, while `movies-api.accel.li` served the
 * JSON API normally. Status alone says 200 for all three, so an adapter that
 * trusts the status pins a dead host and then throws in `res.json()` on every
 * search — the movie source contributes nothing and the UI reports "no
 * release", which is the wrong sentence for an unreachable indexer.
 *
 * These are fixtures, not live calls: no network, no real torrents, and no
 * assertion that any particular third-party domain is up. The point is the
 * *behaviour* — fail over on a non-API body, parse the first real API answer,
 * and throw (never return an empty list) when every mirror is blocked.
 */
import assert from "node:assert/strict";
import { mirrorList } from "@/lib/torrents/adapters/mirrors";
import { YtsAdapter } from "@/lib/torrents/adapters/yts";

let failures = 0;
const originalFetch = globalThis.fetch;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** One movie, two torrents — the shape the public API returns. */
const API_BODY = JSON.stringify({
  data: {
    movies: [
      {
        id: 101,
        title: "Ninja Assassin",
        title_long: "Ninja Assassin (2009)",
        slug: "ninja-assassin-2009",
        year: 2009,
        imdb_code: "tt1186367",
        medium_cover_image: "https://img.example/ninja.jpg",
        torrents: [
          { hash: "AAAA", quality: "1080p", type: "bluray", size: "1.4 GB", seeds: 40, peers: 5 },
          { hash: "BBBB", quality: "720p", type: "bluray", size: "800 MB", seeds: 90, peers: 9 },
        ],
      },
    ],
  },
});

/** Cloudflare-style interstitial: HTTP 200, HTML body. */
function challengePage() {
  return new Response("<!DOCTYPE html><title>Just a moment...</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** A mirror that redirects to a portal page: fetch follows it, HTML lands. */
function redirectedPortal() {
  return new Response("<html><body>blocked by your network</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function apiPage() {
  return new Response(API_BODY, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stub(handler: (url: string) => Response) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  return seen;
}

async function main() {
  console.log("yts: configured mirrors…");

  await check("the built-in order is preserved and the env value only leads", () => {
    assert.deepEqual(
      mirrorList("https://yts.example/api/v2", [
        "https://yts.mx/api/v2",
        "https://yts.lt/api/v2",
        "https://movies-api.accel.li/api/v2",
      ]),
      [
        "https://yts.example/api/v2",
        "https://yts.mx/api/v2",
        "https://yts.lt/api/v2",
        "https://movies-api.accel.li/api/v2",
      ],
      "an env override must add a mirror, never delete the working fallbacks",
    );
  });

  console.log("\nyts: failover behaviour…");

  await check("a blocked host and a redirected portal both fail over to the API", async () => {
    const seen = stub((url) => {
      if (url.includes("yts.mx")) return challengePage();
      if (url.includes("yts.lt")) return redirectedPortal();
      return apiPage();
    });
    // A fresh adapter instance still shares the module-level preferred-host
    // memory keyed "yts"; the assertions below only require that the JSON host
    // is the one that answered.
    const results = await new YtsAdapter().search({ query: "ninja assassin", category: "movies" });
    assert.ok(
      seen.some((u) => u.includes("movies-api.accel.li")),
      "the JSON mirror must actually be tried",
    );
    assert.equal(results.length, 2);
    assert.ok(results[0].title.includes("Ninja Assassin (2009)"));
    assert.equal(results[0].seeders, 90, "results are ordered by seeders");
    assert.ok(results[0].magnet?.startsWith("magnet:?xt=urn:btih:bbbb"));
    assert.equal(results[0].sizeBytes, 800_000_000);
  });

  await check("every mirror blocked throws, so the source reports an outage", async () => {
    stub(() => challengePage());
    await assert.rejects(
      () => new YtsAdapter().search({ query: "ninja assassin", category: "movies" }),
      "an empty array here would be read as 'this film has no release'",
    );
  });

  await check("a non-movie category is skipped without touching the network", async () => {
    const seen = stub(() => apiPage());
    const results = await new YtsAdapter().search({ query: "severance", category: "tv" });
    assert.deepEqual(results, []);
    assert.deepEqual(seen, []);
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll YTS mirror tests passed.");
});
