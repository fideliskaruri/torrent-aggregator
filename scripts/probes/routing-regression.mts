/**
 * Did adding the new scopes break the old paths?
 *
 * The routing rules in `smart-category.ts` were changed to make Books, Anime and
 * the non-video scopes file correctly. That module decides where EVERY download
 * lands, including films and television, which is the traffic the app is mostly
 * used for. A win on music that quietly moved films into Other/ would be a bad
 * trade, and the unit tests only cover the cases someone thought to write.
 *
 * So this replays the shapes real releases actually take — including the ones
 * that arrive with no scope at all, which is what Browse and the title page do —
 * and asserts nothing moved.
 *
 * Run:  npx tsx scripts\probes\routing-regression.mts
 */
import { detectContentKind, pickCategoryLabel } from "@/lib/download/smart-category";

const CATS = ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

type Row = {
  title: string;
  scope?: string | null;
  source?: string;
  expect: string;
  why: string;
};

/**
 * The unscoped shapes. This is how Browse, the title page and automation send —
 * they know what the work is from metadata, not from a tab. If the video guard
 * or the books rule leaked into this path, it shows up here.
 */
const UNSCOPED: Row[] = [
  {
    title: "Dune Part Two (2024) [1080p] [BluRay]",
    expect: "movies",
    why: "a film with no scope is still a film",
  },
  {
    title: "Dune Part Two 2024 NORDiC 1080p REMUX BluRay AVC DTS-HD MA TrueHD 7 1",
    expect: "movies",
    why: "a remux is a film",
  },
  {
    title: "Severance S02E06 1080p WEB H264-SuccessfulCrab",
    expect: "tv",
    why: "SxxEyy with no scope is television",
  },
  {
    title: "Atlantis 2013 S01-S02 720p BluRay HEVC x265 BONE",
    expect: "tv",
    why: "a multi-season western pack is television",
  },
  {
    title: "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)",
    expect: "software",
    why: "a versioned application is software, scope or not",
  },
  {
    title: "Daft Punk - Discovery (2001) [FLAC] 88",
    expect: "music",
    why: "an explicit lossless marker is music on its own",
  },
  {
    title: "Brandon Sanderson - Mistborn Series 1-6(EPUB)",
    expect: "books",
    why: "an explicit book format beats the Series-as-seasons reading",
  },
];

/** The scoped shapes — the new surfaces. */
const SCOPED: Row[] = [
  { title: "Daft Punk - Discovery (2001) Mp3 320kbps", scope: "music", expect: "music", why: "lossy album" },
  { title: "Stardew Valley [FitGirl Repack]", scope: "games", expect: "games", why: "repack" },
  { title: "stardew_valley_windows_gog_(78674)", scope: "games", expect: "games", why: "underscore name" },
  { title: "Blender 2.8 addons pack 2.8-2.91.2 [ENG]", scope: "apps", expect: "software", why: "app" },
  { title: "Atomic Habits - James Clear (Unabridged)", scope: "books", expect: "books", why: "audiobook" },
  { title: "Atomic Habits - James Clear (2018)", scope: "books", expect: "books", why: "bare book" },
  {
    title: "[TatakaeFuniSubs] Attack on Titan S01-04 (BD 1080p) [Dual Audio]",
    scope: "anime",
    expect: "anime",
    why: "fansub + dual audio corroborate the scope",
  },
  {
    title: "Dune Part Two (2024) [1080p] [BluRay]",
    scope: "music",
    expect: "movies",
    why: "a shelf must not relabel a film",
  },
];

/** Nyaa is anime-first; that source bias must survive. */
const SOURCED: Row[] = [
  {
    title: "[SubsPlease] Frieren - 12 (1080p) [ABC123].mkv",
    source: "nyaa",
    expect: "anime",
    why: "nyaa is anime-first",
  },
  {
    title: "Some Live Action Drama S01E01 1080p",
    source: "nyaa",
    expect: "tv",
    why: "explicit live-action on nyaa is still tv",
  },
  {
    title: "Dune Part Two (2024) 1080p BluRay",
    source: "yts",
    expect: "movies",
    why: "yts is films only",
  },
];

console.log("routing-regression\n");

console.log("  — unscoped (Browse / title page / automation) —");
for (const row of UNSCOPED) {
  const kind = detectContentKind({ title: row.title, tags: [] });
  check(
    `${row.expect.padEnd(8)} ${row.title.slice(0, 46)}`,
    kind === row.expect,
    `got ${kind} — ${row.why}`,
  );
}

console.log("\n  — scoped (the new shelves) —");
for (const row of SCOPED) {
  const kind = detectContentKind({
    title: row.title,
    tags: [],
    searchCategory: row.scope ?? undefined,
  });
  check(
    `${row.expect.padEnd(8)} ${row.title.slice(0, 46)}`,
    kind === row.expect,
    `got ${kind} — ${row.why}`,
  );
}

console.log("\n  — source bias —");
for (const row of SOURCED) {
  const kind = detectContentKind({ title: row.title, tags: [], source: row.source });
  check(
    `${row.expect.padEnd(8)} ${row.title.slice(0, 46)}`,
    kind === row.expect,
    `got ${kind} — ${row.why}`,
  );
}

console.log("\n  — every kind maps to a folder that exists —");
for (const row of [...UNSCOPED, ...SCOPED, ...SOURCED]) {
  const kind = detectContentKind({
    title: row.title,
    tags: [],
    searchCategory: row.scope ?? undefined,
    source: row.source,
  });
  const label = pickCategoryLabel(kind, CATS);
  check(
    `${String(label).padEnd(9)} ${row.title.slice(0, 42)}`,
    CATS.includes(label),
    `"${label}" is not a configured folder`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} routing regression(s)`);
  process.exit(1);
}
console.log("\nno routing regressions");
