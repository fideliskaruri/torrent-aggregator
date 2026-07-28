/**
 * Episode/season parsing checks.
 * Run: npx tsx src/lib/torrents/episodes.test.ts
 */
import assert from "node:assert/strict";
import { parseEpisode } from "./episodes";

// --- A season marker with no episode number is a season pack ---
// This is the shape that made the "Packs" filter hide real packs: every
// indexer publishes complete seasons as "<Show> S04" or "<Show> Season 4",
// and the parser used to report those as ordinary episodes.
{
  const bare = parseEpisode("The Bear (2022) - S04 - [HULU WEBDL-1080p][h265]");
  assert.equal(bare.season, 4);
  assert.equal(bare.episode, undefined);
  assert.equal(bare.isSeasonPack, true, "S04 with no episode is a season pack");
  assert.equal(bare.isBatch, true);
  assert.equal(bare.isMultiSeason, false);

  const word = parseEpisode("Bear in the Big Blue House 1997 Season 1 TVRip");
  assert.equal(word.season, 1);
  assert.equal(word.isSeasonPack, true, "Season 1 with no episode is a pack");
}

// --- British "Series N" is a season pack, same as "Season N" ---
// Top Gear, Doctor Who, Sherlock etc. publish complete seasons as "Series 22".
// Reporting those as ordinary episodes let whole-series packs leak through the
// "Episodes" filter (every Top Gear result was a full series, none an episode).
{
  const uk = parseEpisode("Top Gear UK Series 22 (2015) 1080p");
  assert.equal(uk.season, 22, "Series 22 is season 22");
  assert.equal(uk.episode, undefined);
  assert.equal(uk.isSeasonPack, true, "a bare Series N is a season pack");
  assert.equal(uk.isBatch, true);
  assert.equal(uk.isMultiSeason, false);

  const ukRange = parseEpisode("Doctor Who Series 1-4 Complete 1080p");
  assert.equal(ukRange.isSeasonPack, true);
  assert.equal(ukRange.isMultiSeason, true, "Series 1-4 is a multi-season pack");

  // A "Series N" that carries an episode is still one episode, not a pack.
  const ukEp = parseEpisode("Sherlock Series 3 E02 1080p BluRay");
  assert.equal(ukEp.isSeasonPack, false, "Series 3 E02 is a single episode");
  assert.equal(ukEp.episode, 2);

  // Scene releases use dots/underscores between the word and the number.
  const dotted = parseEpisode("Top.Gear.UK.Series.22.1080p");
  assert.equal(dotted.isSeasonPack, true, "dotted Series.22 is a pack");
  assert.equal(dotted.season, 22);
  const dottedRange = parseEpisode("Doctor.Who.Series.1-4.Complete");
  assert.equal(dottedRange.isSeasonPack, true, "dotted Series.1-4 is a pack");
  assert.equal(dottedRange.isMultiSeason, true);
}

// --- A single episode is still not a pack ---
{
  const ep = parseEpisode("The Bear S04E08 1080p DSNP WEB-DL DDP5 1 H 264-FLUX");
  assert.equal(ep.season, 4);
  assert.equal(ep.episode, 8);
  assert.equal(ep.isSeasonPack, false, "S04E08 is one episode, not a pack");
  assert.equal(ep.isBatch, false);
}

// --- Multi-season ranges stay multi-season ---
{
  const range = parseEpisode("Solo Leveling (2024-2025) (Season 1 + 2) 1080p");
  assert.equal(range.isSeasonPack, true);
  assert.equal(range.isMultiSeason, true, "a range must not nest under one season");
}

// --- Absolute numbering with a season marker is an episode, not a pack ---
{
  const abs = parseEpisode("One Piece Ep 1233 S23 1080p");
  assert.equal(abs.episode, 1233);
  assert.equal(abs.isSeasonPack, false, "an absolute episode number is not a pack");
}

// --- A release with no season/episode signal at all stays unlabelled ---
{
  const movie = parseEpisode("Dune Part Two (2024) [1080p] [BluRay]");
  assert.equal(movie.label, null);
  assert.equal(movie.isSeasonPack, false);
}

console.log("episodes.test.ts OK");
