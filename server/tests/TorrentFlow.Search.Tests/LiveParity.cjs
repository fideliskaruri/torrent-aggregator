// Explicit opt-in live search check; never invoked by dotnet test.
// Usage: reference tsx CLI --tsconfig <reference>\tsconfig.json LiveParity.cjs <reference>
const path = require("node:path");
const fs = require("node:fs");
const reference = process.argv[2];
if (!reference || !process.env.DATABASE_URL) throw new Error("Reference worktree and isolated DATABASE_URL required");
const { searchTorrents, listAvailableSources } = require(path.join(reference, "src", "lib", "torrents", "aggregator.ts"));
async function main() {
  const report = [];
  for (const query of ["dune", "ubuntu", "big buck bunny"]) {
    const started = performance.now();
    const [api, referenceResult] = await Promise.all([
      fetch(`http://127.0.0.1:5101/api/search?q=${encodeURIComponent(query)}&pageSize=200&category=all`).then(async response => {
        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
        return response.json();
      }),
      searchTorrents({ query, pageSize: 200, category: "all", adapterDeadlineMs: 6000 }),
    ]);
    const referenceBody = JSON.parse(JSON.stringify({ ...referenceResult, availableSources: listAvailableSources() }));
    const row = {
      query, wallMs: Math.round(performance.now() - started),
      dotnet: { tookMs: api.tookMs, totalCount: api.totalCount, sources: api.sources, keys: Object.keys(api).sort(), resultKeys: Object.keys(api.results[0] ?? {}).sort() },
      typescript: { tookMs: referenceBody.tookMs, totalCount: referenceBody.totalCount, sources: referenceBody.sources, keys: Object.keys(referenceBody).sort(), resultKeys: Object.keys(referenceBody.results[0] ?? {}).sort() },
      commonHashes: api.results.filter(a => referenceBody.results.some(b => a.infoHash && a.infoHash === b.infoHash)).length,
    };
    report.push(row);
    console.log(JSON.stringify(row));
  }
  fs.writeFileSync(path.join(__dirname, "live-parity.json"), JSON.stringify(report, null, 2) + "\n");
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
