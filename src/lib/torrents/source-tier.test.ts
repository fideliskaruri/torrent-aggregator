import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceTier, SOURCE_TIER } from "./quality";

test("web-dl outranks hdtv", () => {
  assert.ok(
    parseSourceTier("The Bear S04E01 1080p WEB-DL DDP5.1 H.264-NTb") >
      parseSourceTier("The Bear S04E01 1080p HDTV x264-GROUP"),
  );
});

test("a 720p web-dl outranks a 1080p hdtv on source tier", () => {
  // The whole reason this exists: pixel count alone gets this backwards.
  assert.ok(
    parseSourceTier("Show S01E01 720p WEB-DL x264") >
      parseSourceTier("Show S01E01 1080p HDTV x264"),
  );
});

test("web-dl is not read as webrip", () => {
  assert.equal(
    parseSourceTier("Show 1080p WEB-DL x265"),
    SOURCE_TIER.WEBDL,
  );
  assert.equal(parseSourceTier("Show 1080p WEBRip x265"), SOURCE_TIER.WEBRIP);
});

test("webrip outranks hdtv but not web-dl", () => {
  const webrip = parseSourceTier("Show 1080p WEBRip x264");
  assert.ok(webrip > parseSourceTier("Show 1080p HDTV x264"));
  assert.ok(webrip < parseSourceTier("Show 1080p WEB-DL x264"));
});

test("a service tag does not promote a WEBRip to WEB-DL", () => {
  // AMZN names where it came from, not how it was captured.
  assert.equal(
    parseSourceTier("Show S01E01 1080p AMZN WEBRip x264"),
    SOURCE_TIER.WEBRIP,
  );
  assert.equal(
    parseSourceTier("Show S01E01 1080p AMZN WEB-DL x264"),
    SOURCE_TIER.WEBDL,
  );
});

test("a bare WEB tag counts as a direct pull", () => {
  assert.equal(
    parseSourceTier("Show S01E01 1080p DSNP WEB x264"),
    SOURCE_TIER.WEBDL,
  );
});

test("'Web' in a real title is not a source tag", () => {
  // Charlotte's Web is a film, not a WEB-DL.
  assert.equal(
    parseSourceTier("Charlottes Web 1080p x264-GROUP"),
    SOURCE_TIER.UNKNOWN,
  );
  assert.equal(
    parseSourceTier("Charlottes Web 2006 1080p BluRay x264"),
    SOURCE_TIER.BLURAY,
  );
});

test("bluray and remux share the top tier — remux is not promoted", () => {
  // Promoting remux would silently start grabbing 40-80GB files with no
  // profile for the user to say no with.
  assert.equal(
    parseSourceTier("Movie 2024 1080p BluRay x264"),
    parseSourceTier("Movie 2024 1080p BluRay REMUX AVC"),
  );
});

test("an unnamed source is neutral, not last", () => {
  const unknown = parseSourceTier("[Erai-raws] Show - 05 [1080p]");
  assert.equal(unknown, SOURCE_TIER.UNKNOWN);
  // Must not sink below a broadcast rip, or the main anime indexer starves.
  assert.ok(unknown > parseSourceTier("Show 1080p HDTV x264"));
});

test("dots and underscores do not hide the source token", () => {
  assert.equal(
    parseSourceTier("The.Bear.S04E01.1080p.WEB.DL.x265"),
    SOURCE_TIER.WEBDL,
  );
  assert.equal(
    parseSourceTier("The_Bear_S04E01_1080p_HDTV_x264"),
    SOURCE_TIER.HDTV,
  );
});

test("empty title is neutral, not a crash", () => {
  assert.equal(parseSourceTier(""), SOURCE_TIER.UNKNOWN);
});
