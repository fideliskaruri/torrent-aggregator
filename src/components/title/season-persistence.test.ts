/**
 * BUG-SEASON-SPA-PERSISTENCE regression tests.
 *
 * A hard refresh reads the cookie server-side. A client-side navigation can
 * replay stale server props, so the live browser cookie must win.
 */
import assert from "node:assert/strict";
import {
  resolveInitialSeason,
  resolveSeasonOnPropsChange,
} from "./season-persistence";

// --- Initial load ------------------------------------------------------------

assert.equal(
  resolveInitialSeason({ legacySeason: 2, rememberedSeason: 9 }),
  2,
  "given an old inbound ?s=2 link, then it seeds the visit before migration",
);

assert.equal(
  resolveInitialSeason({ rememberedSeason: 4 }),
  4,
  "given a hard refresh, then the server-read cookie restores the season",
);

assert.equal(
  resolveInitialSeason({ rememberedSeason: null }),
  null,
  "given nothing remembered, then no season is forced and the payload default applies",
);

// --- SPA navigation: server props may be stale, browser cookie is not --------

assert.equal(
  resolveInitialSeason({
    rememberedSeason: 1,
    cookieSeason: 5,
  }),
  5,
  "given a stale server cookie, then the live browser cookie wins",
);

assert.equal(
  resolveInitialSeason({
    rememberedSeason: null,
    cookieSeason: 5,
  }),
  5,
  "given a stale payload with no season at all, then the client cookie restores the pick",
);

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:rick-and-morty",
    workKey: "tv:rick-and-morty",
    rememberedSeason: null,
    cookieSeason: null,
    currentSeason: 2,
    preserveCurrentSeason: true,
  }),
  2,
  "given a season picked in this mount, when a props update carries no season, then the pick survives",
);

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:rick-and-morty",
    workKey: "tv:rick-and-morty",
    currentSeason: 2,
    rememberedSeason: 6,
    cookieSeason: 6,
    preserveCurrentSeason: true,
  }),
  2,
  "given a live pick, then stale cookie props never clobber it",
);

// --- Switching titles must not leak the previous title's season -------------

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:rick-and-morty",
    workKey: "tv:rick-and-morty",
    rememberedSeason: 1,
    cookieSeason: 5,
    currentSeason: 1,
    preserveCurrentSeason: false,
  }),
  5,
  "given a remount from stale server props, then the live cookie replaces derived state",
);

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:rick-and-morty",
    workKey: "tv:the-wire",
    rememberedSeason: null,
    cookieSeason: null,
    currentSeason: 4,
  }),
  null,
  "given a navigation to a different title, then the previous title's season is dropped",
);

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:rick-and-morty",
    workKey: "tv:the-wire",
    cookieSeason: 3,
    currentSeason: 4,
  }),
  3,
  "given a navigation to a different title, then that title's own remembered season is used",
);

// --- Garbage never becomes a season ----------------------------------------

assert.equal(
  resolveInitialSeason({ legacySeason: 0, rememberedSeason: 2 }),
  2,
  "given an invalid legacy season, then the remembered season is used",
);

assert.equal(
  resolveSeasonOnPropsChange({
    previousWorkKey: "tv:x",
    workKey: "tv:x",
    legacySeason: Number.NaN,
    currentSeason: 2,
    preserveCurrentSeason: true,
  }),
  2,
  "given a malformed ?s=, then the live pick is kept rather than clobbered",
);

console.log("PASS season selection persists through cookies with clean URLs");
