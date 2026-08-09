import assert from "node:assert/strict";
import { providerEpisodePlaceholders } from "./episode-placeholders";

const rows = providerEpisodePlaceholders(3, { 3: 10 });
assert.equal(rows.length, 10);
assert.deepEqual(rows[0], {
  episode: 1,
  name: null,
  overview: null,
  airDate: null,
  runtimeMin: null,
  stillUrl: null,
});
assert.equal(rows[9].episode, 10);

assert.deepEqual(providerEpisodePlaceholders(4, { 3: 10 }), []);
assert.equal(providerEpisodePlaceholders(1, { 1: 260 }).length, 200);

console.log("PASS extras falls back to provider season episode counts");
