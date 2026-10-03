# Library reads and import confidence: OPS-843 / OPS-847

Code commit: **dbe6771**, on `rebuild`, with both issue trailers. No push.

## Isolation

The requested `git worktree add D:\code\memtest\wt-libread rebuild` refused because
`rebuild` was already checked out. A detached worktree at `8336cc3` was used instead.
Only changed owned source files were copied back and committed. HTTP proof used
**3964 only**, output `D:\code\memtest\bin-libread`, and fresh data
`D:\code\memtest\data-libread`. No live database or media directory was read.
The licensed seed was copied, never moved; its SHA-256 remained unchanged.
TMDB credentials were supplied to the child environment, never printed or committed.

The original and final Api builds succeeded with **0 warnings / 0 errors**.
`verify.ps1` drives a real running server and copied files, without mocks or unit
tests. Its final run passed all assertions. No web code or browser verification
was performed.

## Task A: ownership read, not intent synchronization

`LibraryRead` owns the read-time union of WatchItem intent and works returned by
the existing `ILibraryPlacement.OwnedAsync` query. It deduplicates by work and uses
the same item projection. File-only identifiers are `library:<workId>`; neither
the response nor its copy exposes origin. File-only entries do not infer watched
state and use the existing neutral planned status.

Catalog title and watchlist readiness now use the same have-it query. Import,
adoption and filing do **not** create or synchronize WatchItem rows. A PATCH of
an owned-only item is an explicit owner intent change, not automatic synchronization.

### Real HTTP evidence

| Case | Before | Final result |
|---|---|---|
| TrackInPlace full Sintel | MediaFile existed; `/api/watchlist` empty | Exactly one Sintel item, `ready=true` |
| Title read | `availability=ready`, but `library.inLibrary=false` | `availability=ready`, `library.inLibrary=true`, stable library ID |
| Automatic intent | No WatchItem | Still no WatchItem; `inventory-only.json` records count 0 |
| Stored media details | No runtime/dimensions from import | 1024×436, 480p, **888.064 seconds** |
| Owned + explicit WatchItem | Separate facts | Exactly one Library item; explicit watching status retained |
| Watch-only Big Buck Bunny removal | Intent item | Removed without touching the owned Sintel copy |
| Confirmed file-only removal | No file-only library identifier | Existing `LibraryRemoval` / `DevFiling` flow removes copied payload and inventory; Library empty; title ownership cleared |
| Confirmed owned + intent removal | Both facts present | Files and intent removed; Library empty, no reappearance |
| Unconfirmed old keep-files request | Legacy UI promises to retain bytes | HTTP 409; copied file and SHA-256 unchanged |

Final evidence: `verified-library.json`, `verified-title-owned.json`,
`verified-file-only-removed.json`, `verified-file-only-empty.json`,
`verified-title-cleared.json`, `verified-union-deduplicated.json`,
`verified-watch-only-removed.json`, `verified-owned-intent-removed.json`,
`verified-final-library.json`, `verified-unconfirmed-removal.json`.
Earlier unprefixed A captures are intermediate implementation evidence; the
`verified-*` captures supersede them.

### Remaining blocker: do not merge as a complete Library UI fix

**OPS-843 remains blocked.** The existing scoped delete adapter in
`backend\src\Api\LibraryEndpoints.cs` resolves only persisted WatchItems.
For a file-only `library:<workId>` identifier, the real
`GET /api/library/delete?...&scope=show` returned **404**. That file was explicitly
outside this lane's allowed edit list, so it was not modified.

The web also still labels its normal remove action **“Remove, keep files”** and
promises that nothing is deleted. Silently deleting files under that promise
would be unsafe. The confirmed HTTP watchlist action therefore requires
`confirm=true` for an item with inventory and uses the existing delete flow;
the old unconfirmed request is refused. The scoped adapter must compose
`LibraryRead`, and the UI must use the preview/confirm deletion flow and truthful
copy before this is declared a completed owner-visible removal journey.
No dummy WatchItem rows, Store intent projections or route-interception
workarounds were introduced.

## Task B: matcher evidence, OPS-847

Changes stay in Library, plus the allowed Import startup composition:

1. A yearless identity can be Confident only when `Metadata.SearchAsync` returns
   one exact-name work of that kind, with a complete, non-stale search, and the
   resolved unique identity is the chosen work. Ranking ties are irrelevant.
2. File and title-folder names resolve independently using their own years.
   Differing works, differing years, or names outside the chosen work's names
   require a pick. Real alternative candidates use durable catalog identities.
3. The existing bounded ISO reader now reads dimensions and movie duration.
   Other containers use optional `ffprobe` on PATH with an eight-second limit.
   Missing/unreadable duration or catalog runtime prevents Confident matching
   and automatic adoption. Film tolerance is max(25%, 20 minutes); an exact
   episode's tolerance is 50%. Details are cached per unchanged file within the
   importer and stored on MediaFile when explicitly added.
4. Bare `01` / `E02` names under `Season 1` take their season from the folder and
   map to confirmed catalog episodes. A selected named-series scan root also
   supplies the series name in this structural context; ordinary import roots
   remain excluded as title evidence.
5. An interrupted `adopting` scan is rescanned through the same matcher rather
   than trusting pre-change saved confidence.

### Before/after coverage

The original source was separately built from `8336cc3` to obtain focused
before captures against exactly the same fixture paths.

| Fixture | Original HTTP scan | Final HTTP scan |
|---|---|---|
| `Dune.mkv`, zero bytes, no year | NeedsPick already in this catalog response | NeedsPick; exact-name candidates |
| `Dune (2021).mkv`, zero bytes | **Confident** | NeedsPick: runtime unreadable |
| `Sintel\Dune (2021).mkv`, zero bytes | **Confident**, ignored folder | NeedsPick: disagreement; **Dune and Sintel** candidates |
| `Rick and Morty\Season 1\01.mkv`, zero bytes | Film candidates named “01” | Series candidate, **S1E1**, NeedsPick because duration unreadable |
| `Rick and Morty\Season 1\E02.mkv`, zero bytes | **Confident** | Series candidate, **S1E2**, NeedsPick because duration unreadable |
| Real Sintel bytes renamed `Dune (2021).mp4` | **Confident** | NeedsPick: **runtime does not fit** |
| Full licensed `Sintel.mp4`, no year | Confident | Confident, native duration read and persisted |
| Full licensed bytes named `Sintel (2010).mp4` | Not separately rerun before | Confident |
| Licensed-byte fixtures named `01.mp4` and `E02.mp4` in series/season folders | Not separately rerun before | Confident with exact **S1E1 / S1E2** IDs and plausible native duration |
| Same two files, selecting the named series root itself | Not separately rerun before | Confident with the same exact episode identities |

The episode-name fixtures contain licensed **Sintel** bytes, not copyrighted
Rick and Morty episodes. They exercise contextual identity and duration gates;
they are not claims about the content of that show.

Focused captures: `runtime-before.json`, `runtime-after.json`,
`dated-before.json`, `dated-after.json`, `disagreement-before.json`,
`verified-folder-disagreement.json`, `baseline-scan.json`,
`verified-matcher-cases.json`, `verified-runtime-rejected.json`,
`verified-bare-real-media.json`, `verified-named-series-root.json`,
`verified-dated-real-media.json`.

### Unproven / limits

- Neither `ffmpeg` nor `ffprobe` was on PATH. Requested tiny filename fixtures
  were therefore zero-length. An exact **22-minute** generated fixture and
  successful ffprobe execution were not exercised. The duration mismatch was
  instead proven with real **14.8-minute** Sintel media against Dune's much
  longer catalog runtime.
- The Dune no-year baseline already returned ambiguous in this run. It does not
  reproduce the unequal-top-score failure; the new invariant is directly
  independent of Metadata's scores, and the HTTP proof covers its safe ambiguous
  result plus the yearless unique Sintel positive.
- Native ISO duration and its missing-reader fallback were exercised; other
  containers with a working ffprobe, malformed/version-1 ISO timing, and catalog
  partial/stale branches were not separately exercised.
- A converted-host interrupted-adoption restart was not rerun. The restart change
  is a compile-checked composition of the same proven scan, not a claim of a new
  conversion rehearsal.
- No real downloaded-origin/engine-bound deletion or offline-drive simulation was
  rerun; their existing have-it/removal ports are reused.
- Independent coordinator critic remains pending. OPS-847 is in
  `needs_verification`, with real HTTP evidence recorded.

## Cleanup

Cleanup status is appended after stopping the final recorded proof PID and
removing the detached worktree, fresh data, binary outputs and fixture copies.
Foreign `tools/.gitignore` and Targets changes are not staged or modified.

**Completed at 21:54 +03:00**, inside the 35-minute limit. Final PID **32928** was
stopped by literal PID. All earlier successful proof server PIDs were confirmed
gone, and 3964 has no listener. The detached worktree, fresh data, binaries,
zero-byte fixtures and all licensed media copies were removed. Original seed is
unchanged. Live PID **3188** remains alive; its API and stable directory were never
accessed. Evidence and the verification script persist beside this report.
`verified-final-db.json` records WatchItem=0, MediaFile=0 and the catalog runtimes
(Sintel 14 minutes; Dune 2021 155 minutes) after the final removal assertions.
