/**
 * A dead hostname must not silently delete an entire indexer.
 *
 * `yts.mx` stopped resolving from a real network while two YTS mirrors answered
 * normally. Because the adapter hardcoded one host, the movie source returned
 * nothing on every search — and "nothing" is indistinguishable from "the
 * indexer answered and had no matches". Ranking then picked from a pool missing
 * an entire source, which is how a 480p release wins.
 */
import assert from "node:assert/strict";
import { fetchFromMirrors, mirrorList } from "@/lib/torrents/adapters/mirrors";

let failures = 0;
const originalFetch = globalThis.fetch;

async function check(name: string, fn: () => void | Promise<void>) {
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

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(String(input))) as typeof fetch;
}

async function main() {
console.log("mirrorList: env override handling…");

  await check("falls back to the defaults when unset", () => {
  assert.deepEqual(mirrorList(undefined, ["https://a", "https://b"]), [
    "https://a",
    "https://b",
  ]);
});

  await check("uses the override and strips trailing slashes", () => {
  assert.deepEqual(mirrorList("https://mine/ , https://other//", ["https://a"]), [
    "https://mine",
    "https://other",
  ]);
});

  await check("ignores an override that is only separators", () => {
  assert.deepEqual(mirrorList("  , ", ["https://a"]), ["https://a"]);
});

  console.log("\nfetchFromMirrors: failover…");

  await check("skips a host that answers 403 and uses the next", async () => {
  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return url.startsWith("https://dead")
      ? new Response("blocked", { status: 403 })
      : new Response("ok", { status: 200 });
  });
  const res = await fetchFromMirrors({
    key: "t-403",
    hosts: ["https://dead", "https://live"],
    path: (h) => `${h}/q`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://dead/q", "https://live/q"]);
});

  await check("skips a host that fails at the network level", async () => {
  stubFetch((url) => {
    if (url.startsWith("https://unresolvable")) throw new Error("fetch failed");
    return new Response("ok", { status: 200 });
  });
  const res = await fetchFromMirrors({
    key: "t-net",
    hosts: ["https://unresolvable", "https://live"],
    path: (h) => `${h}/q`,
  });
  assert.equal(res.status, 200);
});

  await check("remembers the working host so failover is paid once", async () => {
  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return url.startsWith("https://dead")
      ? new Response("", { status: 500 })
      : new Response("ok", { status: 200 });
  });
  const args = {
    key: "t-sticky",
    hosts: ["https://dead", "https://live"],
    path: (h: string) => `${h}/q`,
  };
  await fetchFromMirrors(args);
  seen.length = 0;
  await fetchFromMirrors(args);
  assert.deepEqual(
    seen,
    ["https://live/q"],
    "second call should skip the dead host",
  );
});

  await check("stops preferring a host once it starts failing", async () => {
  const args = {
    key: "t-demote",
    hosts: ["https://a", "https://b"],
    path: (h: string) => `${h}/q`,
  };
  stubFetch(() => new Response("ok", { status: 200 }));
  await fetchFromMirrors(args);

  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return url.startsWith("https://a")
      ? new Response("", { status: 503 })
      : new Response("ok", { status: 200 });
  });
  await fetchFromMirrors(args);
  seen.length = 0;
  await fetchFromMirrors(args);
  assert.deepEqual(seen, ["https://b/q"], "the failed host should be demoted");
});

  await check(
  "throws when every mirror fails, so the source reports an outage",
  async () => {
    stubFetch(() => new Response("", { status: 503 }));
    await assert.rejects(() =>
      fetchFromMirrors({
        key: "t-alldead",
        hosts: ["https://a", "https://b"],
        path: (h) => `${h}/q`,
      }),
    );
  },
);

  await check(
  "passes through a 4xx that means 'bad request', not 'dead host'",
  async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return new Response("nope", { status: 400 });
    });
    const res = await fetchFromMirrors({
      key: "t-400",
      hosts: ["https://a", "https://b"],
      path: (h) => `${h}/q`,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(seen, ["https://a/q"], "a 400 must not burn every mirror");
  },
);

}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll mirror failover tests passed.");
});