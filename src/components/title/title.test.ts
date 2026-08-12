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
  offersDownload,
  transferStatusLine,
  resolveEpisodeAction,
  resolvePlayableAction,
  resolvePrimaryAction,
  shouldRunTitleAction,
  titleActionButtonLabel,
  type TitleAction,
  type TitleActionStatus,
} from "./title-actions";
import { titleFacts } from "./title-facts";
import {
  formatAirDate,
  formatRuntime,
  isUnaired,
  mergeEpisodes,
  mergeSeasons,
} from "./merge-extras";
import {
  EMPTY_EPISODES_COPY,
  episodeListView,
  episodeSeasonSummary,
} from "./episode-list-state";
import {
  canOfferSeasonGrab,
  episodeStatusesFromSeasonReport,
  seasonGrabSummary,
  shouldRunSeasonGrab,
  type SeasonGrabReport,
  type SeasonGrabStatus,
} from "./season-grab-state";
import type {
  TitleDetailPayload,
  TitleEpisode,
  TitleEpisodeMeta,
  TitleEpisodeTransfer,
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
  assert.equal(
    displayTitleFromWorkKey("that-time-i-got-reincarnated-as-a-slime"),
    "That Time I Got Reincarnated as a Slime",
  );
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

check("titlePath: carries exact provider identity for recommendation cards", () => {
  const href = titlePath("overlord", {
    title: "Overlord",
    year: 2015,
    mediaType: "anime",
    provider: "anilist",
    providerId: "20832",
    sourceType: "anime",
    format: "TV",
    series: true,
    aliases: ["Overlord"],
  });
  const qs = new URLSearchParams(href.split("?")[1]);
  assert.equal(qs.get("provider"), "anilist");
  assert.equal(qs.get("providerId"), "20832");
  assert.equal(qs.get("sourceType"), "anime");
  assert.equal(qs.get("format"), "TV");
  assert.equal(qs.get("series"), "1");
  assert.deepEqual(qs.getAll("alias"), ["Overlord"]);
});

check("titlePath: omits incomplete AniList identity instead of creating a 400 link", () => {
  const href = titlePath("unknown-anime", {
    title: "Unknown Anime",
    mediaType: "anime",
    provider: "anilist",
    providerId: "123",
    sourceType: "anime",
    format: null,
    series: true,
  });
  const qs = new URLSearchParams(href.split("?")[1]);
  assert.equal(qs.get("provider"), null);
  assert.equal(qs.get("providerId"), null);
});

check("titlePath: never points at the release table", () => {
  const href = titlePath("severance", { title: "Severance", season: 2 });
  assert.ok(!href.includes("/search"), href);
  assert.equal(
    new URLSearchParams(href.split("?")[1]).get("s"),
    null,
    "selected seasons live in the per-title cookie, not the URL",
  );
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
    name: "unavailable still plays — retries the ladder",
    availability: "unavailable",
    infoHash: null,
    expectKind: "stream",
    expectLabel: "Play",
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

check("null is not unavailable: both stay actionable as Play", () => {
  const unchecked = resolvePlayableAction({ availability: null, infoHash: null });
  const priorMiss = resolvePlayableAction({
    availability: "unavailable",
    infoHash: null,
  });
  // Both are Play-via-grab. A prior miss is not a permanent demotion to Get —
  // the ladder may have improved (anime aliases, dual categories).
  assert.equal(unchecked.kind, "stream");
  assert.equal(unchecked.label, "Play");
  assert.equal(priorMiss.kind, "stream");
  assert.equal(priorMiss.label, "Play");
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
    transfer: null,
    ...over,
  };
}

function payload(over: Partial<TitleDetailPayload> = {}): TitleDetailPayload {
  return {
    workKey: "severance",
    transfer: null,
    title: "Severance",
    aliases: [],
    year: null,
    mediaType: "tv",
    isSeries: true,
    overview: null,
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    releaseDate: null,
    availability: null,
    infoHash: null,
    downloadFraction: null,
    resume: null,
    seasons: [{ season: 1, knownEpisodes: 0, pack: null, transfer: null }],
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
    known: true,
    generatedAt: new Date().toISOString(),
    ...over,
  };
}

check("primary action: a series with no episode evidence offers discovery", () => {
  // This used to assert `stream` — a Play pointed at S01E01 on a payload that
  // carried no cursor, no local file and no catalog row. The page then said
  // "no episodes" directly underneath it. The test was pinning that
  // contradiction in place, so it now pins the opposite.
  const action = resolvePrimaryAction(payload());
  assert.equal(action.kind, "discover");
  assert.equal(action.episode, null);
  // Still an action, and still not a bounce to a release table.
  assert.ok(!/search/i.test(action.label));
  assert.equal(action.label, "Find episodes");
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

check("primary action: an unavailable series still offers Play (retry)", () => {
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
  assert.equal(action.kind, "stream");
  assert.equal(action.label, "Play");
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
          action.kind === "play" ||
            action.kind === "get" ||
            action.kind === "stream" ||
            action.kind === "discover",
          `${state}/${isSeries}/${infoHash} produced ${action.kind}`,
        );
        assert.ok(
          !/search/i.test(action.label),
          `${state}/${isSeries}/${infoHash} labelled ${action.label}`,
        );
        // The rule this test is really about: an action that names an episode
        // must have had one to name. `discover` names none; everything else
        // got its target from the cursor, a held file, or a catalog row.
        if (action.kind === "discover") assert.equal(action.episode, null);
        // A movie never becomes a discovery: there are no episodes to find.
        if (!isSeries) assert.notEqual(action.kind, "discover");
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

check("nextUpTarget: a catalog row is evidence even with nothing held", () => {
  const target = nextUpTarget(
    payload({
      episodes: [
        episode({ season: 3, episode: 5, infoHash: null }),
        episode({ season: 3, episode: 4, infoHash: null }),
      ],
      season: 3,
    }),
  );
  // The earliest listed episode, not the earliest *conceivable* one. Nothing
  // here is held, but the server sent both rows, so both demonstrably exist.
  assert.deepEqual(target, { season: 3, episode: 4 });
});

check("nextUpTarget: no cursor, nothing held, no catalog row is not S01E01", () => {
  // The old contract answered `{season: 1, episode: 1}` here, reasoning that
  // every series has a first episode. True of series in general, unfounded
  // about *this* payload — which is the only thing the caller can act on.
  assert.equal(nextUpTarget(payload()), null);
});

// ---------------------------------------------------------------------------
// Transfer state
// ---------------------------------------------------------------------------

check("offersDownload: one intent, one control", () => {
  const cases: {
    status: TitleEpisodeTransfer["status"] | "none";
    offered: boolean;
    why: string;
  }[] = [
    { status: "none", offered: true, why: "nothing asked for yet" },
    { status: "queued", offered: false, why: "already asked for, not started" },
    { status: "downloading", offered: false, why: "the Client is fetching it" },
    { status: "downloaded", offered: false, why: "already held" },
    { status: "failed", offered: true, why: "pressing again is the fix" },
  ];
  for (const c of cases) {
    const transfer =
      c.status === "none"
        ? null
        : { status: c.status, progress: 0.5, infoHash: null, filePath: null, error: null };
    assert.equal(offersDownload(transfer), c.offered, `${c.status}: ${c.why}`);
  }
});

check("transferStatusLine: progress is reported, never rounded up", () => {
  const line = (status: TitleEpisodeTransfer["status"], progress: number) =>
    transferStatusLine({ status, progress, infoHash: null, filePath: null, error: null });

  assert.equal(line("queued", 0), "Queued");
  assert.equal(line("downloaded", 1), "Downloaded");
  assert.equal(line("downloading", 0), "Downloading 0%");
  assert.equal(line("downloading", 0.426), "Downloading 42%");
  // The one that matters: a torrent at 99.6% is not finished, and must not
  // print a number that says it is.
  assert.equal(line("downloading", 0.996), "Downloading 99%");
  assert.equal(line("downloading", 1), "Downloading 100%");
  // Out-of-range progress is clamped rather than printed as nonsense.
  assert.equal(line("downloading", 1.4), "Downloading 100%");
  assert.equal(line("downloading", -0.2), "Downloading 0%");
  assert.equal(transferStatusLine(null), null);
});

check("transferStatusLine: a failure explains itself when it can", () => {
  const failed = (error: string | null) =>
    transferStatusLine({
      status: "failed",
      progress: 0,
      infoHash: null,
      filePath: null,
      error,
    });
  assert.equal(failed("no seeds"), "Failed — no seeds");
  assert.equal(failed("   "), "Failed");
  assert.equal(failed(null), "Failed");
});

check("scopes stay separate: a season transfer is not a title transfer", () => {
  // The defect this pins: the detail route used to read `scope: "episode"`
  // only, so title and season grabs came back as no transfer at all and the
  // page offered Download beside a running download. The payload now carries
  // all three, and each control reads exactly one of them.
  const seasonOnly = payload({
    transfer: null,
    seasons: [
      {
        season: 1,
        knownEpisodes: 0,
        pack: null,
        transfer: {
          status: "downloading",
          progress: 0.4,
          infoHash: "h",
          filePath: null,
          error: null,
        },
      },
    ],
  });
  // The title's own control is untouched by a season grab.
  assert.equal(offersDownload(seasonOnly.transfer), true);
  assert.equal(transferStatusLine(seasonOnly.transfer), null);
  // And the season still reports its own state.
  assert.equal(
    transferStatusLine(seasonOnly.seasons[0].transfer),
    "Downloading 40%",
  );
});

check("primary action: a downloading title keeps Play but loses Download", () => {
  const downloading = payload({
    isSeries: false,
    seasons: [],
    season: null,
    availability: "fetchable",
    transfer: {
      status: "downloading",
      progress: 0.3,
      infoHash: "h",
      filePath: null,
      error: null,
    },
  });
  // Play survives: sequential piece selection means a partial file is
  // watchable, so removing Play mid-download would be a regression, not a fix.
  assert.equal(resolvePrimaryAction(downloading).kind, "stream");
  assert.equal(offersDownload(downloading.transfer), false);
  assert.equal(transferStatusLine(downloading.transfer), "Downloading 30%");
});


// ---------------------------------------------------------------------------

check("episodeListView: loading with no rows shows skeletons, never empty copy", () => {
  const view = episodeListView({ status: "loading" }, 0);
  assert.equal(view.kind, "loading");
  assert.ok(view.skeletonRows > 0);
  assert.ok(!("copy" in view) || view.copy !== EMPTY_EPISODES_COPY);
});

check("episodeListView: background loading keeps existing rows undimmed", () => {
  const view = episodeListView({ status: "loading" }, 4);
  assert.deepEqual(view, { kind: "rows" });
});

check("episodeListView: settled with no rows preserves the honest empty copy", () => {
  const view = episodeListView({ status: "ready" }, 0);
  assert.deepEqual(view, { kind: "empty", copy: EMPTY_EPISODES_COPY });
});

check("episodeListView: failed load is an error, not empty", () => {
  const view = episodeListView({ status: "error", message: "TMDB timed out" }, 0);
  assert.deepEqual(view, { kind: "error", message: "TMDB timed out" });
  assert.notEqual(view.kind, "empty");
});

check("episodeSeasonSummary: header distinguishes loading, rows, empty, and error", () => {
  assert.equal(
    episodeSeasonSummary(3, 0, { status: "loading" }),
    "Loading season 3",
  );
  assert.equal(episodeSeasonSummary(3, 7, { status: "ready" }), "7 in season 3");
  assert.equal(episodeSeasonSummary(3, 0, { status: "ready" }), "Season 3");
  assert.equal(
    episodeSeasonSummary(3, 0, { status: "error", message: "Nope" }),
    "Could not load season 3",
  );
});

check("seasonGrabSummary: idle is unknown, not dead", () => {
  assert.equal(
    seasonGrabSummary({ status: "idle" }, 1),
    "Season coverage not measured yet.",
  );
});

check("canOfferSeasonGrab: no known episodes means no season action", () => {
  assert.equal(canOfferSeasonGrab(1, 0), false);
  assert.equal(canOfferSeasonGrab(null, 10), false);
  assert.equal(canOfferSeasonGrab(1, 10), true);
});

check("seasonGrabSummary: loading does not claim empty coverage", () => {
  assert.equal(seasonGrabSummary({ status: "pending" }, 2), "Checking season 2…");
});

check("seasonGrabSummary: coverage names missing episodes", () => {
  const report: SeasonGrabReport = {
    season: 1,
    totalEpisodes: 10,
    coveredEpisodes: 8,
    strategy: "mixed",
    coverageConfirmed: true,
    episodes: [
      ...Array.from({ length: 8 }, (_, i) => ({
        episode: i + 1,
        status: "covered" as const,
      })),
      { episode: 9, status: "missing" as const, reason: "No acceptable release" },
      { episode: 10, status: "missing" as const, reason: "No acceptable release" },
    ],
  };

  assert.equal(
    seasonGrabSummary({ status: "done", report }, 1),
    "8 of 10 episodes covered. Missing: S01E09, S01E10.",
  );
});

check("seasonGrabSummary: error is not empty", () => {
  assert.equal(
    seasonGrabSummary({ status: "error", message: "Planner failed" }, 4),
    "Could not plan season 4. Planner failed",
  );
});

check("shouldRunSeasonGrab: pressing twice after success submits one grab", () => {
  let status: SeasonGrabStatus = { status: "idle" };
  let grabs = 0;

  const press = () => {
    if (!shouldRunSeasonGrab(status)) return;
    grabs += 1;
    status = {
      status: "done",
      report: {
        season: 1,
        totalEpisodes: 1,
        coveredEpisodes: 1,
        strategy: "singles",
        coverageConfirmed: true,
        episodes: [{ episode: 1, status: "covered" }],
      },
    };
  };

  press();
  press();

  assert.equal(grabs, 1);
});

check("episodeStatusesFromSeasonReport: season grab lights rows individually", () => {
  const report: SeasonGrabReport = {
    season: 2,
    totalEpisodes: 3,
    coveredEpisodes: 1,
    strategy: "singles",
    coverageConfirmed: true,
    episodes: [
      { episode: 1, status: "covered" },
      { episode: 2, status: "missing", reason: "No release" },
      { episode: 3, status: "not_measured", reason: "Planner skipped it" },
    ],
  };

  // "missing" must not become a permanent per-row error — that painted
  // "Could not start …" under episodes that were already Ready/Downloaded.
  assert.deepEqual(episodeStatusesFromSeasonReport(report), {
    s2e1: "done",
  });
});

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

check("titleActionButtonLabel: primary slot keeps the action word while status moves below", () => {
  const play = resolvePlayableAction({ availability: "unavailable", infoHash: null });
  assert.equal(titleActionButtonLabel(play, "idle"), "Play");
  assert.equal(titleActionButtonLabel(play, "pending"), "Play");
  assert.equal(titleActionButtonLabel(play, "done"), "Play");
  assert.equal(titleActionButtonLabel(play, "error"), "Retry play");
});

check("titleActionButtonLabel: a stream stays a Play action while it looks", () => {
  const stream = resolvePlayableAction({ availability: "fetchable", infoHash: null });
  assert.equal(titleActionButtonLabel(stream, "idle"), "Play");
  assert.equal(titleActionButtonLabel(stream, "pending"), "Play");
  assert.equal(titleActionButtonLabel(stream, "error"), "Retry play");
  for (const status of ["idle", "pending", "done", "error"] as const) {
    assert.ok(!/search/i.test(titleActionButtonLabel(stream, status)));
  }
});

check("titleActionButtonLabel: a failed retry says what it will retry", () => {
  // "Try again" was the label for all three, so a viewer who had just watched
  // a Download fail and a Play fail saw the same four characters and could not
  // tell which control had broken, let alone what to do about it.
  const play = resolvePlayableAction({ availability: "ready", infoHash: "h" });
  const stream = resolvePlayableAction({ availability: "fetchable", infoHash: null });
  const get: TitleAction = { kind: "get", label: "Download", season: 1, episode: 1 };
  const discover: TitleAction = {
    kind: "discover",
    label: "Find episodes",
    season: 1,
    episode: null,
  };

  const labels = [play, stream, get, discover].map((a) =>
    titleActionButtonLabel(a, "error"),
  );
  assert.deepEqual(labels, [
    "Retry play",
    "Retry play",
    "Retry download",
    "Retry search",
  ]);
  // Play and stream deliberately share copy: both open the player, and the
  // viewer does not care which internal path got there. Download and discovery
  // are different outcomes and must read differently.
  assert.notEqual(labels[1], labels[2]);
  assert.notEqual(labels[2], labels[3]);
  for (const label of labels) assert.notEqual(label, "Try again");
});

check("titleActionButtonLabel: discovery keeps its word until it fails", () => {
  const discover: TitleAction = {
    kind: "discover",
    label: "Find episodes",
    season: null,
    episode: null,
  };
  assert.equal(titleActionButtonLabel(discover, "idle"), "Find episodes");
  assert.equal(titleActionButtonLabel(discover, "pending"), "Find episodes");
});

check("titleActionButtonLabel: play never says Search in any status", () => {
  const play = resolvePlayableAction({ availability: "ready", infoHash: "h" });
  for (const status of ["idle", "pending", "done", "error"] as const) {
    assert.ok(!/search/i.test(titleActionButtonLabel(play, status)));
  }
});

check("shouldRunTitleAction: pressing stream twice after success submits one grab", () => {
  const stream = resolvePlayableAction({ availability: "unavailable", infoHash: null });
  let status: TitleActionStatus = "idle";
  let grabs = 0;

  const press = () => {
    if (!shouldRunTitleAction(stream, status)) return;
    grabs += 1;
    status = "done";
  };

  press();
  press();

  assert.equal(grabs, 1);
});

check("shouldRunTitleAction: done only spends remote grab actions", () => {
  const play = resolvePlayableAction({ availability: "ready", infoHash: "h" });
  const stream = resolvePlayableAction({ availability: "fetchable", infoHash: null });
  const priorMiss = resolvePlayableAction({ availability: "unavailable", infoHash: null });

  assert.equal(shouldRunTitleAction(play, "done"), true);
  assert.equal(shouldRunTitleAction(stream, "done"), false);
  assert.equal(shouldRunTitleAction(priorMiss, "done"), false);
  assert.equal(shouldRunTitleAction(priorMiss, "error"), true);
  assert.equal(shouldRunTitleAction(stream, "pending"), false);
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
    transfer: null,
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
  assert.ok(!/search/i.test(titleActionButtonLabel(action, "idle")));
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
        transfer: null,
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

check("seasonGrabSummary: unconfirmed pack coverage is not stated as fact", () => {
  const report: SeasonGrabReport = {
    season: 1,
    totalEpisodes: 9,
    coveredEpisodes: 9,
    strategy: "pack",
    coverageConfirmed: false,
    episodes: Array.from({ length: 9 }, (_, i) => ({
      episode: i + 1,
      status: "covered" as const,
    })),
  };
  const summary = seasonGrabSummary({ status: "done", report }, 1);
  // A bare `S01` pack claims the whole season without proving it. Reporting
  // "9 of 9 episodes covered" here would repeat the advertised-vs-delivered
  // mistake the swarm probe exists to resist, one field over.
  assert(
    !summary.startsWith("9 of 9 episodes covered"),
    `unconfirmed coverage must not be asserted as fact, got: ${summary}`,
  );
  assert(summary.includes("aren't confirmed"), `expected a hedge, got: ${summary}`);

  const confirmed = seasonGrabSummary(
    { status: "done", report: { ...report, coverageConfirmed: true } },
    1,
  );
  assert(
    confirmed.startsWith("9 of 9 episodes covered"),
    `confirmed coverage should be stated plainly, got: ${confirmed}`,
  );
});
