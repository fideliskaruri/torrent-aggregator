/**
 * Lightweight unit checks for smart categorization.
 * Run with: npx tsx src/lib/download/smart-category.test.ts
 */
import assert from "node:assert/strict";
import {
  detectContentKind,
  pickCategoryLabel,
  resolveSmartPath,
  segmentTitle,
  showFolderName,
  smartCategorize,
} from "./smart-category";

const CATS = ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];

// --- Critical bug: multi-season Western packs must be TV, not Anime ---
{
  const title = "Atlantis 2013 S01-S02 720p BluRay HEVC x265 BONE";
  const kind = detectContentKind({ title });
  assert.equal(kind, "tv", `expected tv for "${title}", got ${kind}`);

  const smart = smartCategorize({ title, tags: ["720p", "HEVC", "x265"] }, CATS);
  assert.equal(smart.kind, "tv");
  assert.equal(smart.category, "TV");
  assert.ok(
    smart.confidence === "high" || smart.confidence === "medium",
    "season pack should not be low confidence",
  );

  // Stamped wrong AniList metadata (from query enrichment) must NOT force Anime
  const polluted = detectContentKind({
    title,
    source: "apibay",
    metadata: {
      source: "anilist",
      mediaType: "anime",
      externalId: "999",
      title: "Attack on Titan",
    },
  });
  assert.equal(
    polluted,
    "tv",
    "mismatched anime metadata must not override S01-S02 TV pack",
  );
}

// SxxEyy → TV
{
  assert.equal(
    detectContentKind({ title: "The Office S02E05 1080p WEB-DL" }),
    "tv",
  );
}

// Season pack wording → TV
{
  assert.equal(
    detectContentKind({ title: "Breaking Bad Season 1 Complete 1080p" }),
    "tv",
  );
}

// Multi-season Season N-M → TV
{
  assert.equal(
    detectContentKind({ title: "Lost Seasons 1-3 720p BluRay" }),
    "tv",
  );
}

// 1x05 style → TV
{
  assert.equal(
    detectContentKind({ title: "Firefly 1x03 1080p" }),
    "tv",
  );
}

// Strong TV beats anime search category
{
  assert.equal(
    detectContentKind({
      title: "Atlantis 2013 S01-S02 720p BluRay HEVC x265 BONE",
      searchCategory: "anime",
    }),
    "tv",
  );
}

// Strong TV beats stray anime-looking tokens (HEVC alone is not anime)
{
  assert.equal(
    detectContentKind({
      title: "Game of Thrones S01-S08 Complete 1080p BluRay HEVC",
      tags: ["hevc", "bluray"],
    }),
    "tv",
  );
}

// AniList anime metadata wins even with SxxEyy
{
  assert.equal(
    detectContentKind({
      title: "Attack on Titan S04E01 1080p",
      metadata: {
        source: "anilist",
        mediaType: "anime",
        externalId: "1",
        title: "Attack on Titan",
      },
    }),
    "anime",
  );
}

// TMDB movie metadata → movies
{
  assert.equal(
    detectContentKind({
      title: "Inception 2010 1080p BluRay",
      metadata: {
        source: "tmdb",
        mediaType: "movie",
        externalId: "1",
        title: "Inception",
      },
    }),
    "movies",
  );
}

// TMDB TV + Animation genre stays TV without JP anime signals
{
  assert.equal(
    detectContentKind({
      title: "Avatar The Last Airbender S01E01",
      metadata: {
        source: "tmdb",
        mediaType: "tv",
        externalId: "1",
        title: "Avatar: The Last Airbender",
        genres: ["Animation", "Action & Adventure"],
      },
    }),
    "tv",
  );
}

// TMDB TV + Animation + JP anime signals → anime
{
  assert.equal(
    detectContentKind({
      title: "Some Show S01E01 dual audio subbed",
      metadata: {
        source: "tmdb",
        mediaType: "tv",
        externalId: "1",
        title: "Some Show",
        genres: ["Animation"],
      },
    }),
    "anime",
  );
}

// YTS → movies
{
  assert.equal(
    detectContentKind({ title: "Dune 2021 1080p", source: "yts" }),
    "movies",
  );
}

// Nyaa without strong TV/movie → anime
{
  assert.equal(
    detectContentKind({
      title: "[SubsPlease] Bocchi the Rock - 01 (1080p)",
      source: "nyaa",
    }),
    "anime",
  );
}

// Nyaa is anime-first: SxxEyy without live-action → anime (One Piece, etc.)
{
  assert.equal(
    detectContentKind({
      title: "One Piece S23E01 1080p",
      source: "nyaa",
    }),
    "anime",
  );
  assert.equal(
    detectContentKind({
      title: "Some Drama S01E03 1080p",
      source: "nyaa",
    }),
    "anime",
    "Nyaa SxxEyy defaults to anime unless live-action",
  );
}

// Nyaa live action → TV
{
  assert.equal(
    detectContentKind({
      title: "Rurouni Kenshin Live Action 1080p",
      source: "nyaa",
    }),
    "tv",
  );
  assert.equal(
    detectContentKind({
      title: "Some Drama S01E03 Live Action 1080p",
      source: "nyaa",
    }),
    "tv",
  );
}

// Classic anime naming (bracket group + bare ep) without Sxx → anime
{
  assert.equal(
    detectContentKind({
      title: "[Erai-raws] Spy x Family - 12 [1080p]",
    }),
    "anime",
  );
}

// --- Software must never become Movies ---
{
  const photoshop = "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)";
  assert.equal(
    detectContentKind({ title: photoshop, source: "torrentscsv" }),
    "software",
    "Photoshop is Software",
  );
  // Search filter Movies must not force Movies over Adobe/macOS signals
  assert.equal(
    detectContentKind({
      title: photoshop,
      searchCategory: "movies",
      source: "torrentscsv",
    }),
    "software",
    "searchCategory=movies must not override Adobe Photoshop",
  );
  const smartPs = smartCategorize(
    { title: photoshop, source: "torrentscsv", tags: [] },
    CATS,
    "movies",
  );
  assert.equal(smartPs.kind, "software");
  assert.equal(smartPs.category, "Software");
  assert.equal(smartPs.confidence, "high");

  assert.equal(
    detectContentKind({
      title: "Microsoft Office 2021 Pro Plus + Crack",
      searchCategory: "movies",
    }),
    "software",
  );
  assert.equal(
    detectContentKind({
      title: "WinRAR 7.01 Final Multilingual + Keygen",
    }),
    "software",
  );
  assert.equal(
    detectContentKind({
      title: "SomeApp v12.3.4 + Fix (Windows 11)",
    }),
    "software",
  );
}

// Games still work and beat movies filter
{
  assert.equal(
    detectContentKind({
      title: "Elden Ring FitGirl Repack",
      searchCategory: "movies",
    }),
    "games",
  );
}

// Real movies still movies (year + bluray, no software signals)
{
  assert.equal(
    detectContentKind({
      title: "Dune Part Two 2024 1080p BluRay x264",
    }),
    "movies",
  );
}

// pickCategoryLabel
{
  assert.equal(pickCategoryLabel("tv", CATS), "TV");
  assert.equal(pickCategoryLabel("anime", CATS), "Anime");
  assert.equal(pickCategoryLabel("movies", CATS), "Movies");
  assert.equal(pickCategoryLabel("software", CATS), "Software");
}

// segmentTitle strips quality / season noise
{
  const clean = segmentTitle(
    "Atlantis 2013 S01-S02 720p BluRay HEVC x265 BONE",
  );
  assert.ok(/atlantis/i.test(clean), `expected show name in "${clean}"`);
  assert.ok(!/720p|hevc|bluray|s01/i.test(clean), `noise left in "${clean}"`);
}

// resolveSmartPath
{
  // Software is category only — do NOT nest product name under Movies-style paths
  assert.equal(
    resolveSmartPath(
      "/downloads",
      "software",
      "Software",
      { title: "Adobe Photoshop 2024 v25.5.1 + Fix (macOS)" },
    ),
    "/downloads/Software",
  );
  assert.equal(
    resolveSmartPath("/downloads", "movies", "Movies"),
    "/downloads/Movies",
  );
  assert.equal(
    resolveSmartPath(
      "/downloads",
      "tv",
      "TV",
      { title: "Atlantis 2013 S01-S02 720p BluRay HEVC x265 BONE" },
    ),
    "/downloads/TV/Atlantis",
  );
  assert.equal(
    resolveSmartPath("/downloads", "tv", "TV", {
      title: "The Office S02E05",
      nestShowFolder: false,
    }),
    "/downloads/TV",
  );
}

// --- Per-episode must share ONE show folder (user screenshot bug) ---
{
  const releases = [
    "[SubsPlease] One Piece - 1170 (1080p) [A5F746F4].mkv",
    "One Piece EP1170 AAC2.0",
    "One Piece 1170 mkv",
    "[Erai-raws] One Piece - 1169 [1080p]",
  ];
  const folders = releases.map((t) => showFolderName(t));
  for (const f of folders) {
    assert.ok(
      /^one piece$/i.test(f),
      `expected "One Piece" folder, got "${f}"`,
    );
    assert.ok(!/\d{3,4}/.test(f), `episode digits leaked into folder: "${f}"`);
    assert.ok(!/mkv|aac/i.test(f), `junk leaked into folder: "${f}"`);
  }
  // All episodes → identical folder name
  assert.equal(new Set(folders.map((f) => f.toLowerCase())).size, 1);

  const withMeta = showFolderName(
    "[SubsPlease] One Piece - 1170 (1080p).mkv",
    {
      source: "anilist",
      mediaType: "anime",
      externalId: "21",
      title: "ONE PIECE",
    },
  );
  assert.equal(withMeta, "ONE PIECE");

  const p1 = resolveSmartPath("/data", "anime", "Anime", {
    title: "[SubsPlease] One Piece - 1170 (1080p).mkv",
  });
  const p2 = resolveSmartPath("/data", "anime", "Anime", {
    title: "One Piece EP1169 AAC2.0",
  });
  assert.equal(p1, "/data/Anime/One Piece");
  assert.equal(p2, "/data/Anime/One Piece");
  assert.equal(p1, p2, "every episode lands in the same folder");

  // Western TV episode gets Season folder
  assert.equal(
    resolveSmartPath("/data", "tv", "TV", {
      title: "Severance S01E05 1080p",
    }),
    "/data/TV/Severance/Season 01",
  );

  // Anime with SxxEyy also gets Season folder
  assert.equal(
    resolveSmartPath("/data", "anime", "Anime", {
      title: "One Piece S23E01 1080p",
    }),
    "/data/Anime/One Piece/Season 23",
  );
  assert.equal(
    resolveSmartPath("/data", "anime", "Anime", {
      title: "One Piece EP1233 S23",
    }),
    "/data/Anime/One Piece/Season 23",
  );

  // Site prefix must not become the folder
  assert.ok(
    /^one piece$/i.test(
      showFolderName("www.UIndex.org - ONE PIECE 2023 S01 Complete"),
    ),
    "UIndex site prefix must be stripped",
  );

  // pathRules root (already category folder)
  assert.equal(
    resolveSmartPath("D:\\Torrents\\Anime", "anime", "", {
      title: "[SubsPlease] One Piece - 1170 (1080p).mkv",
      separator: "\\",
    }),
    "D:\\Torrents\\Anime\\One Piece",
  );
}

console.log("smart-category.test.ts: all assertions passed");
