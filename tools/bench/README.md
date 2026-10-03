# Benchmarks

.NET 10, no packages. HTTP measurements have no server-project references and
interact with the application through HTTP only. The offline `parse` command has
the requested narrow exception: a reference to the pure Parser project and its
Domain contracts, never Api, Store, Metadata or Engine. Run from the repository root:

## Offline parser corpus

```powershell
dotnet run --project tools\bench -c Release -- parse --iterations 10 --stress --json tools\bench\results\parser-final.json
dotnet run --project tools\bench -c Release -- parse --name "Example S2 - 06 [1080p]"
dotnet run --project tools\bench -c Release -- parse --hash "0123456789ABCDEF0123456789ABCDEF01234567"
```

The default input is `backend\corpus\names.tsv`, discovered from the current
directory's repository ancestors. `--corpus file` selects another TSV with the
same column contract; `--iterations 1..1000` controls timed passes (default 10).
One untimed warmup precedes the timed parsing-only passes. Reported throughput
does not include input reading, comparisons, JSON writing or stress cases.

The six gate fields are **kind, seasons, episodes, resolution, foreign, unsafe**:
each requires at least 99.5% overall and exactly 100% on `labelled_by=hand`.
Coordinates compare semantic sets, preserving the distinction between seasonal
and absolute numbers and retaining invalid descending ranges. Year, source,
codec and group are additional diagnostics, not substitutes for gate accuracy.
The console prints the first 50 gate mismatches; optional JSON records all field
scores and mismatches, including provenance. `--stress` reports five adversarial
inputs up to the Parser's 16,384-character limit, outside the timed corpus run.

Exit **0** means the corpus gate passes, **1** means it fails, **2** means invalid
options or input. Inspection with `--name` or `--hash` is explicitly **not a gate
run**. Parsing performs no HTTP, payload acquisition, metadata lookup or database
access. Bench supplies UTC year + 2 as the deterministic Parser year cutoff.

The OPS-667 evidence in `results\parser-final.json` is deliberately **not green**:
seasons, episodes, resolution, foreign and unsafe are 100% overall and on hand
rows; kind is 98.586% overall and 99.712% hand, with 50 mismatches (five hand).
OPS-671 tracks the remaining scope/catalog-policy disagreement. The benchmark
returns 1 for this evidence; no failed rows are excluded.

## HTTP benchmark

```powershell
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline --search-only
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-sintel --only "Sintel" --wait-seconds 120
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-bunny --only "Big Buck Bunny" --wait-seconds 120
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-rick --only "Rick and Morty" --wait-seconds 120
```

`--titles file` replaces the fixed JSON title list. `--only` is an exact, case-insensitive English name. A series entry includes `season`; an anime film does not. Title IDs come from the server's title-search API, including its external-ID map. A Silent Voice uses TMDB **378064**: the baseline's first AniList result initially carried **1171702**, which its later TMDB result identifies as a different, 2017 work.

## Measurement

- Identity discovery: `GET /api/search/titles`, followed by the title and its extras. Match year, episodic/movie shape and TMDB ID or exact normalized English name; ambiguity fails closed.
- Release discovery: `GET /api/search?q=...&pageSize=100`, paging through the returned pool. `pool_size` is the API's total count, `pool_returned` is actually collected rows. The response uses the web's `TorrentResult` shape (`web/src/lib/torrents/types.ts`). It is **atomic JSON**, not a stream: first-result timing is the time the first nonempty response finishes. Empty searches have no first-result time. Catalog-search time is a separate column.
- Download: the exact title-page POST contract in `web/src/components/title/title-action-request.ts` and `title-detail.tsx`. Films use `scope: title`; seasons send the aired episode inventory with `scope: season`.
- Poll Downloads, Wanted and title progress once a second. "All targets" requires every expected target to have delivered bytes, completed, or show an actual visible wait reason, on two consecutive polls. Merely calling a row `downloading` at 0% with no bytes does **not** pass. Failed rows do not count as honest waiting.
- Capture every selected hash, name, source-pool listed seed count, connected peers/seeds when exposed, peak connections, first-byte time and sample age. CSV contains one title row and a JSON array of releases so episode-specific evidence is not lost.
- Duplicate counters are maximum excess rows with the same hash or target observed simultaneously, including replaced rows still present in the API list. A replaced row is labelled in release details; it is not counted as an active target.
- Language/CAM/program flags are deliberately obvious-name heuristics, not an audio-language verdict. Unknown language is not flagged. File payload extensions are checked if list rows expose a `files` array. Today's list API exposes neither file lists nor a separate connected-seed count; these are **unavailable**, not zero.
- Search runs before the grab and warms caches. These numbers describe a repeatable **search-then-download** journey, not a cold grab. Labels and summaries state that limitation.

## Safety and cleanup

- Only loopback HTTP on ports 3921–3940 is accepted; **3930 is always rejected**. No server is started or stopped. Redirects are disabled.
- Never run against a live data directory or concurrently with another mutating client.
- Refuse a full measurement if the scope has pre-existing downloads, wanted rows or acquisition state. This avoids deleting someone else's rows. Search-only remains safe on a populated copy.
- Non-free titles stop and pause at the first **observed** delivered bytes, then are removed. They do not wait 120 seconds if doing so would fetch the whole title. Polling is not a byte-perfect transfer cap; sample timestamps and early termination are explicit. Only the fixed Sintel/Big Buck Bunny/Tears of Steel name/year pairs with `freelyLicensed: true` may continue to completion.
- Before POST, persist `cleanup-pending.json`. In `finally`, cancel wanted work, delete each newly created matching download with `deleteFiles: true`, then verify Downloads, Wanted and title-progress are clear for three consecutive polls.
- Ctrl+C cancels measurement but **not cleanup**. A failed cleanup retains the journal and stops the run. The next invocation resumes cleanup against the same server before measuring anything. Do not delete the journal to suppress an error.
- API cleanup verifies remote rows/targets, not the server filesystem. Separately inspect the sandbox library for verification. The tool does not read, write or delete server files directly.

Outputs: `tools\bench\results\<label>-<yyyyMMdd-HHmm>.csv` and `.md`, updated after each title. Runs sharing the same label and minute replace those files; use distinct labels for repeated runs. Exit 0 means measurements ran, **not that downloads were healthy**: a stalled observation is valid evidence. Exit 1 means an API/identity/cleanup failure or overlapping-scope blocker; exit 2 is invalid arguments; Ctrl+C returns 130 after cleanup.

## Baseline verification (2026-10-03)

The sandbox initially contained **27 copied download rows**, including every Rick and Morty S1 episode marked downloaded, but an empty library. Those pre-existing rows are preserved. The requested Rick full run therefore safely reports **blocked**, rather than measuring existing "ready" claims or deleting copied downloads. A clean sandbox is needed for its genuine acquisition benchmark.

Initial 120-second runs: Sintel completed; Big Buck Bunny stayed at 0%, with 0 peers after a failed first release and a stalled replacement. Both had verified API cleanup. Inspect the produced Markdown/CSV for timing, hashes and seed evidence. `/api/downloads` is not the list endpoint (404); the web's list endpoint is `/api/client/torrents`.
