/**
 * Search hardening: truthful failure reporting and truthful partial results.
 *
 * Three defects this pins:
 *
 *  1. `collectSuggestions` threw `AllProvidersFailedError([])` — an outage that
 *     could not say which providers were down, so the route invented the list.
 *  2. `/api/suggest` caught everything and answered 502 with a hardcoded
 *     `["anilist","tmdb"]`. A bug in our own code was reported to the owner as
 *     a provider outage, and nothing was logged.
 *  3. The search surfaces dropped `partial`/`failedProviders` on the floor, so
 *     a half-answered search looked like a complete one.
 *
 * Run: npx tsx src/lib/search/search-hardening.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  collectSuggestions,
  suggestFailureShapeFor,
  type SuggestProviders,
} from "./suggest";
import { AllProvidersFailedError } from "./work-search-fanout";
import {
  joinLabels,
  partialProviderLabels,
  partialResultsNotice,
} from "@/components/search/partial-results-notice";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const readSource = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), "src", ...rel.split("/")), "utf8");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const suggestRoute = stripComments(readSource("app/api/suggest/route.ts"));
const searchResults = stripComments(
  readSource("components/search/search-results.tsx"),
);
const overlay = stripComments(readSource("components/search/search-overlay.tsx"));

function failingProviders(which: {
  anilist: boolean;
  tmdb: boolean;
}): SuggestProviders {
  return {
    anilist: async () => {
      if (which.anilist) throw new Error("AniList HTTP 500");
      return [
        { title: "Moonlight Mile", mediaType: "anime", source: "anilist", externalId: "a1" },
      ];
    },
    tmdb: async () => {
      if (which.tmdb) throw new Error("TMDB HTTP 503");
      return [
        { title: "Moon Knight", mediaType: "tv", source: "tmdb", externalId: "t1" },
      ];
    },
  };
}

async function run() {
  console.log("search hardening: truthful failures and partial notices…");

  // -------------------------------------------------------------------------
  // 1. The outage names the providers that actually failed
  // -------------------------------------------------------------------------
  await check(
    "given every suggest provider fails, the error names anilist and tmdb",
    async () => {
      await assert.rejects(
        () => collectSuggestions("moonkn", 4, 8, failingProviders({ anilist: true, tmdb: true })),
        (error: unknown) => {
          assert.ok(error instanceof AllProvidersFailedError);
          assert.deepEqual([...error.failed], ["anilist", "tmdb"]);
          return true;
        },
      );
    },
  );

  await check(
    "the total-failure error is never raised with an empty provider list",
    async () => {
      const error = await collectSuggestions(
        "moonkn",
        4,
        8,
        failingProviders({ anilist: true, tmdb: true }),
      ).catch((e: unknown) => e);
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.failed.length, 2);
    },
  );

  await check(
    "given only anilist fails, the outcome degrades and names anilist alone",
    async () => {
      const outcome = await collectSuggestions(
        "MOONKN",
        4,
        8,
        failingProviders({ anilist: true, tmdb: false }),
      );
      assert.equal(outcome.partial, true);
      assert.deepEqual(outcome.failed, ["anilist"]);
      assert.equal(outcome.suggestions[0]?.title, "Moon Knight");
    },
  );

  // -------------------------------------------------------------------------
  // 2. Provider outage vs. our own bug
  // -------------------------------------------------------------------------
  await check(
    "given an all-providers-failed error, the response is a 502 naming the failed providers",
    () => {
      const shape = suggestFailureShapeFor(
        new AllProvidersFailedError(["anilist", "tmdb"]),
      );
      assert.equal(shape.status, 502);
      assert.equal(shape.providerOutage, true);
      assert.deepEqual(shape.failedProviders, ["anilist", "tmdb"]);
    },
  );

  await check(
    "given an unexpected internal error, the response is a 500 that claims no provider outage",
    () => {
      const shape = suggestFailureShapeFor(new TypeError("x is not a function"));
      assert.equal(shape.status, 500);
      assert.equal(shape.providerOutage, false);
      assert.deepEqual(shape.failedProviders, []);
    },
  );

  await check("a non-Error throw is still classified as our bug, not an outage", () => {
    const shape = suggestFailureShapeFor("boom");
    assert.equal(shape.status, 500);
    assert.deepEqual(shape.failedProviders, []);
  });

  await check("the suggest route observes every failure before answering", () => {
    assert.match(suggestRoute, /observeRequest\(/);
    assert.match(suggestRoute, /observer\.failure\("TITLE_SEARCH_FAILED", err\)/);
    assert.match(suggestRoute, /observer\.degraded\(/);
    assert.match(suggestRoute, /suggestFailureShapeFor\(err\)/);
  });

  await check("the suggest route has no broad silent catch and no hardcoded outage", () => {
    assert.doesNotMatch(suggestRoute, /catch\s*\{/);
    assert.doesNotMatch(suggestRoute, /failedProviders:\s*\["anilist"/);
    assert.doesNotMatch(suggestRoute, /\["anilist",\s*"tmdb"\]/);
  });

  // -------------------------------------------------------------------------
  // 3. The partial notice
  // -------------------------------------------------------------------------
  await check("a complete answer produces no notice", () => {
    assert.equal(partialResultsNotice({ partial: false, failedProviders: [] }), null);
    assert.equal(partialResultsNotice({}), null);
  });

  await check("a partial with no named providers produces no unexplained warning", () => {
    assert.equal(partialResultsNotice({ partial: true, failedProviders: [] }), null);
  });

  await check("a partial title search names the category that did not answer", () => {
    const notice = partialResultsNotice({
      partial: true,
      failedProviders: ["movies"],
    });
    assert.equal(
      notice,
      "Some results are missing: films did not respond. Everything else that answered is shown below.",
    );
  });

  await check("two failed categories are named in plain language", () => {
    const notice = partialResultsNotice({
      partial: true,
      failedProviders: ["movies", "anime"],
    });
    assert.ok(notice);
    assert.match(notice, /films and anime did not respond/);
  });

  await check("provider keys map to plain names and dedupe", () => {
    assert.deepEqual(partialProviderLabels(["anilist", "anime"]), ["anime"]);
    assert.deepEqual(partialProviderLabels(["tmdb"]), ["films and series"]);
    assert.deepEqual(partialProviderLabels([" ", null as unknown as string]), []);
  });

  await check("an unknown provider key is still named rather than hidden", () => {
    assert.deepEqual(partialProviderLabels(["opensubs"]), ["opensubs"]);
  });

  await check("three labels read as a list", () => {
    assert.equal(joinLabels(["films", "series", "anime"]), "films, series and anime");
    assert.equal(joinLabels(["films"]), "films");
  });

  // -------------------------------------------------------------------------
  // 4. Both surfaces consume the partial contract
  // -------------------------------------------------------------------------
  for (const [label, source] of [
    ["search results page", searchResults],
    ["search overlay", overlay],
  ] as const) {
    await check(`${label} reads partial and failedProviders from the response`, () => {
      assert.match(source, /failedProviders/);
      assert.match(source, /partialResultsNotice/);
    });

    await check(`${label} renders the notice as a status, not an error screen`, () => {
      assert.match(source, /data-partial-notice/);
      assert.match(source, /role="status"/);
      assert.match(source, /aria-live="polite"/);
    });
  }

  await check("the overlay only shows the notice alongside real results", () => {
    assert.match(overlay, /notice && display\.state === "results"/);
  });

  await check("a failed request clears any stale partial notice", () => {
    assert.match(overlay, /setNotice\(null\)/);
    assert.match(searchResults, /setNotice\(null\)/);
  });

  if (failures > 0) {
    console.error(`FAIL search hardening (${failures})`);
    process.exit(1);
  }
  console.log("PASS search hardening");
}

run().catch((error) => {
  console.error("FAIL search hardening", error);
  process.exit(1);
});
