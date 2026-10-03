# Legacy converter

Build separately from the API's shared output:

```powershell
dotnet build backend\tools\Convert\Convert.csproj -o D:\code\memtest\bin-convert-tool
dotnet D:\code\memtest\bin-convert-tool\TorrentFlow.Convert.dll --from D:\code\memtest\rebuild-convert-src --to D:\code\memtest\rebuild-convert --path-map tools\.convert-proof\path-map.json
```

`--from` accepts either the old data folder or its parent. The source database is
opened read-only. A SQLite backup including committed WAL changes and copies of
the source side files are created before initializing the destination. Never
copy a live database without WAL or the SQLite backup API.

The optional path map is a JSON object mapping old absolute roots to **copied**
payload roots, for example `{"D:\\Torrents":"D:\\code\\memtest\\rebuild-convert-src\\payloads"}`.
Without a copied payload map, ownership is not inferred from old completion claims.
Original payload roots, junctions and paths escaping their mapped root are refused.

All downloads are imported stopped; orphan targets return to wanted. Scheduler
and first-scan/import-review gates stay disabled. Legacy public work keys remain
unchanged. Catalog rows sharing a public key collapse to one Work; provider
identity conflicts stay suggested. The report lists old/new table counts and
explicitly retained/dropped facts, without credentials.

After a successful conversion, a repeat invocation is a no-op. An interrupted
conversion without its completion marker refuses an existing destination rather
than guessing which effects completed; preserve it for investigation and use a
fresh destination.

## Current limits

This is a rehearsal tool, not approved for live cutover. Multi-item request
settlement, nonempty legacy deletion recovery, release-hint/provider-detail cache
adoption, browse-rail order, full manifest enrichment and unusual legacy settings
shapes need further verification. Staged v1 torrents are piece-hash checked before
copying into the mapped final directory, then SHA-256 checked. Partial/mismatched
payloads remain untouched. Complete hash-valid payloads move only inside the
explicitly mapped copied root. Every move has a Store FileOperation and destination
SHA-256 check; an existing conflicting file is never overwritten.
The report distinguishes these cases; successful schema import is not proof that
all old media is available.

Real-data rehearsal evidence is in gitignored `tools\.convert-proof\`.
