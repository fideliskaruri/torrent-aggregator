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
import {
  fetchFromMirrors,
  mirrorList,
  orderMirrorHosts,
  resetMirrorMemory,
} from "@/lib/torrents/adapters/mirrors";

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

const JSON_HEADERS = { "content-type": "application/json" };

function apiOk(body = "ok") {
  return new Response(body, { status: 200, headers: JSON_HEADERS });
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
    "https://a",
  ]);
});

  await check("keeps the built-in mirrors behind an override", () => {
    // A user adding their own mirror must not lose the fallbacks — that would
    // recreate the single-point-of-failure this module exists to fix.
    assert.deepEqual(mirrorList("https://mine", ["https://a", "https://mine"]), [
      "https://mine",
      "https://a",
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
      : apiOk();
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
    return apiOk();
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
      : apiOk();
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
  stubFetch(() => apiOk());
  await fetchFromMirrors(args);

  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return url.startsWith("https://a")
      ? new Response("", { status: 503 })
      : apiOk();
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

await check(
  "rejects a 200 that is a challenge page rather than the API",
  async () => {
    // Cloudflare's "Just a moment…" interstitial is served as HTTP 200 with an
    // HTML body. Judging health by status alone would pin this host as the
    // preferred one and then throw in the adapter's res.json() on every future
    // search, with no failover ever happening — the exact failure this module
    // was written for.
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return url.startsWith("https://challenged")
        ? new Response("<!DOCTYPE html><title>Just a moment...</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : apiOk();
    });
    const res = await fetchFromMirrors({
      key: "t-challenge",
      hosts: ["https://challenged", "https://live"],
      path: (h) => `${h}/q`,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["https://challenged/q", "https://live/q"]);
  },
);

await check(
  "a proven host's 404 means 'nothing for this query', not 'host down'",
  async () => {
    const args = {
      key: "t-404-proven",
      hosts: ["https://a", "https://b"],
      path: (h: string) => `${h}/q`,
    };
    stubFetch(() => apiOk());
    await fetchFromMirrors(args);

    // Now the proven host answers 404. Several torrent APIs answer that way for
    // an empty result; demoting on it would turn "this show has no episodes"
    // into "the source is down" in the health strip.
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return new Response("", { status: 404, headers: JSON_HEADERS });
    });
    const res = await fetchFromMirrors(args);
    assert.equal(res.status, 404);
    assert.deepEqual(
      seen,
      ["https://a/q"],
      "an empty answer from a working host must not burn every mirror",
    );
  },
);

await check(
  "an unproven host's 404 still means 'wrong mirror' and fails over",
  async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return url.startsWith("https://wrongpath")
        ? new Response("not found", { status: 404 })
        : apiOk();
    });
    const res = await fetchFromMirrors({
      key: "t-404-unproven",
      hosts: ["https://wrongpath", "https://live"],
      path: (h) => `${h}/q`,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["https://wrongpath/q", "https://live/q"]);
  },
);

await check(
  "each mirror receives a fresh abort budget",
  async () => {
    const controllers: AbortController[] = [];
    const seenSignals: AbortSignal[] = [];
    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!init?.signal) throw new Error("missing signal");
      seenSignals.push(init.signal);
      if (String(input).startsWith("https://slow")) {
        controllers[0].abort();
        throw new DOMException("timed out", "AbortError");
      }
      assert.equal(init.signal.aborted, false, "fallback budget must start live");
      return apiOk();
    };
    const response = await fetchFromMirrors({
      key: "t-fresh-budget",
      hosts: ["https://slow", "https://live"],
      path: (host) => `${host}/q`,
      timeoutMs: 50,
      createSignal: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
      fetchFn,
    });
    assert.equal(response.status, 200);
    assert.equal(seenSignals.length, 2);
    assert.notEqual(seenSignals[0], seenSignals[1]);
    assert.equal(seenSignals[0].aborted, true);
    assert.equal(seenSignals[1].aborted, false);
  },
);

await check(
  "a host that just failed is tried after untried ones, not first",
  async () => {
    // `Promise.allSettled` waits for the slowest adapter, and a dead host at
    // the head of the list costs the full per-host timeout on *every* search
    // because only the winner was ever remembered. Demote, never exclude: the
    // dead host is still tried, just last, so a recovered mirror comes back.
    resetMirrorMemory();
    stubFetch((url) =>
      url.startsWith("https://dead")
        ? new Response("", { status: 503 })
        : apiOk(),
    );
    await fetchFromMirrors({
      key: "t-cooldown",
      hosts: ["https://dead", "https://live"],
      path: (h) => `${h}/q`,
    });

    assert.deepEqual(
      orderMirrorHosts("t-cooldown", [
        "https://dead",
        "https://live",
        "https://spare",
      ]),
      ["https://live", "https://spare", "https://dead"],
      "proven host leads, never-tried beats recently-dead",
    );
  },
);

await check("a cooling host leads again once it answers", async () => {
  resetMirrorMemory();
  stubFetch((url) =>
    url.startsWith("https://flaky")
      ? new Response("", { status: 500 })
      : apiOk(),
  );
  await fetchFromMirrors({
    key: "t-recover",
    hosts: ["https://flaky", "https://live"],
    path: (h) => `${h}/q`,
  });
  assert.deepEqual(
    orderMirrorHosts("t-recover", ["https://flaky", "https://live"]),
    ["https://live", "https://flaky"],
    "the cooling host is demoted behind the proven one, never dropped",
  );

  stubFetch((url) =>
    url.startsWith("https://live")
      ? new Response("", { status: 503 })
      : apiOk(),
  );
  await fetchFromMirrors({
    key: "t-recover",
    hosts: ["https://flaky", "https://live"],
    path: (h) => `${h}/q`,
  });
  assert.deepEqual(
    orderMirrorHosts("t-recover", [
      "https://flaky",
      "https://live",
      "https://spare",
    ]),
    ["https://flaky", "https://spare", "https://live"],
    "a successful answer clears the cooldown and re-pins the host",
  );
});

await check("the cooldown expires on its own", async () => {
  resetMirrorMemory();
  stubFetch((url) =>
    url.startsWith("https://dead")
      ? new Response("", { status: 503 })
      : apiOk(),
  );
  await fetchFromMirrors({
    key: "t-expiry",
    hosts: ["https://dead", "https://live"],
    path: (h) => `${h}/q`,
  });
  const laterThanAnyCooldown = Date.now() + 60 * 60 * 1000;
  assert.deepEqual(
    orderMirrorHosts(
      "t-expiry",
      ["https://dead", "https://live", "https://spare"],
      laterThanAnyCooldown,
    ),
    ["https://live", "https://dead", "https://spare"],
    "an expired cooldown restores the caller's own preference order",
  );
});

}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll mirror failover tests passed.");
});