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
// 4. Documentation assertions — navigation model contracts (static)
// ---------------------------------------------------------------------------

console.log("flow: package path roles (documented contracts)…");
{
  /**
   * These strings document the intended page roles. If someone reintroduces
   * a competing History peer in primary nav, update the product rule first.
   */
  const NAV_MODEL = {
    primary: ["Search", "Library", "Client"] as const,
    secondary: ["Activity", "Rules", "Settings", "About"] as const,
    /** History is not a More peer — linked from Activity as download log */
    historyRole: "download-log-subset",
    automationUi: "library-only", // no second Run automation on Client/Settings
  };
  assert.ok(NAV_MODEL.primary.includes("Library"));
  assert.ok(NAV_MODEL.secondary.includes("Activity"));
  assert.ok(!NAV_MODEL.primary.includes("History" as never));
  assert.equal(NAV_MODEL.historyRole, "download-log-subset");
  assert.equal(NAV_MODEL.automationUi, "library-only");
  console.log("  ✓ nav model contracts");
}

console.log("\nAll package-flow tests passed.");
