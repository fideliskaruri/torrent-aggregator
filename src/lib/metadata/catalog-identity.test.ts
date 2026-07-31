import assert from "node:assert/strict";

import {
  catalogMetadata,
  catalogSourceFor,
} from "./catalog-identity";
import { detectContentKind } from "@/lib/download/smart-category";

const SOLO = {
  mediaType: "anime",
  externalId: "151807",
  title: "Solo Leveling",
  posterUrl: null,
  synopsis: null,
  rating: 8.1,
};

// --- The catalog split is exact, not a guess ---
// AniList only ever emits { source: "anilist", mediaType: "anime" } and TMDB
// only ever "movie" | "tv", so mediaType determines the catalog.
assert.equal(catalogSourceFor("anime"), "anilist");
assert.equal(catalogSourceFor("tv"), "tmdb");
assert.equal(catalogSourceFor("movie"), "tmdb");

// --- A watchlist row round-trips into the record it came from ---
{
  const meta = catalogMetadata(SOLO);
  assert.equal(meta?.source, "anilist");
  assert.equal(meta?.mediaType, "anime");
  assert.equal(meta?.title, "Solo Leveling");
  assert.equal(meta?.rating, 8.1);
}

// --- Anything we cannot vouch for is null, never a half-made record ---
// A partial MediaMetadata is worse than none: detectContentKind treats what it
// receives as authoritative, so a guess here would be laundered into a fact.
assert.equal(catalogMetadata(null), null);
assert.equal(catalogMetadata(undefined), null);
assert.equal(
  catalogMetadata({ mediaType: "anime", title: "  " }),
  null,
  "a blank title is not an identity",
);
assert.equal(
  catalogMetadata({ mediaType: "documentary", title: "X" }),
  null,
  "an unknown media type is not coerced",
);
assert.equal(
  catalogMetadata({ mediaType: "", title: "X" }),
  null,
  "an empty media type is not coerced",
);

// --- Case and padding in stored rows do not defeat the match ---
{
  const meta = catalogMetadata({ mediaType: " Anime ", title: "Solo Leveling" });
  assert.equal(meta?.mediaType, "anime");
  assert.equal(meta?.source, "anilist");
}

// --- The regression this exists to prevent ---
// Ordinary SxxEyy numbering is "strong TV structure". The catalog record is
// what lets a monitored anime beat it, and this asserts the record does its job
// on every release-name shape a monitored show throws at it.
//
// The *precondition* half of this block used to assert the opposite for all
// three titles: that without the record the hint always lost, so a monitored
// anime landed in TV/. That is no longer true across the board, and the change
// was deliberate — a release whose own name says "Dual Audio" or carries a
// fansub group now beats the structural guess when the owner searched Anime
// (see `smart-category.ts`). The clean, cue-free name is the case that still
// genuinely needs the catalog record, so that is where the precondition
// belongs now. Weakening the test to "expect anime either way" would have
// thrown away the only assertion proving the record matters at all.
{
  const titles = [
    "[EMBER] Solo Leveling (2024-2025) (Season 1 + 2) [BDRip] [1080p Dual Audio HEVC 10 bits DDP] (Batch)",
    "Solo Leveling S02E05 1080p WEB-DL x265-GRP",
    "Solo Leveling S01 1080p Dual Audio BDRip 10 bits DD+ x265-EMBER",
  ];

  // No anime cue anywhere in the name: this is the release the catalog record
  // exists for, and without it the structural TV reading still wins.
  assert.equal(
    detectContentKind({
      title: "Solo Leveling S02E05 1080p WEB-DL x265-GRP",
      source: "watchlist",
      searchCategory: "anime",
    }),
    "tv",
    "precondition: a cue-free SxxEyy name still needs the catalog record",
  );

  for (const title of titles) {
    assert.equal(
      detectContentKind({
        title,
        source: "watchlist",
        searchCategory: "anime",
        metadata: catalogMetadata(SOLO),
      }),
      "anime",
      `the catalog record wins — ${title}`,
    );
  }
}

// --- A catalog record must not hijack an unrelated release ---
// The title gate still applies: automation picks the best search hit, and a
// bad hit must not inherit the monitored show's identity.
assert.equal(
  detectContentKind({
    title: "Atlantis 2013 S01-S02 1080p BluRay x265-BONE",
    source: "apibay",
    metadata: catalogMetadata(SOLO),
  }),
  "tv",
  "metadata for a different show is ignored",
);

// --- Movies and TV round-trip too, and are not forced to anime ---
assert.equal(
  detectContentKind({
    title: "The Bear S03E01 1080p HEVC x265-MeGusta",
    source: "apibay",
    metadata: catalogMetadata({
      mediaType: "tv",
      externalId: "136315",
      title: "The Bear",
    }),
  }),
  "tv",
);
assert.equal(
  detectContentKind({
    title: "Dune Part Two (2024) [2160p] [4K] [WEB] [5.1] [YTS.MX]",
    source: "yts",
    metadata: catalogMetadata({
      mediaType: "movie",
      externalId: "693134",
      title: "Dune Part Two",
    }),
  }),
  "movies",
);

console.log("catalog-identity.test.ts: all assertions passed");
