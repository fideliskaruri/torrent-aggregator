/**
 * The title H1 never prints a provider key.
 *
 * Runs through tests/legacy-ui.test.mjs (Vite SSR).
 */
import assert from "node:assert/strict";
import { headingTitle, isProviderKeyTitle } from "./heading-title";

assert.equal(isProviderKeyTitle("Tmdb:movie:550"), true);
assert.equal(isProviderKeyTitle("anilist:21087"), true);
assert.equal(isProviderKeyTitle("tt0137523"), true);
assert.equal(isProviderKeyTitle("   "), true);
assert.equal(isProviderKeyTitle("The Quiet 2020"), false);
assert.equal(isProviderKeyTitle("Re:ZERO -Starting Life in Another World-"), false);
assert.equal(isProviderKeyTitle("Mission: Impossible"), false);

assert.equal(headingTitle("Fight Club", "ignored"), "Fight Club");
assert.equal(headingTitle("Tmdb:movie:550", "Fight Club"), "Fight Club");
assert.equal(headingTitle("Tmdb:movie:550", null), null);
assert.equal(headingTitle("Tmdb:movie:550", "tmdb:movie:550"), null);

console.log("# PASS - title heading never shows provider keys");
