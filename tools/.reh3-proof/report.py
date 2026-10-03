import json
from pathlib import Path

p = Path(__file__).parent
read = lambda name: json.loads((p / name).read_text())
accounting = read("accounting.json")
run = read("scheduler-result.json")
assert run["seconds"] >= 600
admission = read("owned-admission.json")
assert admission["countsUnchanged"]
assert len(admission["results"]) == 14
copies = read("payload-copy-digests.json")
process = read("process.json")
cleanup = read("cleanup.json")
bug = read("defect-episode-identity.json")["id"]
admission_bug = read("defect-owned-review-hold.json")["id"]
table = "\n".join(
    "| `"+r["file"]+"` | "+r["adopt2"]+" | "+r["state"]+" | "+
    (r.get("reason") or f'{r["title"]} S{r["season"]:02}E{r["episode"]:02}')+" |"
    for r in accounting)
engine_empty = all(not s["engine"]["torrents"] and not s["engine"]["diagnostics"]
                   for s in read("scheduler-samples.json"))
assert engine_empty
text = f"""# Phase 7.2 rehearsal rerun: stricter import and in-place admission

Date: 2026-10-03. Tracking: OPS-810 exists; its trailer is used as explicitly requested.
Rehearsed HEAD: `{process["head"]}`. No application code changed; no live cutover.

## Outcome

**25/25 videos accounted for: 12 retained downloaded + 2 adopted imported + 11 pending review.**
That is **14 owned, not 25 owned**. Every owned video has the correct title and season/episode
listed below. Ambiguous identity stays in review rather than being guessed.
Safety passed over ten minutes; the metadata identity and owned-admission defects below prevent
calling this a clean cutover gate.

| Metric | adopt2 | reh3 |
|---|---:|---:|
| Total videos | 25 | 25 |
| Retained downloaded videos | 12 | 12 |
| Newly adopted videos | 7 | 2 |
| Owned videos | 19 | 14 |
| Pending review videos | 6 | 11 |
| Legacy downloads retained | 30 | 30 |
| DownloadFile bindings | 12 | 12 |
| Targets during scheduler interval | 90 | 90 |
| Legacy requests | 0 | 0 |
| Legacy WatchItems / Follows | 2 / 2 | 2 / 2 |
| Legacy AutoRules | 0 | 0 |
| Physical engine rows / diagnostics | 0 / 0 | 0 / 0 |
| Converter FileOperations | 0 | 9 |
| Observation seconds | 300.502 | {run["seconds"]:.3f} |
| Complete periodic DB/engine samples | 56 | {run["samples"]} |
| New downloads during interval | 0 | 0 |

## Every difference explained

- Three **Killing Slimes S02E10/E11/E12** files moved from owned to review. The stricter matcher
  reports “The file name and folder name disagree. Pick the right title.” Each has one
  suggested TMDB 99073 episode, but the filename's `Ive` and folder's `I've` do not satisfy
  the matcher's exact normalized-name agreement. Suggestions are not ownership.
- **Rick and Morty S02E08 and S09E01** moved from owned to review. The new no-year uniqueness
  check reports “The catalog could not confirm a unique title without a year.” Provider
  identity errors were also reproduced (below); their causal contribution to this refusal is
  **not established**. Both files remain intact, with no invented episode claim.
- The original six reviews remain: Katainaka, both Practical Magic copies, Futurama,
  and Scorpion S04E04/E06. Digimon S01E42 and Reincarnated Slime S01E01 remain confidently owned.
  All twelve legacy downloaded identities remain owned.
- **Nine completed FileOperations instead of zero**: this run uses real byte copies, not adopt2's
  sparse zero-filled shadows. Converter verifies all torrent pieces for hashes
  `80cea3f9e60c8f6b0c920f8b7904a78495c950e8` (six files) and
  `c4f290a6d860058c7d8bc9408ee21bcf17a315a6` (three files), reconciles their
  **existing final paths**, and checks SHA-256. Source and destination paths are identical
  within the copy; no real library file was moved. The latter no longer appears as a missing
  copied payload. All other old/new converter table counts match adopt2 exactly.
- Both snapshots have the same old table counts and the same 76 file names/lengths
  (27,476,062,480 logical bytes). Snapshot database SHA differs; a freshly backed-up live
  database is not byte-identical to the earlier backup. No loss of legacy intent IDs or download hashes occurred.
- Raw ImportReview snapshots retain all 25 scan items. **14 durable decisions** remove
  twelve already-owned and two adopted items from the effective pending list, leaving eleven.
  There are two review rows (root scan and completion marker), not adopt2's four post-proof
  rows; this run did not perform adopt2's extra confirmation/dismissal scans.
  Adopt2's 21 final decisions included its nineteen ownership decisions and two manual decisions.
- Adopt2's final **91st Target** was its fresh Sintel intent submitted after its observation.
  Reh3 never submits a fresh/unowned download, so it retains 90 throughout and afterward.
- `GET /api/watchlist` now returns **four ready library titles**, derived from MediaFile, while
  preserving the two original WatchItems and two disabled Follows. The adopted titles do not
  create duplicate WatchItems. Adopt2 did not verify this read and explicitly left it as a follow-up.
- Observation is ten minutes instead of five. Unlike adopt2's post-start flag-bypass experiment,
  this run acknowledges legacy flags before startup; adoption then correctly sets
  `importReviewComplete=false` while eleven reviews remain. Scheduler itself stays enabled.
  This proves safe scheduler operation with unresolved reviews, not acquisition after their resolution.

## Isolation and commands

The live `D:\\code\\memtest\\stable\\data\\torrentflow.db` was opened read-only and backed up
through SQLite's backup API, including committed WAL changes. All side files/subdirectories
were copied into `D:\\code\\memtest\\reh3-data\\source`. Stable was never written.

Every file under the actual `D:\\Torrents` root was copied to
`D:\\code\\memtest\\reh3-data\\media`; there are no junctions/symlinks. Path-map conversion
rewrites the enrolled StorageRoot, MediaFiles, DownloadFiles, WorkFolders and FileOperations
to the copy. **59 operative absolute paths** were checked; all remain under reh3-data.
All thirty Download resume artifacts are null, and the external client is absent.
The host can mutate the isolated copy but has no configured write/move/delete destination
in the real media. Real roots were read only, never renamed, moved or deleted.

All **76 original/copy SHA-256 pairs match**; original sizes and mtimes stayed unchanged
during hashing. Supporting files are 27 PNGs, 13 NFOs, seven torrents, three text files and one
extensionless file. These are preserved artifacts, not 51 additional video ownership claims.
This is a real payload-copy proof, not sparse-media/container proof.

The requested `git worktree add D:\\code\\memtest\\wt-reh3 rebuild` refused because rebuild is
already checked out. Used `git worktree add --detach D:\\code\\memtest\\wt-reh3 HEAD`, pinned to
the recorded HEAD. API and Converter builds: **0 warnings, 0 errors**.

```powershell
dotnet build backend\\src\\Api\\Api.csproj -o D:\\code\\memtest\\bin-reh3
dotnet build backend\\tools\\Convert\\Convert.csproj -o D:\\code\\memtest\\bin-reh3-convert
dotnet D:\\code\\memtest\\bin-reh3-convert\\TorrentFlow.Convert.dll `
  --from D:\\code\\memtest\\reh3-data\\source `
  --to D:\\code\\memtest\\reh3-data\\converted `
  --path-map tools\\.reh3-proof\\path-map.json
dotnet D:\\code\\memtest\\bin-reh3\\TorrentFlow.dll --urls http://127.0.0.1:3965 `
  --TorrentFlow:DataDirectory D:\\code\\memtest\\reh3-data\\converted `
  --TorrentFlow:Scheduler:Disabled false --TorrentFlow:Scheduler:IntervalMinutes 1 `
  --background --no-browser
```

TMDB_API_KEY was supplied only through the child ProcessStartInfo environment, never persisted
or printed. Development environment exposes the read-only physical engine diagnostics.
Only proof HTTP port **3965** and the authorized Ops Tracker API **3960** were called.
The live server PID 3188/port 3930 was never called, stopped, restarted or reconfigured.

A preliminary sparse trial was discarded: the new runtime check correctly refused fake containers.
Its PIDs 10104/47608 were stopped before fresh conversion and the actual-copy run.
Final proof PID: **{process["pid"]}**. No preliminary interval is counted.
An initial nonexistent `/api/downloads` capture was replaced with the actual contract
`GET /api/client/torrents`, which returns all thirty torrents with no client issues.

## Ten-minute scheduler evidence and in-place admission

Scheduler enabled, one-minute hunter interval. Exact interval: **{run["seconds"]:.3f}s**,
**{run["samples"]} samples**, maximum sampling gap **{run["maximumGapSeconds"]:.3f}s**.
Every sample has zero physical torrents and zero engine diagnostics.
Download, DownloadFile, MediaFile, Target, Request, WatchItem, Follow, AutoRule, Attempt,
SearchCache, ReleaseObservation and durable review/decision counts and logical hashes remain
unchanged throughout the interval. Target states remain **12 done / 78 wanted**.
SearchCache is empty throughout, ReleaseObservation remains 282, and no acquisition attempt
or release selection appears. Catalog matching at startup is metadata lookup, not a release search.
Integrity is **ok**, with **zero FK failures**.

After the interval, **14 owned episode POST /api/title/{{workKey}} admissions** were exercised.
**Three pass** (Family Guy S01E01 and both newly adopted anime episodes): HTTP 200,
owned=1, queued=0. **Eleven fail** (all Rick and Morty S01E01-E11): HTTP 200,
ok=false, owned=0, queued=0, with the import-review refusal for unrelated ambiguous files of
the same work. Before/after acquisition counts are identical: no new Target, Download,
DownloadFile, MediaFile, SearchCache or ReleaseObservation.
No fresh title or request/rule was seeded. Failure is filed as {admission_bug}, not fixed.

Converter repetition says **Already converted. No changes made.** Every table's logical
hash/count remains unchanged, and the copied source database digest is unchanged.

## Defects filed, not fixed

**{bug}**, FEAT-35: fresh converted startup produces repeated
`SQLite Error 19: UNIQUE constraint failed: Episode.provider, Episode.providerEpisodeId`
during metadata Episode updates. Reproduced on the final real-copy run and captured in
`startup-errors.txt`. Host eventually starts and downloads remain readable; the conflict
is still a real metadata migration/reconciliation failure. Root cause is not claimed proven.
No code was changed to address it.

**{admission_bug}**, FEAT-35: the eleven already-owned Rick and Morty S1 episode actions
incorrectly return “A file on disk may already be this. Review it in Import first.”
The two unresolved Rick S02E08/S09E01 files hold the whole work, including episodes already
owned with verified coordinates. **Root confirmed**: TargetPipeline.AcceptAsync tests
`HoldsAsync(input.WorkKey)` and `HoldsAsync(work.Id)` before scoped `OwnedAsync`.
This remains safe from duplicate downloads, but violates the expected “Already in your library”
admission behavior. No fix or review resolution was made.

## Per-video accounting

| Relative path | adopt2 | reh3 | Identity or review reason |
|---|---|---|---|
{table}

## Coverage and limits

| Check | Result |
|---|---|
| All 30 download IDs and hashes retained | PASS |
| All 90 target IDs retained | PASS |
| Existing request/rule IDs retained | PASS, both populations empty |
| Both original WatchItem IDs and follow policies retained | PASS, both follows disabled |
| 25 videos present and exclusively owned or review-held | PASS |
| All 14 owned title/episode coordinates | PASS |
| All 76 real payload copies match source SHA-256 | PASS |
| Ten-minute enabled scheduler: no download/search acquisition | PASS |
| Four ready titles in library watchlist HTTP read | PASS |
| Fourteen owned admission actions do not create acquisition | PASS safety; 3 correct replies / 11 incorrect refusals ({admission_bug}) |
| Conversion idempotence and FK/integrity | PASS |
| Clean metadata startup with no identity errors | FAIL, {bug} |
| Nonempty requests/rules and enabled-follow automation | NOT EXERCISED: absent from live snapshot |
| Resolve the eleven reviews and then resume acquisition | NOT EXERCISED, deliberately no guessing |
| Live cutover, Jellyfin scan, playback and UI | NOT EXERCISED, outside read-only rehearsal |

## Cleanup and persistence

Final proof process stopped by literal PID {process["pid"]}; preliminary PIDs were also stopped
by literal PID. Copy, isolated worktree, API and Converter binaries were removed.
Cleanup verification: `{json.dumps(cleanup, sort_keys=True)}`.
Live PID 3188 remains alive.
Only `tools\\.reh3-proof\\` is staged and committed, with `Refs: OPS-810`; no Co-Authored-By.
No other worktree changes were staged.

Core evidence: accounting.json, lineage.json, payload-copy-digests.json, converter-count-comparison.json,
converter-report-diff.txt, converter-idempotence.json, scheduler-result.json, scheduler-samples.json,
owned-admission.json, owned-http.json, start/end HTTP captures, path-audit.json, process.json and cleanup.json.
"""
(p / "report.md").write_text(text, encoding="utf-8")
print("Report generated:", len(text), "characters.")
