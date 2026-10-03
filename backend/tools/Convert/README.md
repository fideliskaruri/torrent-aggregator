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
Every watchlist follow, including disabled ones, retains its monitoring policy.
New-only follows retain `newEpisodesSince` (falling back to creation time if absent);
ongoing follows use the Unix epoch cutoff. A stored cursor takes precedence over the
original start season/episode and becomes the stable `fromEpisodeId`.

After a successful conversion, a repeat invocation checks the immutable backup
digest and is a no-op. A durable start marker is written before backup/import;
the completion marker is published by an atomic rename after commit and integrity
checks. Any interrupted destination is refused, even if the database was not
created yet. The API also refuses incomplete conversion directories.

Preserve an interrupted destination for investigation. Restart with a **fresh
destination and fresh payload copies**, not the copied root a killed conversion
may have partly changed. The source database and source side files are never
written. Path-map roots are canonicalized and cannot overlap source data,
destination data, original payload roots or LocalApplicationData.

Season selections accept the legacy comma-separated representation and JSON
arrays. Each old request remains one Request with separate RequestItems for
every known target in scope. Fulfilled high-water marks remain fulfilled;
explicit removals and missing items below covered marks remain stopped by the
owner, with removed Target tombstones where needed. Partial/failed approved
requests retain their approval, not a new pending decision.

Pending EngineDeletion rows reconcile only exact files inside mapped copied
roots, with completed Delete FileOperations. A newer active transfer with the
same hash supersedes its stale deletion. Detach-only deletions retain files for
explicit import review. Removed targets cannot become Done merely because a
retained file exists. Shared file claims or removing transfers without a deletion
manifest fail closed for review rather than guessing at directory ownership.

## Rollback

1. Stop only the new proof server by its recorded PID. Never reuse its Store with
   the old server.
2. Keep the old server binary, original database, side files and payloads.
   Rehearsal modifies only separate mapped payload copies, so the original old
   data needs no inverse migration or restoration.
3. Do not point the old server at converted data or at the payload copy altered
   by rehearsal. For isolated rollback tests use another fresh old-data and
   payload copy, with every absolute path reviewed and mapped away from originals.
4. Before any live rollback, fence old layout tidy, promotion, same-size
   replacement and deletion cleanup. If no verified disable switch exists,
   quarantine post-cutover files using their exact paths/digests before old
   startup. Never start a second old server against live roots to test this.

The edges proof establishes source immutability, killed-transaction rollback and
restart refusal. It does **not** certify old-server startup with its cleanup
fence or live rollback; these remain an owner-supervised cutover gate.

## Current limits

This is a rehearsal tool, not approved for live cutover. Release-hint/provider-detail cache
adoption, browse-rail order, full manifest enrichment and unusual legacy settings
shapes need further verification. Staged v1 torrents are piece-hash checked before
copying into the mapped final directory, then SHA-256 checked. Partial/mismatched
payloads remain untouched. Complete hash-valid payloads move only inside the
explicitly mapped copied root. Every move has a Store FileOperation and destination
SHA-256 check; an existing conflicting file is never overwritten.
The report distinguishes these cases; successful schema import is not proof that
all old media is available.

Real-data rehearsal evidence is in gitignored `tools\.convert-proof\`.
`edges\` contains the killed-process proof and request/deletion HTTP/count proofs.
The stable snapshot contains zero MediaRequest and EngineDeletion rows; nonempty
cases are explicitly seeded into that real database copy using its actual target
coordinates. They are not presented as existing live requests or deletions.
