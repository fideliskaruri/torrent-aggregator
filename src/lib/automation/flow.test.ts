/**
 * Package flow invariants (single path, no duplicate “what downloaded” story).
 *
 * Expected user journey:
 *   1. Library  — what I want (monitor / request / watch)
 *   2. Automation — Run automation (button + optional API) hunts monitored titles
 *   3. Activity — what happened (GrabJobs, failures, savePath)
 *   4. Client   — live engine state only
 *   5. History  — thin “download log” subset of past sends (not a peer of Activity)
 *
 * Path rule class for monitored-style TV/anime releases (general, not one-show):
 *   {base}/{Category}/{Show}/Season {NN}/  when a single season is known
 *   {base}/{Category}/{Show}/              absolute-ep only or multi-season packs
 *
 * This test exercises the same resolveSmartPath used by send / automation / rules
 * (via smart-target) so Library automation layout matches manual send.
 *
 * Run: npx tsx src/lib/automation/flow.test.ts
 */
import assert from "node:assert/strict";
import {
  resolveSmartPath,
  detectContentKind,
  showFolderName,
  seasonFolderSegment,
} from "@/lib/download/smart-category";
import { resolveSmartSendTarget } from "@/lib/download/smart-target";
import { parseEpisode } from "@/lib/torrents/episodes";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import {
  DESKTOP_NAV,
  DESKTOP_NAV_DIVIDER_INDEX,
  EVERYTHING_HREF,
  HEADER_SEARCH_HREF,
  HISTORY_HREF,
  MORE_ACTIVE_PREFIXES,
  PRIMARY_NAV,
  SEARCH_HREF,
  SECONDARY_NAV,
  desktopNavRow,
  navActive,
  navActiveHref,
} from "@/lib/navigation";
import type { NavItem } from "@/lib/navigation";

const BASE = "/downloads";
const CATS = ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seasonSegs(path: string): string[] {
  return path.split(/[/\\]/).filter((p) => /^Season \d{2}$/i.test(p));
}

function assertSeasonLayout(
  path: string,
  opts: { show: string | RegExp; season: number; category: string },
) {
  const parts = path.split(/[/\\]/);
  assert.ok(
    parts.some((p) => p.toLowerCase() === opts.category.toLowerCase()),
    `expected category ${opts.category} in ${path}`,
  );
  const showHit =
    typeof opts.show === "string"
      ? parts.some((p) => p.toLowerCase() === opts.show.toString().toLowerCase())
      : parts.some((p) => (opts.show as RegExp).test(p));
  assert.ok(showHit, `expected show ${opts.show} in ${path}`);
  const segs = seasonSegs(path);
  assert.equal(segs.length, 1, `exactly one Season folder in ${path}`);
  const n = Number(segs[0].replace(/Season\s*/i, ""));
  assert.equal(n, opts.season, `Season ${opts.season} in ${path}`);
}

// ---------------------------------------------------------------------------
// 1. Monitored-style titles → Season layout (rule class matrix)
// ---------------------------------------------------------------------------

type MonitoredCase = {
  name: string;
  title: string;
  kind: "tv" | "anime";
  show: string | RegExp;
  season: number;
};

const MONITORED_STYLE: MonitoredCase[] = [
  {
    name: "western TV SxxEyy",
    title: "Family Guy S15E03 The Boys in the Band 1080p WEB-DL",
    kind: "tv",
    show: /family guy/i,
    season: 15,
  },
  {
    name: "another western series",
    title: "Breaking Bad S05E14 Ozymandias 1080p BluRay",
    kind: "tv",
    show: /breaking bad/i,
    season: 5,
  },
  {
    name: "anime with SxxEyy",
    title: "[SubsPlease] Frieren - S01E16 (1080p) [ABC123].mkv",
    kind: "anime",
    show: /frieren/i,
    season: 1,
  },
  {
    name: "long-running anime Sxx",
    title: "One Piece S23E10 1080p WEB-DL",
    kind: "anime",
    show: /one piece/i,
    season: 23,
  },
  {
    name: "site prefix must not become show folder",
    title: "www.UIndex.org - The Simpsons S37E16 Extreme Makeover 720p",
    kind: "tv",
    show: /simpsons/i,
    season: 37,
  },
];

console.log("flow: monitored-style Season layout…");
for (const c of MONITORED_STYLE) {
  const cat = c.kind === "anime" ? "Anime" : "TV";
  const path = resolveSmartPath(BASE, c.kind, cat, { title: c.title });
  assertSeasonLayout(path, {
    show: c.show,
    season: c.season,
    category: cat,
  });
  // Stable show folder — never the episode subtitle
  const show = showFolderName(c.title);
  assert.ok(show.length > 0, "show folder non-empty");
  assert.ok(
    !/extreme makeover/i.test(show),
    `show folder must not be episode subtitle: ${show}`,
  );
  console.log(`  ✓ ${c.name} → ${path}`);
}

// ---------------------------------------------------------------------------
// 2. Absolute-ep-only (no season) stays at show root — still one package path
// ---------------------------------------------------------------------------

console.log("flow: absolute-ep anime under show root…");
{
  const title = "[SubsPlease] One Piece - 1170 (1080p) [DEADBEEF].mkv";
  const path = resolveSmartPath(BASE, "anime", "Anime", { title });
  assert.equal(seasonSegs(path).length, 0, `no Season when unknown: ${path}`);
  assert.match(path, /One Piece/i);
  const ep = parseEpisode(title);
  assert.equal(seasonFolderSegment(ep), null);
  console.log(`  ✓ ${path}`);
}

// ---------------------------------------------------------------------------
// 3. smart-target (send/automation shared) matches resolveSmartPath Season layout
// ---------------------------------------------------------------------------

console.log("flow: resolveSmartSendTarget Season layout…");
{
  const config: ClientConnectionConfig = {
    clientType: "builtin",
    host: "",
    username: "",
    password: "",
    baseDownloadPath: BASE,
    categories: CATS,
    pathRules: {},
  };
  const title = "Severance S02E03 1080p WEB-DL";
  const target = resolveSmartSendTarget(config, {
    name: title,
    tags: [],
    source: "apibay",
    searchCategory: "tv",
  });
  assert.ok(target.savePath, "savePath resolved");
  assertSeasonLayout(target.savePath!, {
    show: /severance/i,
    season: 2,
    category: "TV",
  });
  // Kind detection for monitored TV-ish titles
  const kind = detectContentKind({
    title,
    tags: [],
    searchCategory: "tv",
  });
  assert.equal(kind, "tv");
  console.log(`  ✓ ${target.savePath} (category=${target.category})`);
}

// ---------------------------------------------------------------------------
// 4. Navigation model contracts
// ---------------------------------------------------------------------------

console.log("flow: navigation model contracts…");
{
  /**
   * These assert against the real exported navigation model, so they fail if
   * someone changes the nav. An earlier version declared its own local copy of
   * the model and asserted against that, which could never fail.
   */
  const primaryHrefs = PRIMARY_NAV.map((i) => i.href);
  const secondaryHrefs = SECONDARY_NAV.map((i) => i.href);
  const desktopHrefs = DESKTOP_NAV.map((i) => i.href);

  assert.deepEqual(
    primaryHrefs,
    ["/", SEARCH_HREF, "/watchlist", "/client"],
    "primary path is Browse → Search → Library → Client",
  );

  assert.equal(
    primaryHrefs.includes(EVERYTHING_HREF),
    false,
    "Everything is compatibility-only and must not return to primary navigation",
  );

  // `/` is the catalog now, not the search box. Search is a peer route, and it
  // must stay a real nav entry so the mobile tab bar and the active-route
  // logic read from one model even though the desktop header draws it as a box.
  assert.equal(
    PRIMARY_NAV[0]?.label,
    "Browse",
    "`/` is labelled Browse: it answers 'here is what you can watch'",
  );
  assert.equal(
    HEADER_SEARCH_HREF,
    SEARCH_HREF,
    "the header's search affordance points at the search route",
  );
  assert.ok(
    PRIMARY_NAV.some((i: NavItem) => i.href === HEADER_SEARCH_HREF),
    "the header search affordance must correspond to a real nav entry",
  );

  assert.ok(
    !primaryHrefs.includes(HISTORY_HREF),
    "History is the download log, not a primary peer",
  );
  assert.ok(
    !secondaryHrefs.includes(HISTORY_HREF),
    "History is reached from Activity, not the More sheet",
  );
  assert.ok(
    !desktopHrefs.includes(HISTORY_HREF),
    "History is not in the desktop header",
  );

  // Desktop must start with the same primary path as mobile, so the two never
  // drift apart again.
  assert.deepEqual(
    desktopHrefs.slice(0, PRIMARY_NAV.length),
    primaryHrefs,
    "desktop header leads with the primary path",
  );
  assert.equal(
    DESKTOP_NAV_DIVIDER_INDEX,
    PRIMARY_NAV.length,
    "the divider sits between primary and secondary",
  );

  /**
   * The header renders Search as a search box on the right, so it is pulled
   * out of the text row — which shifts every later index by one. The divider
   * position is therefore computed, not a constant the header corrects by hand.
   */
  {
    const { items: rowItems, dividerIndex } = desktopNavRow();
    const rowHrefs = rowItems.map((i: NavItem) => i.href);
    assert.ok(
      !rowHrefs.includes(HEADER_SEARCH_HREF),
      "the search entry is drawn as a box, not repeated as a text link",
    );
    assert.deepEqual(
      rowHrefs,
      desktopHrefs.filter((h) => h !== HEADER_SEARCH_HREF),
      "the row is the desktop nav minus the search entry, in order",
    );
    // The divider must still land exactly where primary ends.
    const primaryInRow = primaryHrefs.filter((h) => h !== HEADER_SEARCH_HREF);
    assert.equal(
      dividerIndex,
      primaryInRow.length,
      "the divider still separates the primary path from secondary pages",
    );
    assert.deepEqual(
      rowHrefs.slice(0, dividerIndex),
      primaryInRow,
      "everything before the divider is primary",
    );
    for (const href of rowHrefs.slice(dividerIndex)) {
      assert.ok(
        secondaryHrefs.includes(href),
        `everything after the divider is secondary — ${href} is not`,
      );
    }
  }

  // Every desktop entry beyond the primary path must be a real secondary page.
  for (const href of desktopHrefs.slice(PRIMARY_NAV.length)) {
    assert.ok(
      secondaryHrefs.includes(href),
      `desktop entry ${href} must exist in the secondary nav`,
    );
  }

  // No duplicates anywhere, and no page in both tiers.
  const allHrefs = [...primaryHrefs, ...secondaryHrefs];
  assert.equal(
    new Set(allHrefs).size,
    allHrefs.length,
    "a page belongs to exactly one nav tier",
  );

  // The More tab must light up for every secondary route, plus History.
  for (const href of [...secondaryHrefs, HISTORY_HREF]) {
    assert.ok(
      MORE_ACTIVE_PREFIXES.includes(href),
      `${href} must light the More tab`,
    );
  }

  /**
   * Exactly one row highlighted, on every route, in every rendered list.
   *
   * `owns` claims are allowed to overlap a real entry — Settings stands in for
   * `/rules` in the desktop header, while the More sheet lists `/rules`
   * itself — so this is the invariant that keeps that from double-highlighting.
   */
  {
    // `/search` is a real page now — the search experience moved off `/`, so
    // the nav renders on it and must highlight the Search entry.
    const allRoutes = [
      "/",
      SEARCH_HREF,
      "/watchlist",
      "/client",
      "/activity",
      "/settings",
      "/rules",
      "/history",
      "/about",
    ];

    // The desktop header is always on screen, so it must always show where
    // the user is.
    for (const route of allRoutes) {
      const winner = navActiveHref(DESKTOP_NAV, route);
      assert.ok(
        winner,
        `desktop header: nothing highlighted on ${route} — the user loses their place`,
      );
      assert.equal(
        DESKTOP_NAV.filter((item: NavItem) => item.href === winner).length,
        1,
        `desktop header: ${route} resolved to a non-unique entry`,
      );
    }

    // The More sheet only covers secondary routes; on a primary route it
    // correctly highlights nothing.
    for (const route of [...secondaryHrefs, HISTORY_HREF]) {
      const winner = navActiveHref(SECONDARY_NAV, route);
      assert.ok(winner, `More sheet: nothing highlighted on ${route}`);
      assert.equal(
        SECONDARY_NAV.filter((item: NavItem) => item.href === winner).length,
        1,
        `More sheet: ${route} resolved to a non-unique entry`,
      );
    }
    for (const route of primaryHrefs) {
      assert.equal(
        navActiveHref(SECONDARY_NAV, route),
        null,
        `More sheet must stay unhighlighted on the primary route ${route}`,
      );
    }

    // A page that is in the list must win over any entry merely claiming it.
    assert.equal(
      navActiveHref(SECONDARY_NAV, "/rules"),
      "/rules",
      "the More sheet lists Rules, so Rules wins over Settings' claim",
    );
    assert.equal(
      navActiveHref(DESKTOP_NAV, "/rules"),
      "/rules",
      "Rules is discoverable and owns its desktop route",
    );
    assert.equal(
      navActiveHref(DESKTOP_NAV, "/history"),
      "/activity",
      "History is reached from Activity",
    );
    assert.equal(
      navActiveHref(DESKTOP_NAV, SEARCH_HREF),
      SEARCH_HREF,
      "Search owns its own route now",
    );
    assert.equal(
      navActiveHref(DESKTOP_NAV, `${SEARCH_HREF}?q=dune`),
      null,
      "navActive matches paths, not query strings — callers must pass pathname",
    );
    // A nested route lights its parent, not the root.
    assert.equal(navActiveHref(DESKTOP_NAV, "/watchlist/42"), "/watchlist");
  }

  // Sign-in was removed: no nav entry may point at a login route.
  assert.ok(
    !allHrefs.some((h) => /login|signin|sign-in|auth/i.test(h)),
    "no sign-in entry remains in the nav",
  );

  // navActive must not treat "/" as a prefix of everything.
  assert.equal(navActive("/", "/"), true);
  assert.equal(navActive("/watchlist", "/"), false, "/ is exact-match only");
  assert.equal(navActive("/watchlist", "/watchlist"), true);
  assert.equal(navActive("/watchlist/123", "/watchlist"), true, "child routes");
  assert.equal(
    navActive("/watchlist-archive", "/watchlist"),
    false,
    "a sibling sharing a prefix is not active",
  );

  console.log("  ✓ nav model contracts");
}

console.log("\nAll package-flow tests passed.");
