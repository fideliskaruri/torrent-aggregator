/**
 * Title-page logic tests.
 *
 * The page is `.tsx` and cannot be imported by this runner, so everything the
 * page is actually *deciding* lives in plain modules: what a work is called in
 * a URL, whether a row belongs to the work the URL names, and which single
 * control the page is allowed to offer. Those are the rules; the JSX is paint.
 *
 * Table-driven over diverse inputs per AGENTS.md — each table covers the rule
 * class, not the one example that prompted it. The identity tables in
 * particular are drawn from the cases that have actually cost this project
 * bugs: *Dune* (two films, one name), *Breaking Bad* (a title that looks like
 * a quality tag), fansub prefixes, site prefixes, and absolute-numbered anime.
 *
 * Run: npx tsx src/components/title/title.test.ts
 */
import assert from "node:assert/strict";
import type { AvailabilityState } from "@/lib/browse";
import {
  displayTitleFromWorkKey,
  slugifyWorkName,
  titlePath,
  workKeyFor,
  workKeyForRelease,
  workKeyMatches,
  workKeyVariants,
} from "./work-key";
import {
  nextUpTarget,
  resolveEpisodeAction,
  resolvePlayableAction,
  resolvePrimaryAction,
  titleActionLabel,
} from "./title-actions";
import { titleFacts } from "./title-facts";
import {
  formatAirDate,
  formatRuntime,
  isUnaired,
  mergeEpisodes,
  mergeSeasons,
} from "./merge-extras";
import type {
  TitleDetailPayload,
  TitleEpisode,
  TitleEpisodeMeta,
} from "./types";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

const SLUG_CASES: { name: string; input: string; expect: string }[] = [
  { name: "plain", input: "Breaking Bad", expect: "breaking-bad" },
  { name: "colon", input: "Dune: Part Two", expect: "dune-part-two" },
  { name: "apostrophe folded, not hyphenated", input: "The Queen's Gambit", expect: "the-queens-gambit" },
  { name: "curly apostrophe", input: "Bob’s Burgers", expect: "bobs-burgers" },
  { name: "diacritics fold", input: "Amélie", expect: "amelie" },
  { name: "ampersand collapses", input: "Rick & Morty", expect: "rick-morty" },
  { name: "runs collapse, edges trim", input: "  A   Quiet   Place  ", expect: "a-quiet-place" },
  { name: "digits survive", input: "Blade Runner 2049", expect: "blade-runner-2049" },
  { name: "dots", input: "Mr. Robot", expect: "mr-robot" },
];

for (const c of SLUG_CASES) {
  check(`slugifyWorkName: ${c.name}`, () => {
    assert.equal(slugifyWorkName(c.input), c.expect);
  });
}

check("slugifyWorkName: non-Latin still yields a usable segment", () => {
  const slug = slugifyWorkName("進撃の巨人");
  assert.ok(slug.length > 0, "must not be empty");
  // Whatever it is, it has to survive a round trip through a URL path.
  assert.equal(slug, encodeURIComponent(decodeURIComponent(slug)));
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

check("workKeyFor: a film carries its year", () => {
  assert.equal(workKeyFor("Dune", 2021), "dune-2021");
  assert.equal(workKeyFor("Dune", 1984), "dune-1984");
});

check("workKeyFor: no year, no suffix", () => {
  assert.equal(workKeyFor("Breaking Bad", null), "breaking-bad");
});

check("workKeyFor: an unnameable work has no key", () => {
  assert.equal(workKeyFor("", 2020), "");
});

const RELEASE_KEY_CASES: {
  name: string;
  release: string;
  expect: string;
}[] = [
  {
    name: "film keeps its year",
    release: "Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-CMRG",
    expect: "dune-2021",
  },
  {
    name: "the other Dune is a different work",
    release: "Dune.1984.1080p.BluRay.x264-AMIABLE",
    expect: "dune-1984",
  },
  {
    name: "sequel is not the original",
    release: "Dune.Part.Two.2024.2160p.WEB-DL",
    expect: "dune-part-two-2024",
  },
  {
    name: "series drops the year and keeps the whole name",
    release: "Breaking.Bad.S05E14.Ozymandias.1080p.BluRay.x264-ROVERS",
    expect: "breaking-bad",
  },
  {
    name: "every episode of a series lands on one key",
    release: "Breaking.Bad.S01E01.720p.HDTV.x264-CTU",
    expect: "breaking-bad",
  },
  {
    name: "fansub prefix is not part of the name",
    release: "[SubsPlease] Frieren - 12 (1080p) [F02B9CEA].mkv",
    expect: "frieren",
  },
  {
    name: "site prefix is not part of the name",
    release: "www.1TamilMV.com - Jawan (2023) 1080p WEB-DL",
    expect: "jawan-2023",
  },
  {
    name: "bracketed site prefix is not part of the name",
    release: "[Nyaa] Severance S02E01 1080p WEB-DL",
    expect: "severance",
  },
  {
    name: "absolute-numbered anime",
    release: "One Piece - 1170 [1080p][HEVC]",
    expect: "one-piece",
  },
  {
    name: "season pack lands on the show, not a season",
    release: "Severance.S02.COMPLETE.1080p.ATVP.WEB-DL",
    expect: "severance",
  },
];

for (const c of RELEASE_KEY_CASES) {
  check(`workKeyForRelease: ${c.name}`, () => {
    assert.equal(workKeyForRelease(c.release), c.expect);
  });
}

check("workKeyForRelease: two Dunes never collide", () => {
  const a = workKeyForRelease("Dune.2021.2160p.WEB-DL");
  const b = workKeyForRelease("Dune.1984.1080p.BluRay");
  assert.notEqual(a, b);
});

check("workKeyForRelease: Dune is not Children of Dune", () => {
  const a = workKeyForRelease("Dune.2021.2160p.WEB-DL");
  const b = workKeyForRelease("Children.of.Dune.S01E01.1080p");
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

check("workKeyVariants: a dated work answers to both forms", () => {
  assert.deepEqual(workKeyVariants("Dune", 2021), ["dune-2021", "dune"]);
});

check("workKeyVariants: an undated work has exactly one form", () => {
  assert.deepEqual(workKeyVariants("Breaking Bad", null), ["breaking-bad"]);
});

const MATCH_CASES: {
  name: string;
  key: string;
  rowName: string;
  rowYear: number | null;
  expect: boolean;
}[] = [
  {
    name: "a yearless library row matches its dated releases",
    key: "dune-2021",
    rowName: "Dune",
    rowYear: null,
    expect: true,
  },
  {
    name: "the dated release matches its own key",
    key: "dune-2021",
    rowName: "Dune",
    rowYear: 2021,
    expect: true,
  },
  {
    name: "the wrong year is a different work",
    key: "dune-2021",
    rowName: "Dune",
    rowYear: 1984,
    expect: false,
  },
  {
    name: "a longer title is a different work",
    key: "dune",
    rowName: "Children of Dune",
    rowYear: null,
    expect: false,
  },
  {
    name: "a sequel is a different work",
    key: "dune",
    rowName: "Dune: Part Two",
    rowYear: 2024,
    expect: false,
  },
  {
    name: "series rows match by name alone",
    key: "breaking-bad",
    rowName: "Breaking Bad",
    rowYear: null,
    expect: true,
  },
  {
    name: "an empty key matches nothing",
    key: "",
    rowName: "Breaking Bad",
    rowYear: null,
    expect: false,
  },
];

for (const c of MATCH_CASES) {
  check(`workKeyMatches: ${c.name}`, () => {
    assert.equal(workKeyMatches(c.key, c.rowName, c.rowYear), c.expect);
  });
}

check("workKeyMatches: case and padding in the URL are tolerated", () => {
  assert.equal(workKeyMatches("  Dune-2021 ", "Dune", 2021), true);
});

// ---------------------------------------------------------------------------
// Display + links
// ---------------------------------------------------------------------------

check("displayTitleFromWorkKey: spells the slug back out, invents nothing", () => {
  assert.equal(displayTitleFromWorkKey("breaking-bad"), "Breaking Bad");
  // Deliberately keeps the trailing number: no rule can tell a year from a
  // title, and printing a year the user never gave us is an unearned claim.
  assert.equal(displayTitleFromWorkKey("blade-runner-2049"), "Blade Runner 2049");
  assert.equal(displayTitleFromWorkKey("dune-2021"), "Dune 2021");
});

check("titlePath: carries what the card knew", () => {
  const href = titlePath("dune-2021", {
    title: "Dune",
    year: 2021,
    mediaType: "movie",
  });
  assert.ok(href.startsWith("/title/dune-2021?"), href);
  const qs = new URLSearchParams(href.split("?")[1]);
  assert.equal(qs.get("t"), "Dune");
  assert.equal(qs.get("y"), "2021");
  assert.equal(qs.get("type"), "movie");
});

check("titlePath: never points at the release table", () => {
  const href = titlePath("severance", { title: "Severance", season: 2 });
  assert.ok(!href.includes("/search"), href);
  assert.equal(new URLSearchParams(href.split("?")[1]).get("s"), "2");
});

check("titlePath: a bare key needs no query string", () => {
  assert.equal(titlePath("severance", { title: "" }), "/title/severance");
});

// ---------------------------------------------------------------------------
// Actions — the rule the whole page hangs off
// ---------------------------------------------------------------------------

const ACTION_CASES: {
  name: string;
  availability: AvailabilityState | null;
  infoHash: string | null;
  resumePositionSec?: number | null;
  expectKind: "play" | "get" | "stream";
  expectLabel: string;
}[] = [
  {
    name: "ready with a hash plays",
    availability: "ready",
    infoHash: "abc123",
    expectKind: "play",
    expectLabel: "Play",
  },
  {
    name: "ready with progress resumes",
    availability: "ready",
    infoHash: "abc123",
    resumePositionSec: 620,
    expectKind: "play",
    expectLabel: "Resume",
  },
  {
    name: "warm still plays",
    availability: "warm",
    infoHash: "abc123",
    expectKind: "play",
    expectLabel: "Play",
  },
  {
    name: "ready with no hash never offers Play",
    availability: "ready",
    infoHash: null,
    expectKind: "stream",
    expectLabel: "Play",
  },
  {
    name: "fetchable plays — a seeded release exists, so the click is Play",
    availability: "fetchable",
    infoHash: null,
    expectKind: "stream",
    expectLabel: "Play",
  },
  {
    name: "unavailable still gets — it looks again",
    availability: "unavailable",
    infoHash: null,
    expectKind: "get",
    expectLabel: "Get",
  },
  {
    name: "null is not unavailable, and is not a dead end",
    availability: null,
    infoHash: null,
    expectKind: "stream",
    expectLabel: "Play",
  },
];

for (const c of ACTION_CASES) {
  check(`resolvePlayableAction: ${c.name}`, () => {
    const action = resolvePlayableAction({
      availability: c.availability,
      infoHash: c.infoHash,
      resumePositionSec: c.resumePositionSec ?? null,
    });
    assert.equal(action.kind, c.expectKind);
    assert.equal(action.label, c.expectLabel);
  });
}

check("resolvePlayableAction: never returns a navigation action", () => {
  const states: (AvailabilityState | null)[] = [
    null,
    "ready",
    "warm",
    "fetchable",
    "unavailable",
  ];
  for (const state of states) {
    for (const infoHash of [null, "hash"]) {
      const action = resolvePlayableAction({ availability: state, infoHash });
      assert.ok(
        action.kind === "play" || action.kind === "get" || action.kind === "stream",
        `${state}/${infoHash} produced ${action.kind}`,
      );
      assert.ok(
        !("href" in action),
        `${state}/${infoHash} produced a link, not an action`,
      );
    }
  }
});

check("resolvePlayableAction: a play action is never issued without a hash", () => {
  // The whole point of the `stream` kind is that "we cannot address this yet"
  // and "the viewer must go away and come back" are different statements. The
  // first is allowed to say Play; neither is allowed to produce a `play`,
  // because `play` opens the player immediately and would open it on nothing.
  const states: (AvailabilityState | null)[] = [
    null,
    "ready",
    "warm",
    "fetchable",
    "unavailable",
  ];
  for (const state of states) {
    const action = resolvePlayableAction({ availability: state, infoHash: null });
    assert.notEqual(action.kind, "play", `${state} produced an unaddressable play`);
  }
});

check("copy: no self-narrating sentence rides along with the action", () => {
  // The button says what the click does; nothing under it explains the
  // mechanics. A `get` action therefore carries no prose field at all.
  const states: (AvailabilityState | null)[] = [
    null,
    "ready",
    "warm",
    "fetchable",
    "unavailable",
  ];
  for (const state of states) {
    const action = resolvePlayableAction({ availability: state, infoHash: null });
    for (const [key, value] of Object.entries(action)) {
      assert.ok(
        typeof value !== "string" || key === "kind" || key === "label" || value.length <= 12,
        `${state}: action carries explanatory copy in "${key}": ${String(value)}`,
      );
    }
  }
});

check("null is not unavailable: both stay actionable, and they differ", () => {
  const unchecked = resolvePlayableAction({ availability: null, infoHash: null });
  const dead = resolvePlayableAction({
    availability: "unavailable",
    infoHash: null,
  });
  // Both are actionable — neither is a dead end. But they are no longer the
  // same button: not having looked is one search away from playing, whereas
  // having looked and found nothing is not, and offering Play there would
  // dead-end on the one state where we hold evidence that it would.
  assert.equal(unchecked.kind, "stream");
  assert.equal(unchecked.label, "Play");
  assert.equal(dead.kind, "get");
  assert.equal(dead.label, "Get");
});

// ---------------------------------------------------------------------------
// The primary action
// ---------------------------------------------------------------------------

check("titleFacts: joins metadata with a spoken separator and product rating order", () => {
  const out = titleFacts({
    year: 2013,
    mediaType: "tv",
    rating: 8.7,
    isSeries: true,
    seasonCount: 9,
  });
  assert.equal(out, "2013 · Series · ★ 8.7 · 9 seasons");
  assert.doesNotMatch(out, /Series8\.7|rating/);
});

function episode(over: Partial<TitleEpisode> = {}): TitleEpisode {
  return {
    season: 1,
    episode: 1,
    label: "S01E01",
    availability: null,
    infoHash: null,
    filePath: null,
    downloadFraction: null,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    ...over,
  };
}

function payload(over: Partial<TitleDetailPayload> = {}): TitleDetailPayload {
  return {
    workKey: "severance",
    title: "Severance",
    year: null,
    mediaType: "tv",
    isSeries: true,
    overview: null,
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    availability: null,
    infoHash: null,
    downloadFraction: null,
    resume: null,
    seasons: [{ season: 1, knownEpisodes: 0, pack: null }],
    season: 1,
    episodes: [],
    episodesTruncated: false,
    library: {
      inLibrary: false,
      watchListItemId: null,
      monitored: false,
      status: null,
      cursorSeason: null,
      cursorEpisode: null,
      addPayload: {
        mediaType: "tv",
        externalId: "work:severance",
        title: "Severance",
        posterUrl: null,
        synopsis: null,
        rating: null,
      },
    },
    releasesHref: "/search?q=Severance",
    known: true,
    generatedAt: new Date().toISOString(),
    ...over,
  };
}

check("primary action: an empty page still offers an action, never Search", () => {
  const action = resolvePrimaryAction(payload());
  assert.equal(action.kind, "stream");
  assert.ok(!/search/i.test(action.label));
});

check("primary action: resume wins over everything", () => {
  const action = resolvePrimaryAction(
    payload({
      resume: {
        infoHash: "hash-1",
        filePath: "a.mkv",
        positionSec: 900,
        durationSec: 2700,
        fraction: 1 / 3,
        season: 2,
        episode: 4,
        label: "S02E04",
      },
      episodes: [episode({ availability: "ready", infoHash: "hash-9" })],
    }),
  );
  assert.equal(action.kind, "play");
  assert.equal(action.label, "Resume");
  assert.equal(action.kind === "play" ? action.infoHash : null, "hash-1");
});

check("primary action: plays the first unwatched local episode", () => {
  const action = resolvePrimaryAction(
    payload({
      episodes: [
        episode({ episode: 1, availability: "ready", infoHash: "h1", watched: true }),
        episode({ episode: 2, availability: "ready", infoHash: "h2" }),
        episode({ episode: 3, availability: "ready", infoHash: "h3" }),
      ],
    }),
  );
  assert.equal(action.kind, "play");
  assert.equal(action.kind === "play" ? action.infoHash : null, "h2");
});

check("primary action: an episode with no hash is not playable", () => {
  const action = resolvePrimaryAction(
    payload({
      episodes: [episode({ episode: 1, availability: "ready", infoHash: null })],
    }),
  );
  // Still actionable — a `ready` claim we cannot address is one search away
  // from playing — but never a `play`, which would open the player on nothing.
  assert.notEqual(action.kind, "play");
  assert.equal(action.kind, "stream");
});

check("primary action: a series action names an episode", () => {
  const action = resolvePrimaryAction(
    payload({
      library: {
        ...payload().library,
        inLibrary: true,
        watchListItemId: "wl-1",
        cursorSeason: 2,
        cursorEpisode: 7,
      },
    }),
  );
  assert.equal(action.season, 2);
  assert.equal(action.episode, 7);
});

check("primary action: a series keeps its Play when it needs an episode", () => {
  // The title-level lookup cannot name an episode, so a series falls through
  // to the cursor to find one. That detour used to flatten every state into a
  // Get — a fetchable series lost its Play on the way through purely
  // because it needed an episode number attached.
  const action = resolvePrimaryAction(
    payload({
      availability: "fetchable",
      library: {
        ...payload().library,
        inLibrary: true,
        watchListItemId: "wl-1",
        cursorSeason: 2,
        cursorEpisode: 7,
      },
    }),
  );
  assert.equal(action.kind, "stream");
  assert.equal(action.label, "Play");
  assert.equal(action.season, 2);
  assert.equal(action.episode, 7);
});

check("primary action: an unavailable series still degrades to Get", () => {
  const action = resolvePrimaryAction(
    payload({
      availability: "unavailable",
      library: {
        ...payload().library,
        cursorSeason: 3,
        cursorEpisode: 1,
      },
    }),
  );
  assert.equal(action.kind, "get");
  assert.equal(action.season, 3);
  assert.equal(action.episode, 1);
});

check("primary action: a film action names no episode", () => {
  const action = resolvePrimaryAction(
    payload({
      workKey: "dune-2021",
      title: "Dune",
      mediaType: "movie",
      isSeries: false,
      seasons: [],
      season: null,
      availability: "fetchable",
    }),
  );
  assert.equal(action.kind, "stream");
  assert.equal(action.season, null);
  assert.equal(action.episode, null);
});

check("primary action: never a search, in any state combination", () => {
  const states: (AvailabilityState | null)[] = [
    null,
    "ready",
    "warm",
    "fetchable",
    "unavailable",
  ];
  for (const state of states) {
    for (const isSeries of [true, false]) {
      for (const infoHash of [null, "hash"]) {
        const action = resolvePrimaryAction(
          payload({ availability: state, isSeries, infoHash }),
        );
        assert.ok(
          action.kind === "play" || action.kind === "get" || action.kind === "stream",
          `${state}/${isSeries}/${infoHash} produced ${action.kind}`,
        );
        assert.ok(
          !/search/i.test(action.label),
          `${state}/${isSeries}/${infoHash} labelled ${action.label}`,
        );
      }
    }
  }
});

check("nextUpTarget: the library cursor is the app's one notion of next", () => {
  const target = nextUpTarget(
    payload({
      library: { ...payload().library, cursorSeason: 3, cursorEpisode: 2 },
      episodes: [episode({ season: 1, episode: 9, infoHash: "h" })],
    }),
  );
  assert.deepEqual(target, { season: 3, episode: 2 });
});

check("nextUpTarget: else the one after the last we hold", () => {
  const target = nextUpTarget(
    payload({
      episodes: [
        episode({ season: 2, episode: 4, infoHash: "h1" }),
        episode({ season: 2, episode: 5, infoHash: "h2" }),
        episode({ season: 2, episode: 6, infoHash: null }),
      ],
      season: 2,
    }),
  );
  assert.deepEqual(target, { season: 2, episode: 6 });
});

check("nextUpTarget: else the only episode every series has", () => {
  assert.deepEqual(nextUpTarget(payload()), { season: 1, episode: 1 });
});

// ---------------------------------------------------------------------------
// Episode rows
// ---------------------------------------------------------------------------

check("resolveEpisodeAction: an unchecked episode is still clickable", () => {
  const action = resolveEpisodeAction(episode({ season: 4, episode: 11 }));
  assert.equal(action.kind, "stream");
  assert.equal(action.season, 4);
  assert.equal(action.episode, 11);
});

check("resolveEpisodeAction: a held episode plays itself", () => {
  const action = resolveEpisodeAction(
    episode({ season: 4, episode: 11, availability: "ready", infoHash: "h" }),
  );
  assert.equal(action.kind, "play");
  assert.equal(action.season, 4);
  assert.equal(action.episode, 11);
});

check("resolveEpisodeAction: a partly-watched episode resumes", () => {
  const action = resolveEpisodeAction(
    episode({
      availability: "warm",
      infoHash: "h",
      resumePositionSec: 300,
    }),
  );
  assert.equal(action.label, "Resume");
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

check("titleActionLabel: primary slot keeps the action word while status moves below", () => {
  const get = resolvePlayableAction({ availability: "unavailable", infoHash: null });
  assert.equal(titleActionLabel(get, "idle"), "Get");
  assert.equal(titleActionLabel(get, "pending"), "Get");
  assert.equal(titleActionLabel(get, "done"), "Get");
  assert.equal(titleActionLabel(get, "error"), "Try again");
});

check("titleActionLabel: a stream stays a Play action while it looks", () => {
  const stream = resolvePlayableAction({ availability: "fetchable", infoHash: null });
  assert.equal(titleActionLabel(stream, "idle"), "Play");
  assert.equal(titleActionLabel(stream, "pending"), "Play");
  assert.equal(titleActionLabel(stream, "error"), "Try again");
  for (const status of ["idle", "pending", "done", "error"] as const) {
    assert.ok(!/search/i.test(titleActionLabel(stream, status)));
  }
});

check("titleActionLabel: play never says Search in any status", () => {
  const play = resolvePlayableAction({ availability: "ready", infoHash: "h" });
  for (const status of ["idle", "pending", "done", "error"] as const) {
    assert.ok(!/search/i.test(titleActionLabel(play, status)));
  }
});

// ---------------------------------------------------------------------------
// Merging the second round trip
// ---------------------------------------------------------------------------

function localEpisode(
  season: number,
  episode: number,
  extra: Partial<TitleEpisode> = {},
): TitleEpisode {
  return {
    season,
    episode,
    label: `S0${season}E0${episode}`,
    availability: null,
    infoHash: null,
    filePath: null,
    downloadFraction: null,
    watchedFraction: null,
    resumePositionSec: null,
    watched: false,
    nextUp: false,
    fromPack: false,
    ...extra,
  };
}

function meta(
  episode: number,
  extra: Partial<TitleEpisodeMeta> = {},
): TitleEpisodeMeta {
  return {
    episode,
    name: `Episode ${episode}`,
    overview: null,
    airDate: null,
    runtimeMin: null,
    stillUrl: null,
    ...extra,
  };
}

check("mergeEpisodes: the provider's list sets the shape of the season", () => {
  const { rows } = mergeEpisodes({
    season: 2,
    episodes: [localEpisode(2, 1), localEpisode(2, 2)],
    meta: [meta(1), meta(2), meta(3), meta(4)],
    metaSeason: 2,
  });
  assert.deepEqual(
    rows.map((r) => r.episode),
    [1, 2, 3, 4],
  );
  // Rows nothing local knows about are "not determined", never a claim.
  assert.equal(rows[2].availability, null);
  assert.equal(rows[2].infoHash, null);
  assert.equal(rows[2].label, "S02E03");
});

check("mergeEpisodes: local state is never overwritten by provider data", () => {
  const { rows } = mergeEpisodes({
    season: 1,
    episodes: [
      localEpisode(1, 1, {
        availability: "ready",
        infoHash: "abc",
        resumePositionSec: 90,
        watched: true,
        fromPack: true,
      }),
    ],
    meta: [meta(1, { name: "Good Morning" })],
    metaSeason: 1,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].availability, "ready");
  assert.equal(rows[0].infoHash, "abc");
  assert.equal(rows[0].resumePositionSec, 90);
  assert.equal(rows[0].watched, true);
  assert.equal(rows[0].fromPack, true);
  assert.equal(rows[0].meta?.name, "Good Morning");
});

check("mergeEpisodes: another season's names are refused, not pinned on", () => {
  const { rows } = mergeEpisodes({
    season: 2,
    episodes: [localEpisode(2, 1)],
    meta: [meta(1, { name: "Wrong Season" }), meta(2)],
    metaSeason: 1,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta, null);
});

check("mergeEpisodes: episode 0 is a special, not episode one", () => {
  const { rows } = mergeEpisodes({
    season: 1,
    episodes: [],
    meta: [meta(0, { name: "Special" }), meta(1)],
    metaSeason: 1,
  });
  assert.deepEqual(
    rows.map((r) => r.episode),
    [1],
  );
});

check("mergeEpisodes: provider rows without a known season are dropped", () => {
  const { rows } = mergeEpisodes({
    season: null,
    episodes: [],
    meta: [meta(1), meta(2)],
    metaSeason: null,
  });
  assert.deepEqual(rows, []);
});

check("mergeEpisodes: a long season is capped and says so", () => {
  const { rows, truncated } = mergeEpisodes({
    season: 1,
    episodes: [],
    meta: Array.from({ length: 260 }, (_, i) => meta(i + 1)),
    metaSeason: 1,
  });
  assert.equal(rows.length, 200);
  assert.equal(truncated, true);
  assert.equal(rows[0].episode, 1);
  assert.equal(rows[199].episode, 200);
});

check("mergeEpisodes: an added row is gettable, never a dead control", () => {
  const { rows } = mergeEpisodes({
    season: 3,
    episodes: [],
    meta: [meta(7)],
    metaSeason: 3,
  });
  const action = resolveEpisodeAction(rows[0]);
  assert.equal(action.kind, "stream");
  assert.equal(action.season, 3);
  assert.equal(action.episode, 7);
  assert.ok(!/search/i.test(titleActionLabel(action, "idle")));
});

check("mergeSeasons: the tabs are what we hold plus what the show has", () => {
  const merged = mergeSeasons(
    [
      {
        season: 2,
        knownEpisodes: 5,
        pack: {
          name: "Pack",
          availability: "ready",
          infoHash: "p",
          downloadFraction: null,
        },
      },
    ],
    [3, 1, 2],
  );
  assert.deepEqual(
    merged.map((s) => s.season),
    [1, 2, 3],
  );
  // The row we hold keeps its pack; the invented ones claim nothing.
  assert.equal(merged[1].pack?.infoHash, "p");
  assert.equal(merged[0].pack, null);
  assert.equal(merged[0].knownEpisodes, 0);
});

check("mergeSeasons: season 0 and junk never become a tab", () => {
  const merged = mergeSeasons([], [0, -1, 1.5, 2]);
  assert.deepEqual(
    merged.map((s) => s.season),
    [2],
  );
});

const NOW = new Date("2026-03-10T12:00:00Z");
const AIRED_CASES: { name: string; date: string | null; expect: boolean }[] = [
  { name: "long past", date: "2019-01-01", expect: false },
  { name: "yesterday", date: "2026-03-09", expect: false },
  { name: "today counts as aired", date: "2026-03-10", expect: false },
  { name: "tomorrow", date: "2026-03-11", expect: true },
  { name: "next year", date: "2027-01-01", expect: true },
  { name: "unknown is not a claim", date: null, expect: false },
];

for (const c of AIRED_CASES) {
  check(`isUnaired: ${c.name}`, () => {
    assert.equal(isUnaired(c.date, NOW), c.expect);
  });
}

check("formatAirDate: readable, and never locale-dependent", () => {
  assert.equal(formatAirDate("2026-03-12"), "12 Mar 2026");
  assert.equal(formatAirDate("2022-01-01"), "1 Jan 2022");
  assert.equal(formatAirDate("2022-12-31"), "31 Dec 2022");
  assert.equal(formatAirDate("2022-13-01"), null);
  assert.equal(formatAirDate("nonsense"), null);
  assert.equal(formatAirDate(""), null);
  assert.equal(formatAirDate(null), null);
});

check("formatRuntime: only a real runtime prints", () => {
  assert.equal(formatRuntime(48), "48 min");
  assert.equal(formatRuntime(0), null);
  assert.equal(formatRuntime(-5), null);
  assert.equal(formatRuntime(null), null);
  assert.equal(formatRuntime(Number.NaN), null);
});

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} title test(s) failed.`);
  process.exit(1);
}
console.log("\nAll title tests passed.");
