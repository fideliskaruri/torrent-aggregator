# Library placement and download filing

Library depends on **Domain only**. Placement chooses a validated enrolled root,
pins series folders, preserves the existing Jellyfin kind folders and sanitized
torrent leaf names, and reserves final/partial bindings. Existing final names are
never adopted or overwritten. A reserve-full root returns `No drive has space`.

`DownloadFiling` validates drained, hash-complete files, creates downloaded
`MediaFile` proposals, handles interrupted publication from its stored digest,
and deletes only the download's authorized paths after Engine drains. ISO media
dimensions are read with bounded box traversal, not ffmpeg. Resolution is derived
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

This bounded port does **not** unlink imported media without a Download binding,
or a narrow episode inside a shared download holding other episodes. Their plans
report blocked paths rather than guessing a wider deletion. General imported
removal needs a Store removal capability and shared-pack removal needs Targets'
per-file drain API; neither is bypassed by Library.

The actual incomplete-transfer proof exposed OPS-822: a binding-only DevFiling
download without target associations can recover its still-running Download
identity and recreate partials after public removal. Durable intent retirement
and recovery serialization require the Targets/Engine lane. This proof is not
claimed as passing. Web deletion was exercised at 390 and 1280; OPS-821 records
the missing film delete control and delayed post-deletion ownership refresh.

Evidence: gitignored `tools\.libdel-proof\`, port 3970, copied/converted stable
database in `D:\code\memtest\rebuild-libdel`. Full licensed Sintel/Big Buck Bunny
copies exercise film, episode and season layout; synthetic episode identities
do not imply that Blender published a television series.

## Folder import

`MediaImport` composes the Domain Parser, Metadata, inventory and placement ports.
It does not depend on Engine or Targets. `Api\ImportEndpoints.cs` contains only HTTP
composition and the bounded, session-local background scan handles. The existing
captured `/api/settings/download-recovery/sources` contract imports external torrent
clients, not folders; it is unchanged.

All new routes are owner-only, including reads containing paths:

| Method | Route | Body / response |
|---|---|---|
| POST | `/api/library/imports/scan` | `{"path":"D:\\Media"}`; 202 `{scanId,state}` immediately |
| GET | `/api/library/imports/{scanId}` | `state`, `total`, `scanned`, `items`, `confident`, `needsPick`, `unmatched`, `duplicates`, optional `error` |
| POST | `/api/library/imports/{scanId}/confirm` | `{mode:"TrackInPlace"|"Move"|"Copy",rootId?,items:[{itemId,workId,episodeId?}]}` |
| GET | `/api/library/imports/operations` | Interrupted operation paths, stages and reasons needing review |
| POST | `/api/library/roots/{rootId}/rescan` | Present/offline/missing/dropped counts and drive status |
| GET | `/api/library/owned/{workId}` | Existing have-it projection; optional `episodeId` / `film=true` |

Review items retain separate filename/ancestor parse evidence, parsed quality,
candidate work and exact episode IDs, sidecars, and an already-owned marker.
Duplicate keys group all locations of the same film/episode; confirmation rejects
selecting two of them. A missing episode mapping requires an explicit valid catalog
episode pick. Unmatched files may also be explicitly assigned at confirmation.
The scan root itself is not title evidence (a folder named `Incoming` must not turn
unknown files into the film of that name). Junctions are never followed.
Video extensions are removed before parsing title evidence, with the original
filename retained for review. Ambiguous film names offer the catalog's top picks
instead of being marked unmatched; unique matches retain their confidence.
Destination collisions report import-specific guidance without changing download messages.

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
cannot prevent the 30-day missing-file expiry. Scan proposals expire on restart;
an interrupted operation is left for explicit path review rather than guessed or
destructively replayed. Automatic recovery of pre-inventory proposals is not
implemented here; the operations read endpoint exposes that limitation honestly.

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
