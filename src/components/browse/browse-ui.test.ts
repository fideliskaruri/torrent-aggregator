/**
 * Browse UI logic tests.
 *
 * The components are `.tsx` and cannot be imported by this runner, so every
 * decision worth asserting lives in a plain module: what a card is allowed to
 * offer, what a title looks like once the release noise is gone, which arrow
 * is lit, where focus goes, and what the hero says. Those are the rules; the
 * JSX is just paint.
 *
 * Table-driven over diverse inputs per AGENTS.md — each table covers the rule
 * class, not the one example that prompted it.
 *
 * Run: npx tsx src/components/browse/browse-ui.test.ts
 */
import assert from "node:assert/strict";
import type { AvailabilityState, Rail, RailItem } from "@/lib/browse";
import { SEARCH_HREF } from "@/lib/navigation";
import {
  actionLabel,
  availabilityMeta,
  clampFraction,
  cleanDisplayTitle,
  formatClock,
  progressPercent,
  resolveCardAction,
  searchAction,
  searchCategoryFor,
  searchHref,
  type ActionStatus,
  type CardAction,
} from "./availability";
import { heroFacts, heroPitch, pickHeroItem } from "./hero";
import { isOptimizableImageUrl, posterInitial, posterTint } from "./poster";
import { nextFocusIndex, pageScrollDelta, railEdges } from "./rail-scroll";
import { RAIL_PREVIEWS, isFirstRun, missingRailPreviews } from "./first-run";

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
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Every state the UI can be handed. `null` is the unresolved answer and belongs
 * in this list — it is a case to cover, not a gap.
 */
const ALL_STATES: Array<AvailabilityState | null> = [
  "ready",
  "warm",
  "fetchable",
  "unavailable",
  null,
];

function item(overrides: Partial<RailItem> = {}): RailItem {
  return {
    id: "row-1",
    title: "Severance",
    subtitle: null,
    posterUrl: null,
    backdropUrl: null,
    availability: null,
    progressFraction: null,
    resumePositionSec: null,
    infoHash: null,
    filePath: null,
    watchListItemId: null,
    mediaType: null,
    season: null,
    episode: null,
    ...overrides,
  };
}

function rail(id: string, items: RailItem[], title = id): Rail {
  return { id, title, items };
}

// ---------------------------------------------------------------------------
// The product rule: never offer a Play that will not play
// ---------------------------------------------------------------------------

console.log("browse-ui: card actions…");

/**
 * The whole matrix of availability × "do we hold the hash" × "can we name an
 * episode". A `ready` claim with no info hash is the case the rule exists for:
 * the player has nothing to open, so Play must not appear.
 */
const ACTION_CASES: Array<{
  name: string;
  input: RailItem;
  kind: CardAction["kind"];
  label: string;
  disabled: boolean;
}> = [
  {
    name: "ready + hash → Play",
    input: item({ availability: "ready", infoHash: "abc123" }),
    kind: "play",
    label: "Play",
    disabled: false,
  },
  {
    name: "ready + hash + resume position → Resume",
    input: item({
      availability: "ready",
      infoHash: "abc123",
      resumePositionSec: 641,
    }),
    kind: "play",
    label: "Resume",
    disabled: false,
  },
  {
    name: "warm + hash → Play",
    input: item({ availability: "warm", infoHash: "def456" }),
    kind: "play",
    label: "Play",
    disabled: false,
  },
  {
    name: "warm + hash + resume → Resume",
    input: item({
      availability: "warm",
      infoHash: "def456",
      resumePositionSec: 12,
    }),
    kind: "play",
    label: "Resume",
    disabled: false,
  },
  {
    name: "ready but NO hash → must not offer Play",
    input: item({ availability: "ready", infoHash: null }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "warm but blank hash → must not offer Play",
    input: item({ availability: "warm", infoHash: "   " }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "ready, no hash, but episode known → Download",
    input: item({ availability: "ready", season: 2, episode: 7 }),
    kind: "get",
    label: "Download",
    disabled: false,
  },
  {
    name: "fetchable + episode → Download",
    input: item({ availability: "fetchable", season: 1, episode: 3 }),
    kind: "get",
    label: "Download",
    disabled: false,
  },
  {
    name: "fetchable, no episode → Find it",
    input: item({ availability: "fetchable" }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "fetchable with a hash it cannot play → still not Play",
    input: item({ availability: "fetchable", infoHash: "aaa" }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "unavailable → disabled, never a search primary",
    input: item({ availability: "unavailable", season: 1, episode: 1 }),
    kind: "blocked",
    label: "Unavailable",
    disabled: true,
  },
  {
    name: "unavailable + hash (stale claim) → still disabled",
    input: item({ availability: "unavailable", infoHash: "zzz" }),
    kind: "blocked",
    label: "Unavailable",
    disabled: true,
  },
  {
    name: "unresolved (null) is not a verdict → clickable, neutral Find it",
    input: item({ availability: null }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "unresolved + episode → still Find it, never a grab we cannot justify",
    input: item({ availability: null, season: 4, episode: 11 }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "unresolved + hash it cannot play → Find it, not Play",
    input: item({ availability: null, infoHash: "aaa" }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "unresolved with no title → blocked, nothing to check",
    input: item({ availability: null, title: "  " }),
    kind: "blocked",
    label: "Unavailable",
    disabled: true,
  },
  {
    name: "no title at all → blocked, nothing to look up",
    input: item({ availability: "fetchable", title: "   " }),
    kind: "blocked",
    label: "Unavailable",
    disabled: true,
  },
  {
    name: "season 0 is not an episode we can grab",
    input: item({ availability: "fetchable", season: 0, episode: 5 }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "fractional episode is not grabbable",
    input: item({ availability: "fetchable", season: 1, episode: 5.5 }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
  {
    name: "season without episode is not grabbable",
    input: item({ availability: "fetchable", season: 2, episode: null }),
    kind: "search",
    label: "Find it",
    disabled: false,
  },
];

for (const c of ACTION_CASES) {
  check(`action: ${c.name}`, () => {
    const action = resolveCardAction(c.input);
    assert.equal(action.kind, c.kind);
    assert.equal(action.label, c.label);
    assert.equal(action.disabled, c.disabled);
  });
}

check("action: Play carries the hash the player needs", () => {
  const action = resolveCardAction(
    item({
      availability: "warm",
      infoHash: " abc123 ",
      filePath: "Show/ep.mkv",
      resumePositionSec: 90,
    }),
  );
  assert.equal(action.kind, "play");
  if (action.kind !== "play") return;
  assert.equal(action.infoHash, "abc123", "hash is trimmed, never blank");
  assert.equal(action.filePath, "Show/ep.mkv");
  assert.equal(action.resumePositionSec, 90);
});

check("action: no play action is ever emitted without a usable hash", () => {
  // The rule as a property, over every state, rather than as one example.
  for (const state of ALL_STATES) {
    for (const hash of [null, "", "   "]) {
      const action = resolveCardAction(
        item({ availability: state, infoHash: hash }),
      );
      assert.notEqual(
        action.kind,
        "play",
        `state=${state} hash=${JSON.stringify(hash)} offered Play with nothing to open`,
      );
    }
  }
});

check("action: unavailable is the only dead end a titled item can reach", () => {
  // The distinction the data layer asked for: not-looked-yet (`null`) must stay
  // a live affordance, and only a completed, empty search may disable a card.
  for (const state of ALL_STATES) {
    for (const monitored of [null, "w1"]) {
      for (const ep of [null, 3]) {
        const action = resolveCardAction(
          item({
            availability: state,
            watchListItemId: monitored,
            season: ep == null ? null : 1,
            episode: ep,
          }),
        );
        const expectBlocked = state === "unavailable";
        assert.equal(
          action.disabled,
          expectBlocked,
          `state=${state} monitored=${monitored} episode=${ep} disabled=${action.disabled}`,
        );
      }
    }
  }
});

check("action: unresolved never promises a grab or a play", () => {
  for (const ep of [null, 1, 12]) {
    for (const hash of [null, "abc"]) {
      const action = resolveCardAction(
        item({
          availability: null,
          season: ep == null ? null : 2,
          episode: ep,
          infoHash: hash,
        }),
      );
      assert.equal(action.kind, "search");
      assert.equal(action.label, "Find it");
      assert.equal(action.disabled, false);
    }
  }
});

check("action: every disabled action explains itself", () => {
  const blocked = [
    item({ availability: "unavailable" }),
    item({ availability: "unavailable", watchListItemId: "w1" }),
    item({ availability: "fetchable", title: "" }),
  ];
  for (const row of blocked) {
    const action = resolveCardAction(row);
    assert.equal(action.disabled, true);
    assert.ok(
      action.kind === "blocked" && action.reason.trim().length > 10,
      "a disabled control without a reason is a dead end",
    );
  }
  // A monitored library row says something different from an orphan row.
  const monitored = resolveCardAction(
    item({ availability: "unavailable", watchListItemId: "w1" }),
  );
  const orphan = resolveCardAction(item({ availability: "unavailable" }));
  assert.notEqual(
    monitored.kind === "blocked" ? monitored.reason : "",
    orphan.kind === "blocked" ? orphan.reason : "",
  );
});

check("action: Download carries a complete grab request", () => {
  const action = resolveCardAction(
    item({
      availability: "fetchable",
      title: "  Severance  ",
      mediaType: "TV",
      season: 2,
      episode: 7,
      watchListItemId: "w9",
    }),
  );
  assert.equal(action.kind, "get");
  if (action.kind !== "get") return;
  assert.deepEqual(action.request, {
    watchListItemId: "w9",
    title: "Severance",
    mediaType: "tv",
    season: 2,
    episode: 7,
  });
});

check("action: a grab with no media type defaults to tv, not blank", () => {
  const action = resolveCardAction(
    item({ availability: "fetchable", season: 1, episode: 1, mediaType: "  " }),
  );
  assert.equal(action.kind, "get");
  if (action.kind !== "get") return;
  assert.equal(action.request.mediaType, "tv");
});

// ---------------------------------------------------------------------------
// The secondary escape hatch
// ---------------------------------------------------------------------------

console.log("browse-ui: search fallback…");

check("search fallback exists for every state, including blocked ones", () => {
  for (const state of ALL_STATES) {
    const fallback = searchAction(item({ availability: state }));
    assert.ok(fallback, `state=${state} left the user with no way to look`);
    assert.ok(fallback.href.startsWith(`${SEARCH_HREF}?`));
    assert.equal(fallback.disabled, false);
  }
  assert.equal(
    searchAction(item({ title: "  " })),
    null,
    "nothing to search for when there is no title",
  );
});

const SEARCH_HREF_CASES: Array<{
  title: string;
  category: string | null;
  expect: string;
}> = [
  { title: "Severance", category: null, expect: "/search?q=Severance" },
  { title: "Severance", category: "tv", expect: "/search?q=Severance&category=tv" },
  {
    title: "Severance",
    category: "all",
    expect: "/search?q=Severance",
  },
  {
    title: "Attack on Titan",
    category: "anime",
    expect: "/search?q=Attack+on+Titan&category=anime",
  },
  {
    title: "9-1-1: Lone Star",
    category: null,
    expect: "/search?q=9-1-1%3A+Lone+Star",
  },
];

for (const c of SEARCH_HREF_CASES) {
  check(`searchHref: ${c.title} / ${c.category ?? "no category"}`, () => {
    assert.equal(searchHref(c.title, c.category), c.expect);
  });
}

const CATEGORY_CASES: Array<[string | null, string | null]> = [
  ["anime", "anime"],
  ["Anime", "anime"],
  [" TV ", "tv"],
  ["movie", "movies"],
  ["movies", "movies"],
  ["music", null],
  ["", null],
  [null, null],
];

for (const [input, expected] of CATEGORY_CASES) {
  check(`searchCategoryFor(${JSON.stringify(input)})`, () => {
    assert.equal(searchCategoryFor(input), expected);
  });
}

check("searchHref cleans the release name before searching", () => {
  // Searching the raw release name returns nothing — the query has to be the
  // same cleaned string the card displays.
  const action = searchAction(
    item({ title: "[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv" }),
  );
  assert.ok(action);
  assert.ok(
    action.href.includes("Frieren"),
    `query kept release noise: ${action.href}`,
  );
  assert.ok(!action.href.includes("SubsPlease"));
  assert.ok(!action.href.includes("1080p"));
});

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

console.log("browse-ui: title cleaning…");

const TITLE_CASES: Array<{ raw: string; expect: string }> = [
  // Fansub bracket groups, the anime norm.
  { raw: "[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv", expect: "Frieren - 12" },
  { raw: "[Erai-raws] Dandadan - 05 [1080p][Multiple Subtitle]", expect: "Dandadan - 05" },
  // Dot-separated scene names.
  {
    raw: "Severance.S02E07.1080p.WEB-DL.DDP5.1.H.264-NTb",
    expect: "Severance S02E07",
  },
  { raw: "The.Bear.S03E01.2160p.HDR.x265", expect: "The Bear S03E01" },
  { raw: "Dune.Part.Two.2021.1080p.BluRay.x264-FLAME", expect: "Dune Part Two 2021" },
  // A hyphenated word in a real title is not a release group.
  { raw: "Spider-Man Across the Spider-Verse", expect: "Spider-Man Across the Spider-Verse" },
  // Site prefixes indexers glue on.
  { raw: "www.Torrenting.com - Dune Part Two 2024 1080p", expect: "Dune Part Two 2024" },
  { raw: "[Nyaa] [SubsPlease] Show - 01 [720p]", expect: "Show - 01" },
  // Already-clean titles must survive untouched.
  { raw: "Severance", expect: "Severance" },
  { raw: "Mr. Robot", expect: "Mr. Robot" },
  { raw: "Blade Runner 2049", expect: "Blade Runner 2049" },
  // A release year in parentheses is information, not noise.
  { raw: "Arrival (2016)", expect: "Arrival (2016)" },
  // Season packs.
  { raw: "The.Wire.S01.COMPLETE.1080p.BluRay.x264", expect: "The Wire S01 COMPLETE" },
  // Degenerate input: cleaning must never empty a card.
  { raw: "[1080p]", expect: "[1080p]" },
  { raw: "1080p", expect: "1080p" },
  { raw: "   ", expect: "" },
  // Distribution-artifact tokens: the platform that carried the release, the
  // capture method for a pre-release rip, and the container it was muxed
  // into. All observed live on the discovery rails.
  {
    raw: "Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H264.MP4-BTM",
    expect: "Obsession 2026",
  },
  {
    raw: "The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE",
    expect: "The Odyssey 2026",
  },
  { raw: "Show.S01E01.1080p.DSNP.WEB-DL.H264-GRP", expect: "Show S01E01" },
  { raw: "Film.2019.HDCAM.XviD-CAMRIP", expect: "Film 2019" },
  { raw: "Film.2019.720p.DVDSCR.XviD", expect: "Film 2019" },
  // The tokens deliberately left out, because each is also a real title or a
  // word inside one. These must survive.
  { raw: "Mad Max Fury Road", expect: "Mad Max Fury Road" },
  { raw: "Cam", expect: "Cam" },
  { raw: "Max", expect: "Max" },
  // A hyphenated title is not a trailing release group.
  { raw: "The.Amazing.Spider-Man", expect: "The Amazing Spider-Man" },
];

for (const c of TITLE_CASES) {
  check(`cleanDisplayTitle: ${JSON.stringify(c.raw)}`, () => {
    assert.equal(cleanDisplayTitle(c.raw), c.expect);
  });
}

check("cleanDisplayTitle never returns an empty string for real input", () => {
  const raws = [
    "[1080p]",
    "x265",
    "WEB-DL",
    "....",
    "[a][b][c]",
    "REPACK.PROPER.1080p",
  ];
  for (const raw of raws) {
    assert.ok(
      cleanDisplayTitle(raw).trim().length > 0,
      `${raw} cleaned away to nothing — an ugly title beats a blank card`,
    );
  }
});

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

console.log("browse-ui: numbers…");

const FRACTION_CASES: Array<[number | null | undefined, number | null]> = [
  [0.42, 0.42],
  [1, 1],
  [1.4, 1],
  [0, null],
  [-0.2, null],
  [null, null],
  [undefined, null],
  [Number.NaN, null],
  [Number.POSITIVE_INFINITY, null],
];

for (const [input, expected] of FRACTION_CASES) {
  check(`clampFraction(${String(input)})`, () => {
    assert.equal(clampFraction(input), expected);
  });
}

const PERCENT_CASES: Array<[number | null, number | null]> = [
  [0.42, 42],
  [0.999, 100],
  // Anything started must read as started; 0% next to a progress bar is a lie.
  [0.001, 1],
  [0.004, 1],
  [0, null],
  [null, null],
];

for (const [input, expected] of PERCENT_CASES) {
  check(`progressPercent(${String(input)})`, () => {
    assert.equal(progressPercent(input), expected);
  });
}

const CLOCK_CASES: Array<[number | null, string | null]> = [
  [0, "0:00"],
  [9, "0:09"],
  [61, "1:01"],
  [1104, "18:24"],
  [3731, "1:02:11"],
  [3600, "1:00:00"],
  [59.9, "0:59"],
  [-1, null],
  [null, null],
  [Number.NaN, null],
];

for (const [input, expected] of CLOCK_CASES) {
  check(`formatClock(${String(input)})`, () => {
    assert.equal(formatClock(input), expected);
  });
}

// ---------------------------------------------------------------------------
// In-flight labels
// ---------------------------------------------------------------------------

console.log("browse-ui: action labels…");

const play = resolveCardAction(item({ availability: "ready", infoHash: "h" }));
const get = resolveCardAction(
  item({ availability: "fetchable", season: 1, episode: 1 }),
);
const find = resolveCardAction(item({ availability: "fetchable" }));
const checkIt = resolveCardAction(item({ availability: null }));
const dead = resolveCardAction(item({ availability: "unavailable" }));

const LABEL_CASES: Array<[CardAction, ActionStatus, string]> = [
  [play, "idle", "Play"],
  [play, "pending", "Opening…"],
  [play, "error", "Try again"],
  [play, "done", "Play"],
  [get, "idle", "Download"],
  [get, "pending", "Starting…"],
  [get, "error", "Try again"],
  // A control that still says "Download" after a successful grab invites a
  // second, duplicate grab.
  [get, "done", "Downloading"],
  // Navigation has no in-flight state of its own: a link that announces
  // "Starting…" is lying about what the click will do.
  [find, "idle", "Find it"],
  [find, "pending", "Find it"],
  [find, "error", "Find it"],
  [find, "done", "Find it"],
  [checkIt, "idle", "Find it"],
  [checkIt, "pending", "Find it"],
  [checkIt, "error", "Find it"],
  [checkIt, "done", "Find it"],
  [dead, "idle", "Unavailable"],
  [dead, "pending", "Unavailable"],
  [dead, "error", "Unavailable"],
  [dead, "done", "Unavailable"],
];

for (const [action, status, expected] of LABEL_CASES) {
  check(`actionLabel: ${action.kind}/${action.label} + ${status}`, () => {
    assert.equal(actionLabel(action, status), expected);
  });
}

// ---------------------------------------------------------------------------
// Chip meta
// ---------------------------------------------------------------------------

console.log("browse-ui: availability chips…");

const CHIP_CASES: Array<[AvailabilityState | null, string]> = [
  ["ready", "success"],
  ["warm", "accent"],
  ["fetchable", "secondary"],
  ["unavailable", "tertiary"],
  // Unresolved: neutral and inviting, not a warning. On a real install most
  // cards land here, and dressing it as a problem would make the page look
  // broken. It must NOT share `unavailable`'s greyed-out tertiary tone.
  [null, "info"],
];

for (const [state, tone] of CHIP_CASES) {
  check(`availabilityMeta(${String(state)})`, () => {
    const meta = availabilityMeta(state);
    assert.equal(meta.tone, tone);
    assert.ok(
      meta.label.trim().length > 0,
      "colour alone must never carry the state",
    );
    assert.ok(
      meta.description === null || meta.description.trim().length > 10,
      "a description that exists must be a real sentence, not a fragment",
    );
  });
}

check("availabilityMeta: unresolved carries no explanatory prose", () => {
  // The user's rule: the app does not narrate its own mechanics. "Not checked"
  // is the whole fact; a sentence telling him to open it to find out is the UI
  // talking about itself.
  assert.equal(availabilityMeta(null).description, null);
});

check("availabilityMeta: unresolved never claims unavailability", () => {
  const unresolved = availabilityMeta(null);
  const dead = availabilityMeta("unavailable");
  assert.notEqual(unresolved.label, dead.label);
  assert.notEqual(unresolved.description, dead.description);
  assert.notEqual(
    unresolved.tone,
    dead.tone,
    "unresolved must not be greyed out like a dead end",
  );
  assert.ok(
    !/nothing|unavailable|no viable/i.test(unresolved.description ?? ""),
    "unresolved must not describe a search that never ran",
  );
});

check("availabilityMeta: every state, including null, has its own word", () => {
  const labels = ALL_STATES.map((s) => availabilityMeta(s).label);
  assert.equal(new Set(labels).size, labels.length, "two states read alike");
  const descriptions = ALL_STATES.map((s) => availabilityMeta(s).description);
  assert.equal(new Set(descriptions).size, descriptions.length);
});

check("availabilityMeta: fetchable names getting, not local readiness", () => {
  assert.equal(availabilityMeta("ready").label, "Ready");
  assert.equal(availabilityMeta("fetchable").label, "Can get");
  assert.notEqual(availabilityMeta("fetchable").label, "Available");
});

check("availabilityMeta: warm is partial, never labelled ready", () => {
  const warm = availabilityMeta("warm");
  // "Partial" names the disk state. "Playable" used to compete with "Ready"
  // as a second word for the same user fact ("you can press Play").
  assert.equal(warm.label, "Partial");
  assert.notEqual(warm.label, availabilityMeta("ready").label);
  assert.match(
    warm.description ?? "",
    /partly downloaded/i,
    "warm copy must say the torrent is still downloading",
  );
});

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

console.log("browse-ui: posters…");

const IMAGE_CASES: Array<[string | null, boolean]> = [
  ["https://image.tmdb.org/t/p/w500/abc.jpg", true],
  ["https://s4.anilist.co/file/anilistcdn/x.jpg", true],
  ["http://image.tmdb.org/t/p/w500/abc.jpg", true],
  // Keyless fallback providers. These must be optimisable: a TVmaze
  // `original_untouched` poster is ~1.3 MB, and a rail of them served raw
  // would cost tens of megabytes.
  ["https://static.tvmaze.com/uploads/images/original_untouched/548/1.jpg", true],
  ["https://is1-ssl.mzstatic.com/image/thumb/x/600x900bb.jpg", true],
  ["https://is5-ssl.mzstatic.com/image/thumb/x/600x900bb.jpg", true],
  // The suffix rule must not match a lookalike registered elsewhere: the
  // leading dot is what makes it a subdomain test rather than a substring one.
  ["https://notmzstatic.com/poster.jpg", false],
  // Unconfigured hosts must not reach next/image — it hard-fails and blanks
  // the whole rail rather than the one card.
  ["https://example.com/poster.jpg", false],
  ["https://cdn.myanimelist.net/images/a.jpg", false],
  ["/local/poster.jpg", false],
  ["data:image/png;base64,AAAA", false],
  ["not a url", false],
  ["", false],
  [null, false],
];

for (const [url, expected] of IMAGE_CASES) {
  check(`isOptimizableImageUrl(${JSON.stringify(url)})`, () => {
    assert.equal(isOptimizableImageUrl(url), expected);
  });
}

const INITIAL_CASES: Array<[string, string]> = [
  ["Severance", "S"],
  ["  the bear", "T"],
  ["3 Body Problem", "3"],
  ["進撃の巨人", "進"],
  ["…Cowboy Bebop", "C"],
  ["!!!", "?"],
  ["", "?"],
  ["   ", "?"],
];

for (const [title, expected] of INITIAL_CASES) {
  check(`posterInitial(${JSON.stringify(title)})`, () => {
    assert.equal(posterInitial(title), expected);
  });
}

check("posterTint is stable per title and stays inside the token palette", () => {
  const seeds = ["Severance", "The Bear", "Frieren", "", "x", "Dune Part Two"];
  for (const seed of seeds) {
    const tint = posterTint(seed);
    assert.equal(posterTint(seed), tint, "same title must render the same tile");
    assert.ok(
      tint.includes("var(--"),
      `tint ${tint} used a raw colour instead of a token`,
    );
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(tint), "no raw hex in the palette");
  }
});

check("posterTint spreads titles across more than one tint", () => {
  const tints = new Set(
    ["Severance", "The Bear", "Frieren", "Dune", "Arcane", "Andor", "Shogun"].map(
      posterTint,
    ),
  );
  assert.ok(tints.size > 1, "every card would look identical");
});

// ---------------------------------------------------------------------------
// Rail scrolling and focus
// ---------------------------------------------------------------------------

console.log("browse-ui: rail scrolling…");

const EDGE_CASES: Array<{
  name: string;
  metrics: { scrollLeft: number; clientWidth: number; scrollWidth: number };
  atStart: boolean;
  atEnd: boolean;
  scrollable: boolean;
}> = [
  {
    name: "content fits — no arrows at all",
    metrics: { scrollLeft: 0, clientWidth: 800, scrollWidth: 800 },
    atStart: true,
    atEnd: true,
    scrollable: false,
  },
  {
    name: "one sub-pixel of overflow is not scrollable",
    metrics: { scrollLeft: 0, clientWidth: 800, scrollWidth: 801.4 },
    atStart: true,
    atEnd: true,
    scrollable: false,
  },
  {
    name: "at the start",
    metrics: { scrollLeft: 0, clientWidth: 800, scrollWidth: 2400 },
    atStart: true,
    atEnd: false,
    scrollable: true,
  },
  {
    name: "in the middle",
    metrics: { scrollLeft: 600, clientWidth: 800, scrollWidth: 2400 },
    atStart: false,
    atEnd: false,
    scrollable: true,
  },
  {
    name: "at the end",
    metrics: { scrollLeft: 1600, clientWidth: 800, scrollWidth: 2400 },
    atStart: false,
    atEnd: true,
    scrollable: true,
  },
  {
    name: "a fraction short of the end still counts as the end",
    metrics: { scrollLeft: 1598.7, clientWidth: 800, scrollWidth: 2400 },
    atStart: false,
    atEnd: true,
    scrollable: true,
  },
  {
    name: "momentum overscroll past the end",
    metrics: { scrollLeft: 1620, clientWidth: 800, scrollWidth: 2400 },
    atStart: false,
    atEnd: true,
    scrollable: true,
  },
  {
    name: "a fraction past the start still counts as the start",
    metrics: { scrollLeft: 1.5, clientWidth: 800, scrollWidth: 2400 },
    atStart: true,
    atEnd: false,
    scrollable: true,
  },
];

for (const c of EDGE_CASES) {
  check(`railEdges: ${c.name}`, () => {
    assert.deepEqual(railEdges(c.metrics), {
      atStart: c.atStart,
      atEnd: c.atEnd,
      scrollable: c.scrollable,
    });
  });
}

const DELTA_CASES: Array<[number, number]> = [
  [1200, 1020],
  [390, 332],
  // Never smaller than a card, or the arrow appears to do nothing.
  [100, 160],
  [0, 160],
];

for (const [width, expected] of DELTA_CASES) {
  check(`pageScrollDelta(${width})`, () => {
    assert.equal(pageScrollDelta(width), expected);
  });
}

const FOCUS_CASES: Array<{
  name: string;
  current: number;
  count: number;
  key: string;
  expect: number | null;
}> = [
  { name: "right moves on", current: 0, count: 5, key: "ArrowRight", expect: 1 },
  { name: "left moves back", current: 3, count: 5, key: "ArrowLeft", expect: 2 },
  // Clamping, not wrapping: wrapping scrolls the row a screen the wrong way.
  { name: "right clamps at the end", current: 4, count: 5, key: "ArrowRight", expect: 4 },
  { name: "left clamps at the start", current: 0, count: 5, key: "ArrowLeft", expect: 0 },
  { name: "Home jumps to first", current: 4, count: 5, key: "Home", expect: 0 },
  { name: "End jumps to last", current: 0, count: 5, key: "End", expect: 4 },
  { name: "single card stays put", current: 0, count: 1, key: "ArrowRight", expect: 0 },
  { name: "empty rail handles nothing", current: 0, count: 0, key: "End", expect: null },
  // Keys we do not own must fall through to the browser.
  { name: "ArrowDown is not ours", current: 1, count: 5, key: "ArrowDown", expect: null },
  { name: "Tab is not ours", current: 1, count: 5, key: "Tab", expect: null },
  { name: "Enter is not ours", current: 1, count: 5, key: "Enter", expect: null },
];

for (const c of FOCUS_CASES) {
  check(`nextFocusIndex: ${c.name}`, () => {
    assert.equal(nextFocusIndex(c.current, c.count, c.key), c.expect);
  });
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

console.log("browse-ui: hero…");

const CONTINUE = item({ id: "c1", title: "Continue" });
const READY = item({ id: "r1", title: "Ready", availability: "ready" });
const NEXT = item({ id: "n1", title: "Next" });
const LIBRARY = item({ id: "l1", title: "Library" });

const HERO_CASES: Array<{ name: string; rails: Rail[]; expect: string | null }> = [
  {
    name: "continue watching wins over everything",
    rails: [
      rail("recently-added", [LIBRARY]),
      rail("ready-to-play", [READY]),
      rail("continue-watching", [CONTINUE]),
    ],
    expect: "c1",
  },
  {
    name: "ready to play wins when nothing is in progress",
    rails: [rail("my-library", [LIBRARY]), rail("ready-to-play", [READY])],
    expect: "r1",
  },
  {
    name: "next up beats library",
    rails: [rail("my-library", [LIBRARY]), rail("next-up", [NEXT])],
    expect: "n1",
  },
  {
    name: "falls back to the first rail with anything in it",
    rails: [rail("my-library", []), rail("recently-added", [LIBRARY])],
    expect: "l1",
  },
  {
    name: "an empty priority rail is skipped, not featured",
    rails: [rail("continue-watching", []), rail("ready-to-play", [READY])],
    expect: "r1",
  },
  { name: "nothing at all — the new-install case", rails: [], expect: null },
  {
    name: "every rail empty — still nothing to feature",
    rails: [rail("continue-watching", []), rail("my-library", [])],
    expect: null,
  },
];

for (const c of HERO_CASES) {
  check(`pickHeroItem: ${c.name}`, () => {
    const pick = pickHeroItem(c.rails);
    assert.equal(pick?.item.id ?? null, c.expect);
    if (pick) assert.ok(pick.eyebrow.trim().length > 0, "hero needs a reason");
  });
}

check("heroPitch says something different, and honest, per state", () => {
  const pitches = new Map<string, string>();
  const rows: Array<[string, RailItem]> = [
    ["ready", item({ availability: "ready" })],
    ["ready+resume", item({ availability: "ready", resumePositionSec: 1104, progressFraction: 0.42 })],
    ["warm", item({ availability: "warm" })],
    ["warm+resume", item({ availability: "warm", resumePositionSec: 61, progressFraction: 0.1 })],
    ["fetchable", item({ availability: "fetchable" })],
    ["fetchable+ep", item({ availability: "fetchable", season: 1, episode: 2 })],
    ["unavailable", item({ availability: "unavailable" })],
    ["unavailable+monitored", item({ availability: "unavailable", watchListItemId: "w" })],
  ];
  for (const [name, row] of rows) {
    const pitch = heroPitch(row);
    // A complete sentence rather than a character count: the point is that
    // every state says something, not that it says a particular amount. A
    // terse-but-whole "Streaming now." is good copy; "n/a" is not.
    assert.ok(pitch.trim().split(/\s+/).length >= 2, `${name}: pitch too thin`);
    assert.ok(/[.!?]$/.test(pitch.trim()), `${name}: pitch is not a sentence`);
    pitches.set(name, pitch);
  }
  // A partially-watched hero must surface both where you stopped and how far
  // through you are. Asserted across pitch *and* facts together, because which
  // of the two carries a given fact is a copy decision — that the user can see
  // both is not.
  const heroCopy = (row: RailItem) =>
    [heroPitch(row), ...heroFacts(row)].join(" ");
  const readyResume = heroCopy(rows[1][1]);
  assert.ok(readyResume.includes("18:24"), "resume position not surfaced");
  assert.ok(readyResume.includes("42%"), "progress not surfaced");
  assert.ok(pitches.get("warm+resume")?.includes("1:01"));
  assert.notEqual(pitches.get("unavailable"), pitches.get("unavailable+monitored"));
});

/**
 * The unresolved state is deliberately excluded from the "every state gets a
 * sentence" rule above, and this is the test that pins the exception down.
 *
 * `availability: null` means our own probe has not come back yet. It is not a
 * fact about the film. It only ever appears on first paint, so the old copy —
 * "Not checked yet." — was seen as a *flash* that a second later was replaced
 * by "Resume from 1:03:13.", on a title the user was 42% through and which was
 * sitting complete on their disk. They asked for it to go.
 *
 * Silence is not the same as a shorter status line: an empty pitch renders no
 * prose at all, while any sentence here reads as a claim about availability
 * that we are about to contradict. So the assertion is emptiness, not brevity.
 */
check("heroPitch stays silent while availability is unresolved", () => {
  const unresolved = item({ availability: null });
  assert.equal(heroPitch(unresolved), "", "unresolved must render no prose");

  // Not merely absent — specifically never the probe-state copy, in any state.
  for (const state of ALL_STATES) {
    assert.ok(
      !/not checked/i.test(heroPitch(item({ availability: state }))),
      `${String(state)}: hero narrates the app's own probe queue`,
    );
  }

  // Silence is a fallback, not a blackout: a work with a synopsis still shows
  // it while unresolved, because the synopsis is a fact about the film and
  // does not depend on the probe at all.
  const synopsis = "A duke's heir is drawn into a war over the desert planet.";
  assert.equal(heroPitch(item({ availability: null, overview: synopsis })), synopsis);

  // And every resolved state still says something — the exception must not
  // leak into states that genuinely know their answer.
  for (const state of ALL_STATES.filter((s) => s !== null)) {
    assert.ok(
      heroPitch(item({ availability: state })).trim().length > 0,
      `${String(state)}: resolved state lost its copy`,
    );
  }
});

check("heroPitch: every resolved state has its own honest sentence", () => {
  const resolved = ALL_STATES.filter((s) => s !== null);
  const pitches = resolved.map((s) => heroPitch(item({ availability: s })));
  assert.equal(new Set(pitches).size, pitches.length, "two states read alike");
});

check("heroPitch prefers the work's synopsis over status copy", () => {
  const synopsis =
    "A young Kryptonian grapples with the weight of a world that is not hers.";
  const withOverview = heroPitch(item({ availability: "ready", overview: synopsis }));
  assert.equal(withOverview, synopsis, "the hero must lead with the synopsis");

  // Whitespace-only is not a synopsis; fall back rather than render a blank
  // paragraph where the description belongs.
  const blank = heroPitch(item({ availability: "ready", overview: "   " }));
  assert.equal(blank, heroPitch(item({ availability: "ready" })));
});

/**
 * The hero must describe the *work*, never the app's own plumbing.
 *
 * This is a direct instruction from the user, given three times. The copy this
 * guards against was real and shipped: "You stopped at 1:12:00 — 43% in. It is
 * downloaded in full, so it picks up instantly and seeks anywhere." and
 * "Nobody has searched the indexers for this yet — that costs a few seconds, so
 * browse does not do it for every title." Both explain the downloader in the
 * one place a catalogue is meant to be telling you about the film.
 *
 * Phrases, not a length cap: the failure mode is explanatory *voice*, and a
 * short sentence can still be an explanation.
 */
const MECHANICS_PHRASES = [
  /picks up (instantly|where)/i,
  /seeks anywhere/i,
  /one click/i,
  /costs a few seconds/i,
  /filling in from the swarm/i,
  /so it\b/i,
  /you stopped at/i,
  /automatically/i,
  /press play/i,
];

check("heroPitch never explains the app's mechanics back at the user", () => {
  const rows: RailItem[] = [
    ...ALL_STATES.map((s) => item({ availability: s })),
    item({ availability: "ready", resumePositionSec: 1104, progressFraction: 0.42 }),
    item({ availability: "warm", resumePositionSec: 61, progressFraction: 0.1 }),
    item({ availability: "fetchable", season: 1, episode: 2 }),
    item({ availability: "unavailable", watchListItemId: "w" }),
  ];
  for (const row of rows) {
    const pitch = heroPitch(row);
    for (const phrase of MECHANICS_PHRASES) {
      assert.ok(
        !phrase.test(pitch),
        `pitch explains mechanics (${phrase}): ${JSON.stringify(pitch)}`,
      );
    }
    // A status fallback is a label, not a paragraph. The synopsis is exempt:
    // it is the film's own description and is supposed to be prose.
    assert.ok(
      pitch.split(/\s+/).length <= 7,
      `status pitch is a paragraph: ${JSON.stringify(pitch)}`,
    );
  }
});

const FACTS_CASES: Array<{ name: string; input: RailItem; expect: string[] }> = [
  {
    name: "episode marker and progress",
    input: item({ subtitle: "S02E07", progressFraction: 0.42 }),
    expect: ["S02E07", "42% watched"],
  },
  {
    name: "no subtitle — no empty separator",
    input: item({ progressFraction: 0.05 }),
    expect: ["5% watched"],
  },
  {
    name: "unstarted item has no progress fact",
    input: item({ subtitle: "S01E01", progressFraction: 0 }),
    expect: ["S01E01"],
  },
  {
    name: "finished item does not advertise 100% watched",
    input: item({ subtitle: "S01E01", progressFraction: 1 }),
    expect: ["S01E01"],
  },
  { name: "nothing to say", input: item(), expect: [] },
];

for (const c of FACTS_CASES) {
  check(`heroFacts: ${c.name}`, () => {
    assert.deepEqual(heroFacts(c.input), c.expect);
  });
}

// ---------------------------------------------------------------------------
// First-run and partially-empty rails
// ---------------------------------------------------------------------------

console.log("browse-ui: first run…");

/**
 * The rail ids the data layer actually emits, in the order it emits them.
 * Duplicated here on purpose: this is the assertion. A rail renamed in
 * `src/lib/browse/rails.ts` and not here would otherwise ship a first-run page
 * describing rails that no longer exist, and a "not showing yet" note that can
 * never be satisfied.
 */
const DATA_LAYER_RAIL_IDS = [
  "continue-watching",
  "ready-to-play",
  "next-up",
  "my-library",
  "recently-added",
] as const;

check("first-run previews cover every rail the data layer emits, in order", () => {
  assert.deepEqual(RAIL_PREVIEWS.map((p) => p.id), [...DATA_LAYER_RAIL_IDS]);
});

check("every first-run preview has copy and a real destination", () => {
  for (const preview of RAIL_PREVIEWS) {
    assert.ok(preview.title.length > 0, `${preview.id} has no title`);
    assert.ok(preview.blurb.length > 20, `${preview.id} blurb is not a sentence`);
    assert.ok(preview.cta.length > 0, `${preview.id} has no call to action`);
    // Never a dead link, and never a page invented for the empty state.
    assert.ok(
      preview.href.startsWith("/"),
      `${preview.id} points somewhere that is not a route`,
    );
  }
});

function railOf(id: string, count: number): { id: string; items: unknown[] } {
  return { id, items: Array.from({ length: count }, (_, i) => i) };
}

const MISSING_CASES: Array<{
  name: string;
  rails: Array<{ id: string; items: unknown[] }>;
  expect: string[];
}> = [
  {
    name: "nothing at all — every rail is missing",
    rails: [],
    expect: [...DATA_LAYER_RAIL_IDS],
  },
  {
    name: "a rail present but empty counts as missing, not as present",
    rails: DATA_LAYER_RAIL_IDS.map((id) => railOf(id, 0)),
    expect: [...DATA_LAYER_RAIL_IDS],
  },
  {
    name: "one populated rail",
    rails: [railOf("ready-to-play", 3)],
    expect: ["continue-watching", "next-up", "my-library", "recently-added"],
  },
  {
    name: "populated and empty side by side",
    rails: [
      railOf("continue-watching", 2),
      railOf("next-up", 0),
      railOf("my-library", 7),
    ],
    expect: ["ready-to-play", "next-up", "recently-added"],
  },
  {
    name: "everything populated — nothing to say",
    rails: DATA_LAYER_RAIL_IDS.map((id) => railOf(id, 1)),
    expect: [],
  },
  {
    name: "an unknown rail id is not reported as missing",
    rails: [railOf("some-future-rail", 4)],
    expect: [...DATA_LAYER_RAIL_IDS],
  },
];

for (const c of MISSING_CASES) {
  check(`missingRailPreviews: ${c.name}`, () => {
    assert.deepEqual(missingRailPreviews(c.rails).map((p) => p.id), c.expect);
  });
}

check("missingRailPreviews always answers in canonical order", () => {
  // Payload order must not leak into the note, or the same install reads
  // differently on two loads.
  const shuffled = [railOf("recently-added", 1), railOf("continue-watching", 1)];
  assert.deepEqual(missingRailPreviews(shuffled).map((p) => p.id), [
    "ready-to-play",
    "next-up",
    "my-library",
  ]);
});

const FIRST_RUN_CASES: Array<{
  name: string;
  rails: Array<{ id: string; items: unknown[] }>;
  expect: boolean;
}> = [
  { name: "no rails", rails: [], expect: true },
  { name: "rails that are all empty", rails: [railOf("next-up", 0)], expect: true },
  {
    name: "one item anywhere",
    rails: [railOf("next-up", 0), railOf("my-library", 1)],
    expect: false,
  },
  {
    name: "a full page",
    rails: DATA_LAYER_RAIL_IDS.map((id) => railOf(id, 6)),
    expect: false,
  },
];

for (const c of FIRST_RUN_CASES) {
  check(`isFirstRun: ${c.name}`, () => {
    assert.equal(isFirstRun(c.rails), c.expect);
  });
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} browse-ui test(s) failed.`);
  process.exit(1);
}
console.log("\nAll browse-ui tests passed.");
