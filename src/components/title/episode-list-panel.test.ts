import assert from "node:assert/strict";

import { episodeListView, extrasRequestPending } from "./episode-list-state";
import { mergeEpisodes, mergeSeasons } from "./merge-extras";
import type {
  TitleDetailPayload,
  TitleExtrasPayload,
  TitleEpisode,
} from "./types";

/**
 * Behavioural regression for the title page's episode panel.
 *
 * Rather than matching source text, this reproduces the *actual* derivation
 * chain of `TitleDetail` → `TitleContent`: the page's `activeSeason` (which
 * builds the extras URL), the extras route's own answer rule, the panel's
 * `activeSeason` (which has an extra provider-season fallback), the merge, and
 * the loading decision. Every permanent-skeleton path found in review is
 * driven through that chain end to end.
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

type Payload = Pick<
  TitleDetailPayload,
  "isSeries" | "season" | "seasons" | "episodes" | "episodesTruncated"
>;
type Extras = Pick<TitleExtrasPayload, "season" | "seasons" | "episodes">;

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    isSeries: true,
    season: null,
    seasons: [],
    episodes: [],
    episodesTruncated: false,
    ...overrides,
  };
}

function localEpisode(season: number, episode: number): TitleEpisode {
  return {
    season,
    episode,
    label: `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    availability: null,
    infoHash: null,
    filePath: null,
    downloadFraction: null,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    transfer: null,
  };
}

/**
 * `GET /api/title/[workKey]/extras`, as it actually behaves.
 *
 * Two rules matter here: it refuses season 0 ("specials are not season one")
 * and falls back to the provider's first season, and it answers `season: null`
 * whenever the resolved provider entity is not a series — regardless of what
 * the page believes.
 */
function extrasRouteAnswer(
  requestedSeason: number | null,
  providerSeasons: number[],
  providerIsSeries = true,
): Extras {
  const wanted =
    requestedSeason != null && requestedSeason >= 1
      ? requestedSeason
      : (providerSeasons[0] ?? 1);
  return {
    season: providerIsSeries ? wanted : null,
    seasons: providerSeasons,
    episodes: [],
  };
}

/** The extras query's state, exactly as `useApiQuery` reports it. */
type QueryState = {
  extras: Extras | null;
  extrasLoading: boolean;
  extrasRefreshing: boolean;
  extrasError: string | null;
  /** Has the request for the URL currently in play finished? */
  extrasSettled: boolean;
};

function settledWith(extras: Extras | null): QueryState {
  return {
    extras,
    extrasLoading: false,
    extrasRefreshing: false,
    extrasError: null,
    extrasSettled: true,
  };
}

/** A 401 under `emptyOnUnauthorized`: no data, no error, done. */
const unauthorizedEmpty: QueryState = settledWith(null);

/**
 * The parent + child derivation, verbatim from `title-detail.tsx`.
 *
 * Returns what the user would actually see.
 */
function panel(input: {
  /** The season state the page holds (`?s=`, cookie, or a click). */
  season: number | null;
  data: Payload;
  query: QueryState;
  /** The detail query polling over data already on screen. */
  refreshing?: boolean;
}) {
  const { season, data, query } = input;
  const refreshing = input.refreshing ?? false;

  // --- TitleDetail (parent) ---
  const requestedSeason = season ?? data.season ?? null;

  // --- TitleContent (child) ---
  const seasons = mergeSeasons(data.seasons, query.extras?.seasons ?? []);
  const activeSeason = season ?? data.season ?? seasons[0]?.season ?? null;
  const onKnownSeason = activeSeason === data.season;
  const extrasDescribeActiveSeason =
    !data.isSeries ||
    activeSeason == null ||
    (query.extras != null && query.extras.season === activeSeason);
  const episodeExtras = extrasDescribeActiveSeason ? query.extras : null;
  const { rows } = mergeEpisodes({
    season: activeSeason,
    episodes: onKnownSeason ? data.episodes : [],
    meta: episodeExtras?.episodes ?? [],
    metaSeason: episodeExtras?.season ?? null,
    truncated: onKnownSeason && data.episodesTruncated,
  });

  const extrasPending = extrasRequestPending({
    activeSeason,
    requestedSeason,
    extrasDescribeActiveSeason,
    extrasLoading: query.extrasLoading,
    extrasRefreshing: query.extrasRefreshing,
    extrasSettled: query.extrasSettled,
  });
  const episodeListLoading =
    data.isSeries &&
    rows.length === 0 &&
    (extrasPending || (refreshing && season != null && season !== data.season));
  const episodeListState =
    query.extrasError && rows.length === 0
      ? ({ status: "error", message: query.extrasError } as const)
      : episodeListLoading
        ? ({ status: "loading" } as const)
        : ({ status: "ready" } as const);

  return {
    requestedSeason,
    activeSeason,
    rows,
    episodeListLoading,
    view: episodeListView(episodeListState, rows.length),
  };
}

check(
  "given the page requested no season and extras answer season null, when the request has settled, then the panel shows the empty copy — not a skeleton",
  () => {
    // The provider resolved something it does not consider a series, so it
    // answers `season: null` forever, while the panel shows Season 1 from the
    // provider's own season list.
    const extras = extrasRouteAnswer(null, [1, 2], false);
    const result = panel({
      season: null,
      data: payload({ season: null }),
      query: settledWith(extras),
    });
    assert.equal(result.requestedSeason, null);
    assert.equal(result.activeSeason, 1);
    assert.equal(result.episodeListLoading, false);
    assert.equal(result.view.kind, "empty");
  },
);

check(
  "given Specials (season 0) is selected, when extras answer the first real season instead, then the panel reaches a terminal state instead of loading forever",
  () => {
    const extras = extrasRouteAnswer(0, [1, 2]);
    assert.notEqual(extras.season, 0); // the route can never describe S00
    const result = panel({
      season: 0,
      data: payload({ season: 1, seasons: [] }),
      query: settledWith(extras),
    });
    assert.equal(result.requestedSeason, 0);
    assert.equal(result.activeSeason, 0);
    assert.equal(result.episodeListLoading, false);
    assert.equal(result.view.kind, "empty");
  },
);

check(
  "given Specials is selected before the extras request settles, then the panel still does not skeleton on an unanswerable season",
  () => {
    const result = panel({
      season: 0,
      data: payload({ season: 1 }),
      query: {
        extras: extrasRouteAnswer(1, [1, 2]),
        extrasLoading: false,
        extrasRefreshing: false,
        extrasError: null,
        extrasSettled: false,
      },
    });
    assert.equal(result.episodeListLoading, false);
  },
);

check(
  "given Specials is selected and the payload holds special episodes, then those rows are shown as content",
  () => {
    const result = panel({
      season: 0,
      data: payload({
        season: 0,
        episodes: [localEpisode(0, 1), localEpisode(0, 2)],
      }),
      query: settledWith(extrasRouteAnswer(0, [1, 2])),
    });
    assert.equal(result.rows.length, 2);
    assert.equal(result.episodeListLoading, false);
    assert.equal(result.view.kind, "rows");
  },
);

check(
  "given extras came back unauthorized (settled, no data, no error), then the panel shows the empty state rather than a permanent skeleton",
  () => {
    const result = panel({
      season: 2,
      data: payload({ season: 2 }),
      query: unauthorizedEmpty,
    });
    assert.equal(result.requestedSeason, 2);
    assert.equal(result.activeSeason, 2);
    assert.equal(result.episodeListLoading, false);
    assert.equal(result.view.kind, "empty");
  },
);

check(
  "given the extras request has not settled yet, then the panel is honestly loading (no empty-copy flash)",
  () => {
    const result = panel({
      season: 2,
      data: payload({ season: 2 }),
      query: {
        extras: null,
        extrasLoading: false,
        extrasRefreshing: false,
        extrasError: null,
        extrasSettled: false,
      },
    });
    assert.equal(result.episodeListLoading, true);
    assert.equal(result.view.kind, "loading");
  },
);

check(
  "given the user switches season, when the URL has changed but the fetch has not started, then the panel is loading and never shows the old season's rows as the new one",
  () => {
    const result = panel({
      season: 4,
      data: payload({ season: 3, episodes: [localEpisode(3, 1)] }),
      query: {
        // Still last season's answer; the new request is not settled.
        extras: extrasRouteAnswer(3, [1, 2, 3, 4]),
        extrasLoading: false,
        extrasRefreshing: false,
        extrasError: null,
        extrasSettled: false,
      },
    });
    assert.equal(result.activeSeason, 4);
    assert.equal(result.rows.length, 0);
    assert.equal(result.episodeListLoading, true);
    assert.equal(result.view.kind, "loading");
  },
);

check(
  "given the selected season is on screen, when a background poll refreshes, then the rows stay put",
  () => {
    const extras = extrasRouteAnswer(2, [1, 2, 3]);
    const state: QueryState = {
      extras,
      extrasLoading: false,
      extrasRefreshing: true,
      extrasError: null,
      extrasSettled: true,
    };
    const result = panel({
      season: 2,
      data: payload({ season: 2, episodes: [localEpisode(2, 1)] }),
      query: state,
      refreshing: true,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.view.kind, "rows");
    // ...and once the poll settles, the same season is still settled: polling
    // does not oscillate the panel's state.
    const settled = panel({
      season: 2,
      data: payload({ season: 2, episodes: [localEpisode(2, 1)] }),
      query: settledWith(extras),
      refreshing: false,
    });
    assert.equal(settled.episodeListLoading, false);
    assert.equal(settled.view.kind, "rows");
  },
);

check(
  "given a settled extras failure with no rows, then the panel reports the error rather than empty or loading",
  () => {
    const result = panel({
      season: 2,
      data: payload({ season: 2 }),
      query: {
        extras: null,
        extrasLoading: false,
        extrasRefreshing: false,
        extrasError: "Could not reach the server.",
        extrasSettled: true,
      },
    });
    assert.equal(result.episodeListLoading, false);
    assert.deepEqual(result.view, {
      kind: "error",
      message: "Could not reach the server.",
    });
  },
);

check(
  "given a season the user picked, then it still wins over the payload's own season (persistence intact)",
  () => {
    const result = panel({
      season: 5,
      data: payload({ season: 1, episodes: [localEpisode(1, 1)] }),
      query: settledWith(extrasRouteAnswer(5, [1, 2, 3, 4, 5])),
    });
    assert.equal(result.requestedSeason, 5);
    assert.equal(result.activeSeason, 5);
    // Never another season's episodes under the selected season's tab.
    assert.deepEqual(
      result.rows.filter((row) => row.season !== 5),
      [],
    );
  },
);

if (failures > 0) {
  console.error(`FAIL episode panel loading (${failures})`);
  process.exit(1);
}
console.log("PASS episode panel never pins a permanent skeleton");
