// Run with the reference worktree's tsx CLI and --tsconfig, passing its root.
// The reference remains read-only; this records pure calls exercised by its tests.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const reference = process.argv[2];
if (!reference) throw new Error("Pass the read-only TypeScript worktree root");
const original = Module._load;
const records = new Map();
const names = new Set([
  "parseEpisode", "parseResolution", "isJunkSource", "isImplausible",
  "meetsResolutionFloor", "resolutionAffinity", "relevanceTier", "stripEpisodeTokens",
  "parseSourceTier", "directPlayableFromTitle", "extractTags", "stripReleaseGroup",
  "isExtrasRelease", "isUnsafeExecutableFileName", "normalizeInfoHash", "infoHashFromMagnet",
  "base32ToHex", "verdictTier", "resolutionPreferenceTier",
  "rankResults", "dedupeResults", "applyFilters",
  "detectContentKind", "showFolderName", "segmentTitle", "metadataMatchesTitle", "pickCategoryLabel",
  "workIdentity", "catalogAgrees", "releaseMatchesWork", "releaseYear", "metadataAgrees", "stripTrailingJunkNumber",
  "planSeason", "packEpisodeFiles", "episodesFromFilenames", "packEpisodeRange", "matchesTargetEpisode",
  "selectSeriesCandidateWithPackPreference", "seasonCoverage", "scoreRelease",
  "describeRelease", "compareReleases", "selectMainFeatureFile", "validateTorrentMediaPayload",
  "showTitleFromQuery", "episodeFromQuery",
]);
Module._load = function(request, parent, isMain) {
  const result = original.call(this, request, parent, isMain);
  if (!/[/\\](?:quality|ranking|episodes|filters|infohash|smart-category|work-identity|work-match|season-plan|pack-episode-files|pack-preference|eztv)$/.test(request)) return result;
  return new Proxy(result, { get(target, key) {
    const fn = target[key];
    if (!names.has(key) || typeof fn !== "function") return fn;
    return (...args) => {
      let expected = fn(...args);
      if (key === "rankResults" && args[0].some(r => r.publishedAt)) return expected;
      if (key === "describeRelease" && args[0].publishedAt) return expected;
      let recordedArgs = args;
      if (key === "planSeason") recordedArgs = [{ ...args[0], verdicts: Object.fromEntries(args[0].releases.map(r => [r.id, args[0].verdictOf(r)])) }];
      const entry = { method: key, args: recordedArgs, expected: expected instanceof Map ? Object.fromEntries(expected) : expected };
      const identity = JSON.stringify([key, recordedArgs]);
      records.set(identity, entry);
      return expected;
    };
  }});
};
const suites = ["episodes", "quality", "ranking", "filters", "source-tier", "infohash", "work-identity", "work-match", "../download/smart-category",
  "season-plan", "automatic-selection", "pack-episode-files", "absolute-season-ranking", "adapters/eztv"];
const oldExit = process.exit;
let baselineFailed = false;
process.exit = code => { if (code) { baselineFailed = true; console.error(`Reference suite reported exit ${code}`); } };
for (const suite of suites) {
  try { require(path.join(reference, "src", "lib", "torrents", suite + ".test.ts")); }
  catch (e) { baselineFailed = true; console.error(`Reference ${suite}: ${e.message}`); }
}
setTimeout(() => {
  if (baselineFailed || process.exitCode) {
    process.exit = oldExit;
    throw new Error("Reference assertions failed; refusing to replace the parity fixture");
  }
  const destination = path.join(__dirname, "Fixtures", "typescript-pure.json.gz");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, require("node:zlib").gzipSync(JSON.stringify([...records.values()]) + "\n"));
  console.log(`Recorded ${records.size} reference calls in ${destination}`);
  process.exit = oldExit;
}, 100);
