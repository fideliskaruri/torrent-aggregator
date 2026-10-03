# Library placement and download filing

Library depends on **Domain only**. Placement chooses a validated enrolled root,
pins series folders, preserves the existing Jellyfin kind folders and sanitized
torrent leaf names, and reserves final/partial bindings. Existing final names are
never adopted or overwritten. A reserve-full root returns `No drive has space`.

`DownloadFiling` validates drained, hash-complete files, creates downloaded
`MediaFile` proposals, handles interrupted publication from its stored digest,
and deletes only the download's authorized paths after Engine drains. ISO,
Matroska/WebM and AVI media dimensions are read with bounded container-header
traversal, not ffmpeg. Resolution is derived
from those dimensions when available, otherwise from the release's declared
quality, **never from the requested quality**.

The Domain `IEngineFilePublisher` port safely rebinds and atomically renames each
file in its own final directory. MonoTorrent's public `MoveFileAsync` performs
both operations together, so Engine performs that physical rename on Library's
chosen paths rather than Library issuing an unsafe second rename. The remaining
pack files stay attached and continue after acknowledgement.

Store's Library download capability persists bindings, pins, rename intent and
source/destination claims. It commits a filed binding, downloaded inventory, item
completion and operation completion together. A crash after rename but before
inventory is recovered only when the final file matches the recorded digest.
Identical source/final paths reserve one physical claim. Hash-verified external
files publish without a move or rename; pending in-place publication is recovered
from that same recorded digest before inventory and Targets completion commit.
The rebound final is never turned back into a `.partial` or re-downloaded.
Unselected shared boundary fragments remain in hidden `.unwanted/<hash>` with
`.ignore`; they are not visible to the simulated Jellyfin scan.

`Api\DevFiling.cs` is isolated development-only composition, not the future Targets
worker: it wires Domain ports, exposes owner-loopback `/api/dev/filing`, and drives
the same real Engine and Library against SQLite. `/api/dev/library/owned/{workId}`
shows each filed video immediately. Removal waits for its ordered filing operation,
drains the hash, removes partials and unchanged owned finals, and prunes the hidden
fragments. An external final that appeared during a collision is left alone.

## Legacy library actions

Owner-only `GET /api/library/delete` previews a `watchListItemId` and `scope`
(`show`, `season`, or `episode`). `POST` accepts the same scope and requires
`confirm: true`. Library builds the exact plan from target/file/media identity,
not release-name guesses. API removal delegates to Targets' public removal and
download-file deletion APIs, which drain Engine before Library unlinks files.
Counts include known partial siblings and the exact download's unwanted subtree.
Recorded sidecars are digest-checked too. Empty-folder pruning only walks the
removed files' ancestor chains, never recursively prunes other titles or a root.
Already-cleared download bindings do not create phantom preview releases.

`POST /api/library/ondemand` resolves a watch item, work key, or title and queues
the existing Targets acquisition action. The response reports its actual queued
and owned counts without claiming that bytes have started.

An explicitly replacing target whose video basename matches its current
binding reserves `<stem> [<replacement-hash8>]<extension>` and that path's
`.partial`. Unrelated collisions still fail. Engine's normal atomic publication
then completes the new file without overwriting or removing the old file.
Targets remains responsible for switching Current and retiring the fallback.

Removal includes imported/adopted MediaFiles without Download bindings. Exact
recorded videos and sidecars are digest-checked together before any unlink; only
those inventory rows and completed operations are removed. No wildcard sidecar
search or recursive title-tree deletion is used. A changed file refuses the
operation and leaves the video's bytes untouched.

`LibraryRead` composes the Library list at read time: watch intent is unioned with
works returned by the shared `ILibraryPlacement.OwnedAsync` query, deduplicated by
work. No WatchItem is created by import, adoption or filing. File-only entries use
a stable `library:<workId>` read identifier and the normal item shape, without an
origin field. Catalog title reads use that same ownership query. Removing an
owned entry through the watchlist action requires explicit `confirm=true` and
delegates to the existing Library removal flow before removing intent; a watch-only
entry removes only intent. An old "remove, keep files" request is refused rather
than deleting files under a promise to retain them.

The existing scoped `/api/library/delete` adapter still resolves persisted
WatchItems only. It needs to compose `LibraryRead` for file-only identifiers too;
that adapter and the web's removal copy are outside this lane's allowed files.

Library list watch chips are a read-time composition of the existing Jellyfin
reader, not local watch history. The list and title page use the same provider/path
matching and progress projection. A list reads one shared Jellyfin snapshot (paged
items plus NextUp), under one 1.5-second deadline for the entire batch. Disconnected,
unavailable and unmatched states omit `watchState` and `jellyfinNextUp`; no per-title
Jellyfin HTTP calls or persistent watch-state copies are created.

For a shared pack, the preview selects only the requested items' file indices.
Targets drains the manager through Engine's public API, retires those bindings to
unselected hidden boundary-fragment paths, removes their inventory and associations,
then recovers the same Download with the other files' existing paths and selection.
The pack briefly pauses for the drain; this is not a seamless native per-file
Engine drain. Other episodes retain their bytes and can finish normally.

OPS-822 is addressed by retiring intent before unlinking: affected Targets become
Removed, the whole Download becomes Stopped and is subsequently removed, and orphan
recovery cannot revive Removed targets. Development filing's recovery and the HTTP
delete composition share its existing gate so a stale recovery cannot recreate
files during removal. Requests with targets but no physical bytes also retire intent.
Targeted real HTTP evidence is in gitignored `tools\.tdel-proof\report.md`.
The previous web deletion proof at 390 and 1280 remains in `.libdel-proof`;
OPS-821 records
the missing film delete control and delayed post-deletion ownership refresh.

Evidence: gitignored `tools\.libdel-proof\`, port 3970, copied/converted stable
database in `D:\code\memtest\rebuild-libdel`. Full licensed Sintel/Big Buck Bunny
copies exercise film, episode and season layout; synthetic episode identities
do not imply that Blender published a television series.

## Folder import

`MediaImport` composes the Domain Parser, Metadata, inventory and placement ports.
It does not depend on Engine or Targets. `Api\ImportEndpoints.cs` contains only HTTP
composition and bounded background scan handles. Completed reviews and per-file
confirm/dismiss decisions are persisted in Store, including paths, candidates,
parse evidence and duplicate groups. The existing
captured `/api/settings/download-recovery/sources` contract imports external torrent
clients, not folders; its wire shape is unchanged.

External-client recovery composes Engine's read-only `ExternalDownloadScanner`
(qBittorrent BT_backup and Transmission torrent/resume formats) with Library's
`ExternalMediaAdoption`. The format adapter lives under Engine because MonoTorrent
already owns bencoded torrent decoding there; Library retains its Domain-only
dependency and receives exact physical paths, never torrent/release identity guesses.
`TorrentFlow:ExternalDownloadScan:ScanRoot` overrides discovery for isolated fixtures.
GET reads source files without changing them; POST rescans selected stable IDs, checks
the acknowledgement and adopts complete video payloads through the same Metadata,
runtime and durable-review flow as folder import, with `MediaOrigin.Adopted`.
Only the torrent's exact video files are scanned, not unrelated files in its save folder.
MediaFile remains the ownership truth; no WatchItem or duplicate Download is created.
Ambiguous matches enter the existing `adoption:external:*` review and acquisition hold.
Empty acknowledged selections retain the 200 no-op response.

Unfinished handover uses Targets' public `AdmitExternalAsync` port with full
hash-bound torrent bytes, indexed original paths and explicit Metadata-confirmed
item picks. Library's existing Import review validates the picks, including
truncated containers without readable duration. Targets atomically commits a
Store-issued original-path placement proposal with Download, Target, Current
associations and the existing confirmed Import decisions, then Engine rechecks the existing bytes before running or remaining
paused. Filing consumes the normal Library proposal without moving, renaming or
deleting the original payload. The recovery POST accepts optional `selections`
(`sourceId`, `fileIndex`, `workId`, `episodeId`) and `paused`, retaining its existing
count/error response. No inventory is created until bytes pass the real torrent
hash check and filing completes. Repeated sources reuse the existing Download.
Complete payload adoption still does not start or seed a transfer. Continued
seeding and metadata-less handover are not supported; missing full metadata is
reported as a scan warning with export guidance, never guessed from a release name.

All new routes are owner-only, including reads containing paths:

| Method | Route | Body / response |
|---|---|---|
| POST | `/api/library/imports/scan` | `{"path":"D:\\Media"}`; 202 `{scanId,state}` immediately |
| GET | `/api/library/imports/{scanId}` | `state`, `total`, `scanned`, `items`, `confident`, `needsPick`, `unmatched`, `duplicates`, optional `error` |
| GET | `/api/library/imports` | Pending persisted scan IDs, paths, states and counts |
| POST | `/api/library/imports/{scanId}/dismiss` | `{itemIds:["id"]}` explicitly leaves those files alone and releases their review |
| POST | `/api/library/imports/{scanId}/confirm` | `{mode:"TrackInPlace"|"Move"|"Copy",rootId?,items:[{itemId,workId,episodeId?}]}` |
| GET | `/api/library/imports/operations` | Interrupted operation paths, stages and reasons needing review |
| POST | `/api/library/roots/{rootId}/rescan` | Present/offline/missing/dropped counts and drive status |
| GET | `/api/library/owned/{workId}` | Existing have-it projection; optional `episodeId` / `film=true` |

Review items retain separate filename/ancestor parse evidence, parsed quality,
candidate work and exact episode IDs, sidecars, and an already-owned marker.
`ImportReviews.CandidatesAsync` exposes the effective pending items for a canonical
work through the existing review port, retaining their candidate identities and
parse evidence. It creates no persisted hold or ownership rows. Targets owns the
one admission rule: ownership first, then candidate episode/film scope; a missing
candidate episode mapping can still be scoped by the recorded filename coordinates.
Only a known-work item without either identity or coordinate evidence is work-wide.
Duplicate keys group all locations of the same film/episode; confirmation rejects
selecting two of them. A missing episode mapping requires an explicit valid catalog
episode pick. Unmatched files may also be explicitly assigned at confirmation.
The scan root itself is not ordinary title evidence (a folder named `Incoming`
must not turn unknown files into the film of that name). For bare numbered videos
under `Season N`, a named-series scan root can supply the series name; the catalog
still has to confirm that series and its exact episode. Junctions are never followed.
Video extensions are removed before parsing title evidence, with the original
filename retained for review. Ambiguous film names offer the catalog's top picks
instead of being marked unmatched. Without year evidence, confidence requires a
complete catalog search with exactly one exact-name work of the requested kind.
Filename and non-container ancestor titles are resolved independently; disagreement
or an ancestor that does not match the chosen work's names requires a pick.
Bare `01`/`E01` filenames in a named series' `Season N` folder reuse the folder's
season and the catalog's confirmed episode map.
Destination collisions report import-specific guidance without changing download messages.

Confidence also requires a readable video duration and catalog runtime. Film
duration must be within the larger of 25% or 20 minutes of the catalog runtime;
episodes must be within 50% of their exact episode runtime. The existing bounded
ISO media reader reads MP4/MOV dimensions and duration together. Matroska/WebM
reads Segment Info Duration (four- or eight-byte float) with TimecodeScale,
defaulting to 1,000,000 ns, and video Track dimensions. Unknown-sized Segments
are bounded by the file; traversal stops after Info and Tracks or at the first
Cluster, skips payloads by seeking, and shares a 4,096-element header budget.
AVI reads `avih` frame timing, frame count and dimensions from the RIFF header.
No external executable is invoked. Unsupported, absent or invalid duration or
catalog runtime leaves the file NeedsPick and prevents automatic adoption.
Details are read once per unchanged file in a scan
and reused by adoption; explicit confirmation reads and stores current dimensions
and runtime on MediaFile. Neither ffmpeg nor ffprobe is a production dependency.

Nothing writes files or inventory before confirmation. Track-in-place retains the
source path, with a null root outside enrolled roots. Move and copy reuse placement,
including existing title pins, Jellyfin kind/season folders and sidecar names.
Original basenames are retained as required by design 1.5. No destination is overwritten.
Every selected video must have a recognized container signature.
The signature atom is shared with download filing; AVI, ASF and transport-stream
fixtures are covered, and renamed WAV/audio and executable headers are refused.

Verification uses **full SHA-256**, not sampled hashes: import is explicit and runs
outside the instant scan acknowledgement, so the additional sequential reads are
worth eliminating a sampling blind spot. Size, source mtime and non-link ancestry
are checked too. Copies use exclusive `.partial` creation, durable flush, verified
atomic publication, and another final digest before inventory commit. All video and
sidecar rows for an item commit together with its operation stages; only then may a
move delete digest-verified originals. Copy never counts its retained source as a
second inventory file. Imported origin is internal only; the shared have-it query
immediately exposes the same quality/ownership as downloaded media.

SQLite FileOperation/FilePathClaim rows protect both ends across concurrent calls
and survive interruptions. Completed operation references are released so they
cannot prevent the 30-day missing-file expiry. Completed scan proposals survive restart. Confirmed and dismissed items leave the
pending projection, with decisions retained for audit. Interrupted scans are shown
as failed and can be scanned again; an interrupted operation is left for explicit path review rather than guessed or
destructively replayed. Automatic recovery of pre-inventory proposals is not
implemented here; the operations read endpoint exposes that limitation honestly.

After conversion, Api composes the same Parser/Metadata import scan over enrolled
roots before background workers start. `MediaImport.AdoptAsync` records confident,
unchanged files in place using stat, name and duration evidence, without moving,
renaming or deleting them. It reads bounded native container metadata,
not a full payload digest. This is identity adoption, not full digest verification.
Already-tracked physical paths are retained; ambiguous and unmatched files become
durable reviews. Per-root and completion markers make startup replay idempotent.
The completion marker acknowledges the first full scan. Store keeps the existing
scheduler's import-review flag in sync with outstanding adoption decisions,
without enabling the scheduler itself.
Scanning the same root through the existing Import screen reopens its pending
adoption review instead of creating another proposal. The pending-list endpoint
also lets a UI discover review IDs without rescanning.

Root reconciliation reuses marker/volume identity and mass-vanish protection.
Incomplete or offline scans mark files offline and cannot confirm missing files.
A missing file stays owned until a second complete scan at least six hours later;
only confirmed missing rows older than 30 days can be pruned. Returning files clear
both missing timestamps. Offline rows are never pruned.

The gitignored import proof is `tools\.import-proof\summary.json`, using copied
licensed Blender videos plus explicitly synthetic release-named video fixtures.
It owns only port 3946 and `D:\code\memtest\rebuild-import`.

## HTTP integration proof

`tools\.filing-proof\summary.json` is intentionally gitignored. The proof uses
unmodified full **Sintel** and **Big Buck Bunny**, Blender Foundation CC BY 3.0
WebTorrent originals, in a genuine locally seeded four-file BitTorrent pack
(two videos selected, extras skipped). Synthetic episode identities exercise TV
layout; they do not claim Blender published a TV series. A second licensed torrent
proves the actual `Movies\Sintel (2010)\Sintel.mp4` filename.

Evidence covers final-directory partials, first-file ownership while another file
downloads, a directory walk ignoring `.partial` and hidden paths, crash replay with
unchanged SHA-256 and continued bytes, in-progress and completed removal, collision
refusal, reserve-full waiting, actual file size/resolution, and a zero-warning build.
The proof owns only port 3946 and `D:\code\memtest\rebuild-filing`. Its seeder, server
and proof helpers are stopped by their recorded literal PIDs. It never accesses
3930, 3948 or the stable data directory.
