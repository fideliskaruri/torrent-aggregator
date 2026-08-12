import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  "src/app/api/title/[workKey]/extras/route.ts",
  "utf8",
);
const tmdbResolution = source.indexOf("const ref =");
const missingTmdbFallback = source.indexOf("if (!ref) {");
const tvmazeFallback = source.indexOf("tvmazeExtrasResponse(");

assert.ok(tmdbResolution >= 0);
assert.ok(missingTmdbFallback > tmdbResolution);
assert.ok(
  tvmazeFallback > missingTmdbFallback,
  "TVMaze must remain a fallback when TMDB cannot resolve, not preempt richer TMDB extras",
);
assert.match(
  source,
  /providerResult\.kind === "absent"\s*\?\s*await resolveTmdbRef/,
  "an unverified carried provider identity must not be replaced by a title-search guess",
);

console.log("title extras fallback order: all passed");
