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

The OPS-667 evidence in `results\parser-final.json` **passes all six gate fields
at 100% overall and hand**, with no rows excluded. OPS-671 resolved the earlier
scope disagreement: kinds are structural claims, while Plan verifies work
identity/eligibility. `backend\corpus\parser-kind-policy-corrections.tsv` audits
each changed label and repaired PowerShell-stringified note. Auxiliary year/group
diagnostics are still reported honestly, not counted as gate passes.

## HTTP benchmark

Any loopback HTTP sandbox port is allowed, including isolated ports 3962, 3963
and 3969. Live port 3930 is always forbidden.

```powershell
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline --search-only
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-sintel --only "Sintel" --wait-seconds 120
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-bunny --only "Big Buck Bunny" --wait-seconds 120
dotnet run --project tools\bench -- --base http://127.0.0.1:3931 --label baseline-rick --only "Rick and Morty" --wait-seconds 120
```

`--titles file` replaces the fixed JSON title list. `--only` is an exact, case-insensitive English name. A series entry includes `season`; an anime film does not. Title IDs come from the server's title-search API, including its external-ID map. A Silent Voice uses TMDB **378064**: the baseline's first AniList result initially carried **1171702**, which its later TMDB result identifies as a different, 2017 work.

## Measurement

- Identity discovery: `GET /api/search/titles`, followed by the title and its extras. Match year, episodic/movie shape and TMDB ID or exact normalized English name; ambiguity fails closed.
- Release discovery: `GET /api/dev/find?workKey=...&lane=owner` (plus `season` for series), using the rebuild's Find/Check/Plan diagnostic pool. The web calls `/api/search/titles`, not the retired `/api/search` release route. Both pool columns count returned candidates; there is no pagination. It is **atomic JSON**, not a stream: first-result timing is the time the first nonempty response finishes. Empty searches have no first-result time. Catalog-search time is separate. Checked-pool response latency is **not comparable** to the old unchecked `/api/search` first-result benchmark. This diagnostic requires Development mode.
- Download: the exact title-page POST contract in `web/src/components/title/title-action-request.ts` and `title-detail.tsx`. Films use `scope: title`; seasons send the aired episode inventory with `scope: season`.
- Poll Downloads, Wanted and title progress once a second. "All targets" requires every expected target to have delivered bytes, completed, or show an actual visible wait reason, on two consecutive polls. Merely calling a row `downloading` at 0% with no bytes does **not** pass. Failed rows do not count as honest waiting.
- Capture every selected hash, name, source-pool listed seed count, connected peers/seeds when exposed, peak connections, first-byte time and sample age. CSV contains one title row and a JSON array of releases so episode-specific evidence is not lost.
- Duplicate counters are maximum excess rows with the same hash or target observed simultaneously, including replaced rows still present in the API list. A replaced row is labelled in release details; it is not counted as an active target.
- Language/CAM/program flags are deliberately obvious-name heuristics, not an audio-language verdict. Unknown language is not flagged. File payload extensions are checked if list rows expose a `files` array. Today's list API exposes neither file lists nor a separate connected-seed count; these are **unavailable**, not zero.
- Search runs before the grab and warms caches. These numbers describe a repeatable **search-then-download** journey, not a cold grab. Labels and summaries state that limitation.

## Safety and cleanup

- Only loopback HTTP is accepted on any port except **3930, which is always rejected**. No server is started or stopped. Redirects are disabled.
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
# Checked dry-run planning (Phase 3.6)

```powershell
dotnet run --project tools\bench -- plan --base http://127.0.0.1:3948 --label devplan --repeat 2 --out tools\.devplan-proof
```

Runs the ten hard-set scopes (including Frieren season 1 and episode 5) through
`GET /api/dev/plan`. Writes one full JSON response per scope/run, an incremental CSV,
and a Markdown summary. Options: `--only "Frieren"`, `--quality 1080`,
`--quality-floor 720`, `--lane background`, `--exhaust`, `--repeat 1`, `--label`,
`--base` and `--out`. A repeat reuses source answers and persisted Check verdicts.
Waiting/uncovered scopes remain explicitly reported, not rounded up to successful plans.

The endpoint is development-only, trusted-loopback owner-only. Inputs are `workKey`
(or canonical `workId`), `kind` (`film`, `series`, `anime`), `scope` (`film`, `season`,
`episode`), `season`, `episode`, `preferredQuality` (default 1080), optional
`qualityFloor`, `lane` (`owner`/`background`), and optional `exhaust=true`.
An explicitly selected `preferredQuality` is also the minimum, following the owner's
quality-floor rule; `qualityFloor` can supply a separate owner's policy for diagnostics.
Films have no coordinates; series numbering must be confirmed by Metadata.

Find streams candidates while source searches continue. Api's temporary
`DiscoveryPlan` composition passes actual Plan feedback back to Find. Only complete
scope coverage by **Good**, gated releases at exact preferred resolution stops later
tiers. After the source sweep, Good at the best available eligible quality also stops
checks when no preferred-quality candidate exists. Weak/Unknown never stop discovery; Unknown is deferred
until all Find tiers permitted by the request cap have finished. `exhaust=true`
disables the coverage stop, not the probe/window bounds, for diagnosis. A healthy
English result prevents original/romaji-name searches; English fallback sources still
search uncovered gaps. The default `/api/dev/find` uses this same
composition; its manually supplied feedback mode remains available.

Responses contain monotonic first-candidate, first-verdict and plan-ready timings,
source HTTP counts and query/cache traces, candidate parses and trusted listed seeds,
Check metrics, assignments with target/file selections and reasons, and all Find/Plan
rejections. A null plan-ready means the scope is not fully covered. Candidate rows
whose targets were already covered are explicitly marked as not probed; their Unknown
placeholder is not a measured verdict. Probe submissions are hash-deduplicated, with
up to three outstanding equal-or-better-priority hashes per uncovered target and ten per owner scope (two for
background); Check still owns shared-flight and physical lane admission. New checks
wait for a completed source tier so early singleton listings cannot displace packs.
Within a quality tier, packs/multi-episode releases lead by trusted seeds, then singles
for gaps not covered by Good or a pending preferred pack.
Zero/unknown listed-seed candidates wait for the source sweep, rather than occupying
every slot before stronger later listings arrive; they are still checked when they
are all that exists. Higher-value later candidates can use the reserved owner slots
even when three lower-value multi-season probes are already in flight.

Each plan allows **24 new hash submissions** and a **54-second season check window**
(**28 seconds for films, 26 for single episodes**).
Twenty-four allows two full ten-slot owner tranches plus four gap checks rather than
hundreds of serial probes. The window leaves time for source completion and cleanup
within a 60-second cold-season target and 30-second film target; it is not proof of complete or Good coverage.
Good complete coverage cancels redundant outstanding checks immediately. Cached
verdicts do not consume the submission budget. `submissions` counts new Check jobs;
`probes` counts completed fresh measurements, excluding canceled redundant jobs.
All candidates remain in the response. Unknown is chosen only with safe mapped files
and no checked Good/Weak alternative for the item, and its reason explicitly reports
an exhausted probe budget/window and any unchecked alternatives. An uncovered plan
still has a null ready time. `stopReason` and `probeBudget` make the bound inspectable.

Core pagination cannot consume the whole source cap: up to half the owner's existing
12 requests (one-third of the background six) is reserved for enabled fallback
sources and one detail fetch. Fallback uses one scope-focused query per source
(`English show SNN` for a single season), leaving the broad English pool in Core.
This preserves a chance for useful packs rather than drowning them in other seasons'
singles. Every skipped/truncated source retains its real budget diagnostic.

No Download/Target rows are admitted, and no admission capability is retained.
Metadata, source caches, Release metadata and Verdict caches are the only permitted
persistence. Check releases probe capabilities and cleans bounded probe payloads
before returning. Real titles must never be fully downloaded by this command.

Baseline comparison uses Phase 0 `baseline-search-final-20261003-0509.csv`. Its
first-result metric is an atomic **unchecked search response**, not a checked plan,
so the summary keeps it separate from first-verdict and plan-ready.

Post-OPS-719 verification covered nine of the ten scopes. Frieren S1 remained
8/28: missing episode air dates prevent otherwise healthy season packs from
passing Plan's finished-season gate (OPS-727); redirecting anime torrent URLs
also remain Unknown (OPS-728). Complete coverage is not necessarily all-Good:
Money Heist includes an exhausted, safe-file Unknown assignment waiting for seeders.
Cold Prison Break and Money Heist planning took approximately 558 and 359 seconds;
their cached repeat HTTP responses took 1.53 and 2.25 seconds. Every repeat used
zero source HTTP requests and zero fresh probes. These are diagnostics, not a
claim that the Phase 3 performance/completeness gate passed.

Lookalike failures count wrong-work hashes that reach selected assignments, not
hashes correctly rejected by Plan. Scorpion King is additionally checked against
Find's candidate pool. Full run evidence is kept in gitignored
`tools\.devplan-proof`, including the corrected cold-run CSV/Markdown and the
hash-level lookalike audit.
