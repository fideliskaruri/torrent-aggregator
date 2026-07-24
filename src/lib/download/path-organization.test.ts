/**
 * Path organization invariants — multi-show matrix + optional live API.
 *
 * Rule class (NOT one-show patches):
 *   {base}/{Category}/{Show}/Season {NN}/  when season known
 *   {base}/{Category}/{Show}/              absolute-ep only / multi-season packs
 *
 * Run: npx tsx src/lib/download/path-organization.test.ts
 */
import assert from "node:assert/strict";
import {
  detectContentKind,
  resolveSmartPath,
  showFolderName,
  smartCategorize,
  seasonFolderSegment,
} from "./smart-category";
import { parseEpisode } from "@/lib/torrents/episodes";
import { attachDownloadRoutes } from "./attach-route";
import type { TorrentResult } from "@/lib/torrents/types";

const CATS = ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];
const BASE = "/downloads";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathFor(
  title: string,
  kind: "tv" | "anime" | "movies" | "software",
  category?: string,
): string {
  const cat =
    category ??
    (kind === "tv"
      ? "TV"
      : kind === "anime"
        ? "Anime"
        : kind === "movies"
          ? "Movies"
          : "Software");
  return resolveSmartPath(BASE, kind, cat, { title });
}

function seasonSegmentsIn(path: string): string[] {
  return path.split(/[/\\]/).filter((p) => /^Season \d{2}$/i.test(p));
}

function showSegment(path: string, category: string): string | null {
  const parts = path.split(/[/\\]/);
  const i = parts.findIndex((p) => p.toLowerCase() === category.toLowerCase());
  if (i < 0 || i + 1 >= parts.length) return null;
  const next = parts[i + 1];
  if (/^Season \d{2}$/i.test(next)) return null;
  return next;
}

// ---------------------------------------------------------------------------
// 1. Table-driven unit matrix (≥12 cases covering every invariant)
// ---------------------------------------------------------------------------

type MatrixCase = {
  name: string;
  title: string;
  kind: "tv" | "anime" | "movies" | "software";
  /** Expected show folder (case-insensitive match) */
  show: string | RegExp;
  /** Expected padded season number, or null if no Season folder */
  season: number | null;
  /** If set, detectContentKind must return this */
  detectKind?: "tv" | "anime" | "software" | "movies" | "games";
  /** Title must not produce these substrings in the show folder */
  forbidInShow?: RegExp;
};

const MATRIX: MatrixCase[] = [
  // --- Invariant 2: Season when known (western TV) ---
  {
    name: "Family Guy S15E03 → Season 15",
    title: "Family Guy S15E03 1080p WEB-DL",
    kind: "tv",
    show: /^Family Guy$/i,
    season: 15,
  },
  {
    name: "Family Guy S24E11 Tall Stewie → Season 24 (user path leaf)",
    title: "Family Guy S24E11 Tall Stewie 1080p DSNP WEB-DL DD 5.1 H.264-playWEB",
    kind: "tv",
    show: /^Family Guy$/i,
    season: 24,
    forbidInShow: /tall|stewie|playweb|1080p|dsnp/i,
  },
  {
    name: "Family.Guy dotted S24E11 → Family Guy/Season 24",
    title: "Family.Guy.S24E11.1080p.WEB.h264-playWEB",
    kind: "tv",
    show: /^Family Guy$/i,
    season: 24,
    forbidInShow: /1080p|playweb|web|h264/i,
  },
  {
    name: "The Simpsons S32E10 → Season 32",
    title: "The Simpsons S32E10 720p HDTV",
    kind: "tv",
    show: /^The Simpsons$/i,
    season: 32,
  },
  {
    name: "The.Simpsons dotted S32E10 → The Simpsons",
    title: "The.Simpsons.S32E10.720p.HDTV.x264-GROUP",
    kind: "tv",
    show: /^The Simpsons$/i,
    season: 32,
    forbidInShow: /720p|hdtv|group/i,
  },
  {
    name: "Breaking Bad S05E14 → Season 05",
    title: "Breaking Bad S05E14 1080p BluRay x264",
    kind: "tv",
    show: /^Breaking Bad$/i,
    season: 5,
  },
  {
    name: "Firefly 1x03 → Season 01",
    title: "Firefly 1x03 1080p",
    kind: "tv",
    show: /^Firefly$/i,
    season: 1,
  },
  {
    name: "single-season pack → Season folder",
    title: "Breaking Bad Season 1 Complete 1080p",
    kind: "tv",
    show: /^Breaking Bad$/i,
    season: 1,
    forbidInShow: /complete|1080p|season/i,
  },

  // --- Invariant 2: Season when known (anime) ---
  {
    name: "One Piece S23E01 → Anime/One Piece/Season 23",
    title: "One Piece S23E01 1080p",
    kind: "anime",
    show: /^One Piece$/i,
    season: 23,
  },
  {
    name: "One Piece EP1233 S23 hybrid → Season 23",
    title: "One Piece EP1233 S23 1080p",
    kind: "anime",
    show: /^One Piece$/i,
    season: 23,
  },
  {
    name: "One.Piece.EP1170 dotted absolute → show root",
    title: "One.Piece.EP1170.1080p.WEB",
    kind: "anime",
    show: /^One Piece$/i,
    season: null,
    forbidInShow: /1170|1080p|web|ep/i,
  },
  {
    name: "3-digit season S023E05 → Season 23",
    title: "[SubsPlease] One Piece S023E05 (1080p)",
    kind: "anime",
    show: /^One Piece$/i,
    season: 23,
  },

  // --- Absolute-only anime: show root, no Season ---
  {
    name: "SubsPlease absolute ep → show root (no Season)",
    title: "[SubsPlease] One Piece - 1170 (1080p) [A5F746F4].mkv",
    kind: "anime",
    show: /^One Piece$/i,
    season: null,
    forbidInShow: /1170|subsplease|mkv|1080p/i,
  },
  {
    name: "bare absolute ep no season → show root",
    title: "One Piece EP1170 AAC2.0",
    kind: "anime",
    show: /^One Piece$/i,
    season: null,
    forbidInShow: /1170|aac/i,
  },

  // --- Invariant 3: multi-season packs → show root only ---
  {
    name: "Severance S01-S02 pack → no Season folder",
    title: "Severance S01-S02 Complete 1080p BluRay",
    kind: "tv",
    show: /^Severance$/i,
    season: null,
    forbidInShow: /complete|s01|1080p|bluray/i,
  },
  {
    name: "Game of Thrones S01-S08 → show root",
    title: "Game of Thrones S01-S08 Complete 1080p",
    kind: "tv",
    show: /^Game of Thrones$/i,
    season: null,
    forbidInShow: /complete/i,
  },
  {
    name: "Seasons 1-3 wording → show root",
    title: "Lost Seasons 1-3 720p BluRay",
    kind: "tv",
    show: /^Lost$/i,
    season: null,
  },
  {
    name: "Season 1 2 3 list (no dashes) → show root",
    title: "The Simpsons Season 1 2 3 4 5 6 7 8 9 + Shorts",
    kind: "tv",
    show: /^The Simpsons$/i,
    season: null,
  },
  {
    name: "episode subtitle must not become show folder",
    title: "The Simpsons S37E16 Extreme Makeover Homer Edition 1080p",
    kind: "tv",
    show: /^The Simpsons$/i,
    season: 37,
    forbidInShow: /extreme|makeover|homer|edition|1080p/i,
  },

  // --- Invariant 4: no junk/site folders ---
  {
    name: "www.UIndex.org prefix → clean show, not UIndex",
    title: "www.UIndex.org - ONE PIECE 2023 S01E01 1080p",
    kind: "anime",
    show: /^One Piece$/i,
    season: 1,
    forbidInShow: /uindex|www\.|\.org|\.com|1080p/i,
  },
  {
    name: "site prefix on western show",
    title: "www.UIndex.org - Family Guy S15E03 1080p",
    kind: "tv",
    show: /^Family Guy$/i,
    season: 15,
    forbidInShow: /uindex|www\.|\.org/i,
  },

  // --- Invariant 1: stable show identity across releases ---
  // (checked in multi-release block below; still list diverse titles)

  // --- Invariant 5: software → Software, not Movies ---
  {
    name: "Adobe Photoshop → Software category root",
    title: "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)",
    kind: "software",
    show: /.*/, // software does not nest product name
    season: null,
    detectKind: "software",
  },
  {
    name: "WinRAR keygen → Software",
    title: "WinRAR 7.01 Final Multilingual + Keygen",
    kind: "software",
    show: /.*/,
    season: null,
    detectKind: "software",
  },
];

let failed = 0;
const failures: string[] = [];

function fail(msg: string) {
  failed++;
  failures.push(msg);
  console.error("FAIL:", msg);
}

console.log("=== Unit matrix (%d cases) ===", MATRIX.length);
assert.ok(MATRIX.length >= 12, "matrix must have ≥12 cases");

for (const c of MATRIX) {
  const show = showFolderName(c.title);
  const path = pathFor(c.title, c.kind);
  const ep = parseEpisode(c.title);
  const seasons = seasonSegmentsIn(path);

  // Show name
  if (c.kind !== "software") {
    const showOk =
      typeof c.show === "string"
        ? show.toLowerCase() === c.show.toLowerCase()
        : c.show.test(show);
    if (!showOk) {
      fail(`${c.name}: showFolderName="${show}" expected ${c.show}`);
    }
    if (c.forbidInShow && c.forbidInShow.test(show)) {
      fail(`${c.name}: junk in show folder "${show}" matched ${c.forbidInShow}`);
    }
    // Invariant 4 hard checks
    if (/^www\./i.test(show) || /\.(org|com)$/i.test(show)) {
      fail(`${c.name}: show looks like a site domain: "${show}"`);
    }
  }

  // Season segment
  if (c.season == null) {
    if (seasons.length !== 0) {
      fail(`${c.name}: expected no Season folder, got ${seasons.join(",")} in ${path}`);
    }
  } else {
    const expected = `Season ${String(c.season).padStart(2, "0")}`;
    if (seasons.length !== 1 || seasons[0] !== expected) {
      fail(
        `${c.name}: expected exactly "${expected}", got [${seasons.join(",")}] in ${path}`,
      );
    }
    // Must nest under show
    if (c.kind !== "software" && !path.includes(show) && show) {
      fail(`${c.name}: path "${path}" missing show segment "${show}"`);
    }
  }

  // parseEpisode / seasonFolderSegment consistency
  const seg = seasonFolderSegment(ep);
  if (c.season == null) {
    if (seg != null && ep.isMultiSeason !== true && ep.season != null) {
      // multi-season must null; absolute-only must null
      if (ep.isMultiSeason || ep.season == null) {
        /* ok */
      }
    }
    if (ep.isMultiSeason && seg != null) {
      fail(`${c.name}: multi-season must not yield seasonFolderSegment, got ${seg}`);
    }
  } else if (seg !== `Season ${String(c.season).padStart(2, "0")}`) {
    fail(
      `${c.name}: seasonFolderSegment="${seg}" expected Season ${String(c.season).padStart(2, "0")}`,
    );
  }

  // detectKind when requested
  if (c.detectKind) {
    const kind = detectContentKind({
      title: c.title,
      searchCategory: c.detectKind === "software" ? "movies" : undefined,
    });
    if (kind !== c.detectKind) {
      fail(`${c.name}: detectContentKind=${kind} expected ${c.detectKind}`);
    }
    if (c.detectKind === "software") {
      const smart = smartCategorize({ title: c.title }, CATS, "movies");
      if (smart.category !== "Software") {
        fail(`${c.name}: category=${smart.category} expected Software`);
      }
      // Software path is category root only
      if (path !== `${BASE}/Software`) {
        fail(`${c.name}: software path should be category root, got ${path}`);
      }
    }
  }

  // Invariant: last path segment is never the full raw release title
  if (c.kind !== "software") {
    const last = path.split(/[/\\]/).filter(Boolean).pop() || "";
    const rawNorm = c.title.toLowerCase().replace(/[._]+/g, " ").trim();
    const lastNorm = last.toLowerCase().replace(/[._]+/g, " ").trim();
    if (last && lastNorm === rawNorm) {
      fail(
        `${c.name}: last path segment equals full raw release "${last}" — client would nest under junk title`,
      );
    }
    // Scene-style full release must never be the leaf folder
    if (
      last.includes(".") &&
      /\bS\d{1,3}E\d{1,4}\b/i.test(last.replace(/[._]+/g, " "))
    ) {
      fail(
        `${c.name}: leaf looks like release slug "${last}" — expected Show or Season NN`,
      );
    }
    // Path leaf should be Season NN or clean show name
    if (c.season != null) {
      if (last !== `Season ${String(c.season).padStart(2, "0")}`) {
        fail(`${c.name}: expected leaf Season folder, got last="${last}" path=${path}`);
      }
    } else if (c.kind === "tv" || c.kind === "anime") {
      const showOk =
        typeof c.show === "string"
          ? last.toLowerCase() === c.show.toLowerCase()
          : c.show.test(last);
      if (!showOk) {
        fail(`${c.name}: expected leaf show folder matching ${c.show}, got "${last}"`);
      }
    }
  }

  if (!failures.some((f) => f.startsWith(c.name))) {
    console.log("  ok:", c.name, "→", path);
  }
}

// ---------------------------------------------------------------------------
// Client leaf = savepath only (no extra release-name segment in path math)
// Windows-style: D:\Torrents\TV\Family Guy\Season 24
// ---------------------------------------------------------------------------
console.log("\n=== Savepath leaf is Category/Show/Season (not release name) ===");
{
  const winCases: { title: string; kind: "tv" | "anime"; expectEnds: string }[] = [
    {
      title: "Family Guy S24E11 Tall Stewie 1080p DSNP WEB-DL",
      kind: "tv",
      expectEnds: "TV\\Family Guy\\Season 24",
    },
    {
      title: "Family.Guy.S24E11.1080p.WEB.h264-playWEB",
      kind: "tv",
      expectEnds: "TV\\Family Guy\\Season 24",
    },
    {
      title: "The Simpsons S32E10 720p HDTV",
      kind: "tv",
      expectEnds: "TV\\The Simpsons\\Season 32",
    },
    {
      title: "One Piece S23E01 1080p",
      kind: "anime",
      expectEnds: "Anime\\One Piece\\Season 23",
    },
    {
      title: "One.Piece.EP1170.1080p",
      kind: "anime",
      expectEnds: "Anime\\One Piece",
    },
  ];
  for (const c of winCases) {
    const cat = c.kind === "anime" ? "Anime" : "TV";
    const p = resolveSmartPath("D:\\Torrents", c.kind, cat, {
      title: c.title,
      separator: "\\",
    });
    if (!p.endsWith(c.expectEnds)) {
      fail(`win path for "${c.title}": got "${p}", expected endsWith ${c.expectEnds}`);
    } else if (p.split("\\").pop() === c.title) {
      fail(`win path leaf must not be raw title: ${p}`);
    } else {
      console.log("  ok:", c.title.slice(0, 42), "→", p);
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant 1: stable show identity across diverse releases of same show
// ---------------------------------------------------------------------------
console.log("\n=== Stable show identity ===");
{
  const familyGuy = [
    "Family Guy S15E03 1080p",
    "Family Guy S01E01 720p HDTV",
    "www.UIndex.org - Family Guy S20E05",
    "Family.Guy.S10E12.720p",
    "Family Guy S24E11 Tall Stewie 1080p",
    "Family.Guy.S24E11.1080p.WEB.h264-playWEB",
  ];
  const folders = familyGuy.map((t) => showFolderName(t).toLowerCase());
  const unique = new Set(folders);
  if (unique.size !== 1 || ![...unique][0].includes("family guy")) {
    fail(`Family Guy releases must share one show folder, got ${[...unique].join(" | ")}`);
  } else {
    console.log("  ok: Family Guy →", folders[0]);
  }

  const onePiece = [
    "[SubsPlease] One Piece - 1170 (1080p)",
    "One Piece EP1233 S23",
    "One Piece S23E01 1080p",
    "www.UIndex.org - ONE PIECE 2023 S01E01",
    "One Piece 1170 mkv",
  ];
  const opFolders = onePiece.map((t) => showFolderName(t).toLowerCase());
  const opUnique = new Set(opFolders);
  if (opUnique.size !== 1 || ![...opUnique][0].match(/one piece/)) {
    fail(`One Piece releases must share one show folder, got ${[...opUnique].join(" | ")}`);
  } else {
    console.log("  ok: One Piece →", opFolders[0]);
  }

  // Season presence differs by title, but show segment is shared
  const paths = onePiece.map((t) => pathFor(t, "anime"));
  const shows = paths.map((p) => showSegment(p, "Anime"));
  if (new Set(shows.map((s) => s?.toLowerCase())).size !== 1) {
    fail(`One Piece paths scattered show segments: ${shows.join(" | ")}`);
  }
  // S23 titles must have Season 23
  const s23 = pathFor("One Piece S23E01", "anime");
  if (!s23.includes("Season 23")) {
    fail(`One Piece S23E01 missing Season 23: ${s23}`);
  }
  const abs = pathFor("[SubsPlease] One Piece - 1170", "anime");
  if (/Season \d+/i.test(abs)) {
    fail(`absolute ep must not get Season folder: ${abs}`);
  }
  console.log("  ok: One Piece season vs absolute nesting");
}

// ---------------------------------------------------------------------------
// attachDownloadRoutes relativePath mirrors resolveSmartPath rules
// ---------------------------------------------------------------------------
console.log("\n=== attachDownloadRoutes relativePath ===");
{
  const samples: { title: string; source?: TorrentResult["source"] }[] = [
    { title: "Family Guy S15E03 1080p", source: "apibay" },
    { title: "One Piece S23E01", source: "nyaa" },
    { title: "[SubsPlease] One Piece - 1170 (1080p)", source: "nyaa" },
    { title: "Severance S01-S02 Complete", source: "apibay" },
    { title: "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)", source: "torrentscsv" },
  ];
  const stub = (title: string, source: TorrentResult["source"] = "apibay"): TorrentResult => ({
    id: title,
    title,
    source,
    magnet: "magnet:?xt=urn:btih:abc",
    sizeBytes: 1,
    seeders: 1,
    leechers: 0,
    infoHash: "abc",
    tags: [],
    sourceUrl: "https://example.com",
  });

  const routed = attachDownloadRoutes(
    samples.map((s) => stub(s.title, s.source)),
    "all",
    null, // no base → relativePath populated
  );

  for (const r of routed) {
    const rel = r.route?.relativePath ?? "";
    const kind = r.route?.kind;
    const ep = parseEpisode(r.title);
    const seg = seasonFolderSegment(ep);
    console.log(`  ${r.title.slice(0, 50)} → kind=${kind} rel=${rel}`);

    if (kind === "software") {
      if (rel !== "Software" && !rel.startsWith("Software")) {
        // category only
        if (r.route?.category !== "Software") {
          fail(`software relativePath/category wrong: ${rel} / ${r.route?.category}`);
        }
      }
      if (/Season /i.test(rel)) fail(`software must not have Season: ${rel}`);
      continue;
    }

    if (kind === "tv" || kind === "anime") {
      const show = r.route?.cleanTitle ?? "";
      if (!show || /^www\./i.test(show)) {
        fail(`cleanTitle junk for "${r.title}": "${show}"`);
      }
      if (seg) {
        if (!rel.includes(seg)) {
          fail(`relativePath missing ${seg} for "${r.title}": ${rel}`);
        }
      } else if (/Season \d+/i.test(rel)) {
        fail(`relativePath unexpected Season for "${r.title}": ${rel}`);
      }
    }
  }
  console.log("  ok: relativePath season rules");
}

// ---------------------------------------------------------------------------
// 2. Live API organization (optional if localhost:3000 is up)
// ---------------------------------------------------------------------------
console.log("\n=== Live API organization ===");

async function liveCheck(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
  let up = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/search?q=test&limit=1`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    // any HTTP response means server is up (auth may 401)
    up = res.status > 0;
  } catch {
    up = false;
  }

  if (!up) {
    console.log("  SKIP live: server not reachable at", baseUrl);
    return;
  }

  const queries = ["Family Guy", "The Simpsons", "One Piece", "Breaking Bad"];
  type Row = { q: string; title: string; path: string; show: string; season: string | null };

  const table: Row[] = [];
  const showByQuery = new Map<string, Set<string>>();

  for (const q of queries) {
    const url = `${baseUrl}/api/search?q=${encodeURIComponent(q)}&limit=20`;
    let data: { results?: TorrentResult[] } = {};
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  SKIP live query "${q}": HTTP ${res.status}`);
        continue;
      }
      data = (await res.json()) as { results?: TorrentResult[] };
    } catch (e) {
      console.log(`  SKIP live query "${q}":`, e);
      continue;
    }

    const results = data.results ?? [];
    // Attach routes client-side the same way the API should
    const routed = attachDownloadRoutes(results, "all", {
      baseDownloadPath: BASE,
      categories: CATS,
    });

    const shows = new Set<string>();
    let sxxChecked = 0;

    for (const r of routed) {
      const title = r.title || "";
      const savePath = r.route?.savePath || r.route?.relativePath || "";
      const clean = r.route?.cleanTitle || showFolderName(title);
      const se = title.match(/\bS(\d{1,3})\s*E(\d{1,4})\b/i);
      const multi = /\bS\d{1,3}\s*[-–]\s*S?\d{1,3}\b/i.test(title);

      if (clean) shows.add(clean.toLowerCase());

      if (se && !multi) {
        sxxChecked++;
        const seasonNum = parseInt(se[1], 10);
        const expected = `Season ${String(seasonNum).padStart(2, "0")}`;
        const path = savePath || pathFor(title, (r.route?.kind as "tv" | "anime") || "tv");
        if (!path.includes(expected)) {
          fail(
            `live "${q}": title with ${se[0]} missing ${expected} in path "${path}" — title="${title.slice(0, 80)}"`,
          );
        }
        // show segment must not be site junk
        if (/^www\./i.test(clean) || /uindex|\.org/i.test(clean)) {
          fail(`live "${q}": junk show folder "${clean}" for "${title.slice(0, 60)}"`);
        }
        table.push({
          q,
          title: title.slice(0, 70),
          path,
          show: clean,
          season: expected,
        });
      } else if (table.length < 40 && clean) {
        table.push({
          q,
          title: title.slice(0, 70),
          path: savePath || "(no path)",
          show: clean,
          season: multi ? "(multi)" : null,
        });
      }
    }

    showByQuery.set(q, shows);

    // Same-show results should share a dominant show folder segment
    if (shows.size > 6) {
      fail(
        `live "${q}": too many distinct show folders (${shows.size}) — scattered identity: ${[...shows].slice(0, 12).join(" | ")}`,
      );
    } else {
      console.log(
        `  ok: "${q}" → ${results.length} results, ${sxxChecked} SxxEyy checked, show folders: ${[...shows].slice(0, 5).join(", ")}${shows.size > 5 ? "…" : ""}`,
      );
    }
  }

  if (table.length) {
    console.log("\n  Sample title → path:");
    console.log("  " + "-".repeat(100));
    for (const row of table.slice(0, 24)) {
      console.log(
        `  [${row.q}] ${row.title}\n      show=${row.show} season=${row.season ?? "—"} path=${row.path}`,
      );
    }
  }
}

async function main() {
  await liveCheck();

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n=== Summary ===");
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed:`);
    for (const f of failures) console.error(" -", f);
    process.exit(1);
  }
  console.log("path-organization.test.ts: all assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
