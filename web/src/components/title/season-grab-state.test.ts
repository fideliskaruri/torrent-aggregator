/**
 * What a season download toast says when episodes did not start, and which
 * episodes its Retry may resend.
 *
 * Run: npx tsx --test src/components/title/season-grab-state.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SeasonGrabFailureError,
  seasonGrabFailureDescription,
  seasonGrabMissingEpisodes,
  seasonGrabRetryEpisodes,
  shouldRetrySeasonGrab,
  shouldRunSeasonGrab,
  type SeasonGrabReport,
} from "./season-grab-state";

function report(overrides: Partial<SeasonGrabReport> = {}): SeasonGrabReport {
  return {
    season: 1,
    totalEpisodes: 4,
    coveredEpisodes: 1,
    strategy: "singles",
    coverageConfirmed: true,
    episodes: [
      { episode: 1, status: "covered" },
      { episode: 2, status: "missing", reason: "No release at 1080p or higher" },
      { episode: 3, status: "missing", reason: "No release at 1080p or higher" },
      { episode: 4, status: "missing", reason: "The search sites are busy" },
    ],
    planReason: "Each episode used the same acquisition path as its individual Download button.",
    ...overrides,
  };
}

test("aggregate failure reasons win over per-episode reasons and planReason", () => {
  const text = seasonGrabFailureDescription(
    report({
      failureReasons: [
        { code: "busy", count: 1, message: "The search sites are busy", action: "Try again in a minute." },
        { code: "below_quality", count: 2, message: "No release at 1080p or higher", action: "Choose a lower quality" },
      ],
    }),
  );
  assert.equal(
    text,
    "2 episodes: No release at 1080p or higher. 1 episode: The search sites are busy. Choose a lower quality.",
  );
});

test("a single aggregate reason reads as one sentence plus its next step", () => {
  const text = seasonGrabFailureDescription(
    report({
      coveredEpisodes: 0,
      failureReasons: [
        { code: "not_found", count: 1, message: "No release found.", action: "Try again later." },
      ],
    }),
  );
  assert.equal(text, "No release found. Try again later.");
});

test("without aggregate reasons, missing-episode reasons are grouped most common first", () => {
  const text = seasonGrabFailureDescription(report());
  assert.equal(
    text,
    "2 episodes: No release at 1080p or higher. 1 episode: The search sites are busy.",
  );
});

test("when the server message already lists every reason, only the next step is shown", () => {
  const reasons = [
    { code: "below_quality", count: 2, message: "No release at 1080p or higher", action: "Choose a lower quality" },
    { code: "busy", count: 1, message: "The search sites are busy.", action: "Try again in a minute." },
  ];
  const headline =
    "Started 1 of 4 episodes. 2 episodes: No release at 1080p or higher. 1 episode: The search sites are busy.";
  assert.equal(
    seasonGrabFailureDescription(report({ failureReasons: reasons }), headline),
    "Choose a lower quality.",
  );
  assert.equal(
    seasonGrabFailureDescription(
      report({ failureReasons: reasons }),
      `${headline} Choose a lower quality.`,
    ),
    undefined,
  );
  // A headline that names only some reasons still gets the full description.
  assert.equal(
    seasonGrabFailureDescription(
      report({ failureReasons: reasons }),
      "Started 1 of 4 episodes. No release at 1080p or higher.",
    ),
    "2 episodes: No release at 1080p or higher. 1 episode: The search sites are busy. Choose a lower quality.",
  );
  // Older servers without aggregate reasons keep the per-episode fallback.
  assert.equal(
    seasonGrabFailureDescription(report(), headline),
    "2 episodes: No release at 1080p or higher. 1 episode: The search sites are busy.",
  );
});

test("planReason is only a last resort and blank reasons are ignored", () => {
  const text = seasonGrabFailureDescription(
    report({
      failureReasons: [{ code: "x", count: 2, message: "  " }],
      episodes: [{ episode: 1, status: "missing", reason: " " }],
      planReason: "Nothing matched this season.",
    }),
  );
  assert.equal(text, "Nothing matched this season.");
  assert.equal(
    seasonGrabFailureDescription(report({ episodes: [], planReason: null })),
    undefined,
  );
});

test("new toast copy has no em dash and no internal jargon", () => {
  const text = seasonGrabFailureDescription(report()) ?? "";
  assert.equal(text.includes("\u2014"), false);
  assert.equal(/acquisition path/i.test(text), false);
});

test("long descriptions are clipped with an ellipsis", () => {
  const text = seasonGrabFailureDescription(
    report({ failureReasons: [{ code: "x", count: 3, message: "y".repeat(400) }] }),
  );
  assert.ok(text);
  assert.ok(text.length <= 200);
  assert.equal(text.endsWith("\u2026"), true);
});

test("retry resends only missing episodes that were asked for, never covered ones", () => {
  const r = report({
    episodes: [
      { episode: 1, status: "covered" },
      { episode: 3, status: "missing" },
      { episode: 2, status: "missing" },
      { episode: 2, status: "missing" },
      { episode: 9, status: "missing" },
      { episode: 5, status: "not_measured" },
    ],
  });
  assert.deepEqual(seasonGrabMissingEpisodes(r, [1, 2, 3, 5]), [2, 3]);
  assert.deepEqual(seasonGrabRetryEpisodes(r, [1, 2, 3, 5]), [2, 3]);
});

test("an episode reported both covered and missing is not resent", () => {
  const r = report({
    episodes: [
      { episode: 2, status: "covered" },
      { episode: 2, status: "missing" },
    ],
  });
  assert.deepEqual(seasonGrabMissingEpisodes(r, [2]), []);
  assert.equal(seasonGrabRetryEpisodes(r, [2]), null);
});

test("no Retry when the server says retrying cannot help or nothing is missing", () => {
  assert.equal(seasonGrabRetryEpisodes(report({ retryable: false }), [1, 2, 3, 4]), null);
  assert.deepEqual(seasonGrabRetryEpisodes(report({ retryable: true }), [1, 2, 3, 4]), [2, 3, 4]);
  assert.equal(
    seasonGrabRetryEpisodes(report({ episodes: [{ episode: 1, status: "covered" }] }), [1]),
    null,
  );
  assert.equal(seasonGrabRetryEpisodes(null, [1, 2]), null);
  assert.equal(seasonGrabRetryEpisodes(undefined, [1, 2]), null);
});

test("older reports without the new fields still offer a Retry of missing episodes", () => {
  const r = report();
  delete r.failureReasons;
  delete r.retryable;
  assert.deepEqual(seasonGrabRetryEpisodes(r, [1, 2, 3, 4]), [2, 3, 4]);
});

test("Retry never starts a second run while one is in flight", () => {
  assert.equal(shouldRetrySeasonGrab({ status: "pending" }), false);
  assert.equal(shouldRetrySeasonGrab({ status: "error", message: "x" }), true);
  assert.equal(shouldRetrySeasonGrab({ status: "done", report: report() }), true);
  assert.equal(shouldRetrySeasonGrab({ status: "idle" }), true);
  // The main button stays spent after a finished run; only Retry reopens it.
  assert.equal(shouldRunSeasonGrab({ status: "done", report: report() }), false);
});

test("failure errors carry the report for the Retry", () => {
  const r = report({ coveredEpisodes: 0 });
  const error = new SeasonGrabFailureError("No episodes started", "why", r);
  assert.equal(error.report, r);
  assert.equal(error.description, "why");
});

test("acquisition POSTs carry no browser deadline and report a lost connection as uncertain", async () => {
  const { postTitleAction, AcquisitionTransportError, ACQUISITION_TRANSPORT_MESSAGE } =
    await import("./title-action-request");
  const realFetch = globalThis.fetch;
  let seenSignal: unknown = "unset";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seenSignal = init?.signal;
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      postTitleAction({ workKey: "k", action: { season: null, episode: null } as never, retention: "keep" }),
      (err: unknown) => err instanceof AcquisitionTransportError && (err as Error).message === ACQUISITION_TRANSPORT_MESSAGE,
    );
    assert.equal(seenSignal, undefined);
    assert.equal(/Downloads/.test(ACQUISITION_TRANSPORT_MESSAGE), true);

    const cancel = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = (async () => { throw cancel; }) as typeof fetch;
    await assert.rejects(
      postTitleAction({ workKey: "k", action: { season: null, episode: null } as never, retention: "keep" }),
      (err: unknown) => err === cancel,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
