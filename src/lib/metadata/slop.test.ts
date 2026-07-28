/**
 * I18 — slop / hallucinated identity, as a RULE CLASS.
 *
 * These assert the *shape* of a non-title is rejected and legitimate titles
 * pass, across many inputs — not a blocklist of the exact strings a screenshot
 * showed. A regression that lets "Untitled … Project" or "Unknown title" back
 * onto a rail, or that starts eating real short titles like "Us" or "It", makes
 * one of these fail.
 *
 * `catalogAgrees` lives in `@/lib/torrents/work-identity` and is imported
 * read-only: the catalog borrows a catalog title only when it *refines* the
 * release name, so "Dune" must never borrow the spin-off "Dune: Prophecy".
 */
import assert from "node:assert/strict";
import { isRenderableTitle, isSlopTitle } from "./slop";
import { catalogAgrees } from "@/lib/torrents/work-identity";

// ---------------------------------------------------------------------------
// isSlopTitle — junk is rejected, legit titles pass
// ---------------------------------------------------------------------------

const SLOP_CASES: Array<{ title: string; slop: boolean; why: string }> = [
  // Placeholders TMDB actually emits for announced-but-unnamed projects.
  { title: "Untitled Marvel Project", slop: true, why: "TMDB unnamed placeholder" },
  { title: "Untitled Star Wars Film", slop: true, why: "TMDB unnamed placeholder" },
  { title: "untitled", slop: true, why: "bare placeholder" },
  // Our own last-resort placeholder from the browse collapser.
  { title: "Unknown title", slop: true, why: "browse placeholder" },
  { title: "TBA", slop: true, why: "to be announced" },
  { title: "TBD", slop: true, why: "to be determined" },
  { title: "N/A", slop: true, why: "not applicable" },
  { title: "Coming Soon", slop: true, why: "placeholder phrase" },
  { title: "null", slop: true, why: "serialised null" },
  { title: "undefined", slop: true, why: "serialised undefined" },
  // Bare coordinates promoted into a title slot.
  { title: "Episode 5", slop: true, why: "coordinate, not a work" },
  { title: "Episode #12", slop: true, why: "coordinate with hash" },
  { title: "Season 3", slop: true, why: "coordinate, not a work" },
  { title: "Movie 4", slop: true, why: "coordinate, not a work" },
  { title: "S01E05", slop: true, why: "raw episode code" },
  { title: "1x05", slop: true, why: "raw episode code" },
  // Structural junk.
  { title: "", slop: true, why: "empty" },
  { title: "   ", slop: true, why: "whitespace only" },
  { title: "88", slop: false, why: "numeric-only titles can be real films" },
  { title: "---", slop: true, why: "no letters or digits" },
  { title: "x", slop: true, why: "single character" },

  // Legitimate titles — must all pass. These are the ones a naive blocklist
  // would break.
  { title: "Unknown", slop: false, why: "the 2011 Liam Neeson film" },
  { title: "Us", slop: false, why: "the 2019 Jordan Peele film" },
  { title: "It", slop: false, why: "the 2017 film" },
  { title: "1917", slop: false, why: "the film 1917" },
  { title: "2012", slop: false, why: "the film 2012" },
  { title: "300", slop: false, why: "the film 300 — has a digit but is a work" },
  { title: "Se7en", slop: false, why: "stylised but real" },
  { title: "Toy Story 5", slop: false, why: "a real numbered sequel" },
  { title: "Avengers: Doomsday", slop: false, why: "a real subtitled film" },
  { title: "Lanterns", slop: false, why: "a real 2026 series" },
  { title: "Pompeii: Out of Time with Tom Hiddleston", slop: false, why: "a real title" },
  { title: "The Untitled", slop: false, why: "'untitled' not leading" },
  { title: "Everything Everywhere All at Once", slop: false, why: "a real title" },
];

for (const { title, slop, why } of SLOP_CASES) {
  assert.equal(
    isSlopTitle(title),
    slop,
    `isSlopTitle(${JSON.stringify(title)}) should be ${slop} — ${why}`,
  );
  assert.equal(isRenderableTitle(title), !slop, `isRenderableTitle disagrees for ${title}`);
}

// ---------------------------------------------------------------------------
// catalogAgrees — refine in, spin-off out (read-only, from work-identity)
// ---------------------------------------------------------------------------

const AGREE_CASES: Array<{ release: string; catalog: string; agrees: boolean; why: string }> = [
  { release: "Dune", catalog: "Dune", agrees: true, why: "equality" },
  { release: "Dune Prophecy", catalog: "Dune: Prophecy", agrees: true, why: "punctuation-only difference" },
  { release: "The Office", catalog: "The Office (US)", agrees: true, why: "parenthetical disambiguator refines" },
  // The whole point: a bare title must not borrow a distinct spin-off.
  { release: "Dune", catalog: "Dune: Prophecy", agrees: false, why: "colon subtitle is a separate work" },
  { release: "Dune", catalog: "Dune: Part Two", agrees: false, why: "colon subtitle is a separate work" },
  { release: "Dune", catalog: "Dune - Part Two", agrees: false, why: "spaced-dash subtitle is a separate work" },
  { release: "Children of Dune", catalog: "Dune", agrees: false, why: "catalog blurs — vaguer than release" },
  { release: "", catalog: "Dune", agrees: false, why: "empty release" },
];

for (const { release, catalog, agrees, why } of AGREE_CASES) {
  assert.equal(
    catalogAgrees(release, catalog),
    agrees,
    `catalogAgrees(${JSON.stringify(release)}, ${JSON.stringify(catalog)}) should be ${agrees} — ${why}`,
  );
}

console.log("slop: ok");
