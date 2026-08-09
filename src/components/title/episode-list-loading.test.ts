import assert from "node:assert/strict";

import { episodeListView, extrasRequestPending } from "./episode-list-state";

/**
 * Regression: the title page's episode panel showed a permanent skeleton.
 *
 * The extras URL is built from the page's season (`season ?? payload.season`),
 * while the panel additionally falls back to the first merged/provider season.
 * When the request carried no season, extras answered `season: null`, no error
 * was set and nothing further was requested — yet the panel treated "extras do
 * not describe the active season" as loading, forever.
 */

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const idle = {
  extrasLoading: false,
  extrasRefreshing: false,
  extrasSettled: true,
} as const;

check(
  "given extras answered no season for a different request, when nothing is in flight, then the panel is not loading",
  () => {
    const pending = extrasRequestPending({
      activeSeason: 1,
      requestedSeason: null,
      extrasDescribeActiveSeason: false,
      ...idle,
    });
    assert.equal(pending, false);
    assert.deepEqual(episodeListView({ status: "ready" }, 0).kind, "empty");
  },
);

check(
  "given extras answered a different season for a different request, then the panel is not loading",
  () => {
    assert.equal(
      extrasRequestPending({
        activeSeason: 2,
        requestedSeason: 9,
        extrasDescribeActiveSeason: false,
        ...idle,
      }),
      false,
    );
  },
);

check(
  "given the request was built for the shown season, has not settled, and the data still answers another, then the panel is loading",
  () => {
    assert.equal(
      extrasRequestPending({
        activeSeason: 2,
        requestedSeason: 2,
        extrasDescribeActiveSeason: false,
        ...idle,
        extrasSettled: false,
      }),
      true,
    );
  },
);

check("given a fetch is in flight, then the panel is loading", () => {
  assert.equal(
    extrasRequestPending({
      activeSeason: 1,
      requestedSeason: null,
      extrasDescribeActiveSeason: false,
      extrasLoading: true,
      extrasRefreshing: false,
      extrasSettled: false,
    }),
    true,
  );
});

check(
  "given a refresh is in flight over stale data, then the panel is loading",
  () => {
    assert.equal(
      extrasRequestPending({
        activeSeason: 3,
        requestedSeason: 3,
        extrasDescribeActiveSeason: true,
        extrasLoading: false,
        extrasRefreshing: true,
        extrasSettled: false,
      }),
      true,
    );
  },
);

check(
  "given extras describe the shown season and nothing is in flight, then the panel is settled",
  () => {
    assert.equal(
      extrasRequestPending({
        activeSeason: 3,
        requestedSeason: 3,
        extrasDescribeActiveSeason: true,
        ...idle,
      }),
      false,
    );
  },
);

check("given no season is known at all, then the panel is settled", () => {
  assert.equal(
    extrasRequestPending({
      activeSeason: null,
      requestedSeason: null,
      extrasDescribeActiveSeason: true,
      ...idle,
    }),
    false,
  );
});

check(
  "given an extras error, when the panel has no rows, then it reports the error rather than loading",
  () => {
    const pending = extrasRequestPending({
      activeSeason: 4,
      requestedSeason: null,
      extrasDescribeActiveSeason: false,
      ...idle,
    });
    assert.equal(pending, false);
    const view = episodeListView(
      { status: "error", message: "Could not reach the server." },
      0,
    );
    assert.deepEqual(view, {
      kind: "error",
      message: "Could not reach the server.",
    });
  },
);

check(
  "given the selected season is settled, when a poll refreshes over existing rows, then the rows stay (no skeleton flash)",
  () => {
    // Rows on screen win over any load state — the 5s/2.5s poll must never
    // swap a rendered season back to skeletons.
    assert.deepEqual(episodeListView({ status: "loading" }, 7).kind, "rows");
    const pendingDuringPoll = extrasRequestPending({
      activeSeason: 5,
      requestedSeason: 5,
      extrasDescribeActiveSeason: true,
      extrasLoading: false,
      extrasRefreshing: true,
      extrasSettled: false,
    });
    assert.equal(pendingDuringPoll, true);
    // ...and once the poll settles on the same season, it is still settled:
    // polling does not oscillate the selected season's state.
    assert.equal(
      extrasRequestPending({
        activeSeason: 5,
        requestedSeason: 5,
        extrasDescribeActiveSeason: true,
        ...idle,
      }),
      false,
    );
  },
);

check(
  "given the user switches season, then the one-render gap before the fetch starts is loading, not empty",
  () => {
    // URL already rebuilt for season 4; the hook has not flipped its flags yet
    // and `extras` still answers season 3, so the request has not settled.
    assert.equal(
      extrasRequestPending({
        activeSeason: 4,
        requestedSeason: 4,
        extrasDescribeActiveSeason: false,
        ...idle,
        extrasSettled: false,
      }),
      true,
    );
  },
);

if (failures > 0) {
  console.error(`FAIL episode list loading (${failures})`);
  process.exit(1);
}
console.log("PASS episode list loading never pins a permanent skeleton");
