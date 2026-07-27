/**
 * Live probe: run one real catalog refresh and print exactly what it stored.
 *
 * Not a test — a way to look at the product's actual output. The single most
 * likely failure mode of a discovery rail is that it renders plausibly and
 * reads as garbage, and no assertion catches that. A human has to read it.
 *
 *   $env:DATABASE_URL="file:./qa-tmdb.db"; node --import tsx scripts/probe-catalog.mts
 */
import { refreshCatalog, refreshRelatedForSeed, stopCatalogTimer } from "../src/lib/catalog/refresh";
import { readCatalogRows } from "../src/lib/catalog/store";

const started = Date.now();
const result = await refreshCatalog();
console.log(`\nrefresh: ${JSON.stringify(result)}\n`);

for (const source of ["trending", "popular"] as const) {
  const rows = await readCatalogRows(source, null, 48);
  console.log(`── ${source} (${rows.length} rows) ──`);
  for (const row of rows.slice(0, 24)) {
    const seed = row.seeders > 0 ? `${row.seeders} seeders` : "no chart match";
    console.log(
      `  ${String(row.rank).padStart(2)}. ${row.title}${row.year ? ` (${row.year})` : ""}` +
        `  [${row.mediaType}] ${row.rating ?? "–"}★ ${seed}` +
        `\n      poster=${row.posterUrl ?? "NONE"}` +
        `\n      key=${row.workKey}` +
        (row.bestRelease ? `\n      best=${row.bestRelease}` : ""),
    );
  }
  console.log("");
}

const seedTitle = process.env.PROBE_SEED ?? "Dune Part Two";
const n = await refreshRelatedForSeed({ title: seedTitle, mediaType: "movie" });
console.log(`── related for "${seedTitle}" (${n} rows) ──`);
for (const row of await readCatalogRows("related", seedTitle, 24)) {
  console.log(`  ${String(row.rank).padStart(2)}. ${row.title}${row.year ? ` (${row.year})` : ""}  poster=${row.posterUrl ? "yes" : "NONE"}`);
}

console.log(`\ntotal ${Date.now() - started}ms`);
stopCatalogTimer();
process.exit(0);
