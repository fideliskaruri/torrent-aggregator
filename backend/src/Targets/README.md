# Targets

Targets skip items already recorded in the Library. The first full root scan and
scheduler enablement remain required before automatic downloads can run.

`TargetPipeline` owns accepted item intent and the bounded `PipelineWorker`. Its project
references are exactly Domain, Find, Check, Plan, Engine, Library, Metadata and Store.
HTTP performs validation and authorization only. `DiscoveryPlan` is the shared checked
Find -> Check -> Plan composition used by the worker.


Open a title first so its identity is in Metadata's catalog. Acquire reads the Library
have-it set and stores only missing film/episode targets, with counts. Repeated clicks
reuse deterministic item IDs. Confirmed seasons use one season pool and plan; unresolved
season/episode scope intent is persisted and expanded only after confirmed Metadata.
Owner/request season acquisitions refresh Metadata before enumerating episodes, including
nonempty converted listings. An incomplete refresh keeps the scope pending rather than
closing it over a stale subset. Automatic episode acceptance keeps its caller's follow
selection and never expands to the season's back catalogue. Verified provider aliases
use Metadata's canonical identity for both acquisition and pending Wanted actions.
Public title keys accompanied by provider hints use the same canonical acceptance:
`POST /api/title/sintel-2010` with `provider: tmdb`, `providerId: 45745` and
`mediaType: movie` queues the resolved Sintel film (OPS-810), not a second slug identity.
Target and pending-scope audio policies resolve work preferences before the global quality
setting: `auto` means Japanese for anime and English otherwise; `english` means English;
`any` is retained as an explicit policy.
Repeated acquisition updates changed audio policies without reporting new queued items.
Plan treats `any` as an explicit exemption from release-name and selected-file language
rejection; English and other explicit language policies retain their normal gates.
Queued counts include only newly accepted or explicitly revived intent. An identical
repeat keeps the same target and returns `queued: 0`, `Already queued`.
Pending scopes support Wanted Remove/Try now through Targets. Remove is a durable
Cancelled tombstone; explicit acquisition can revive it. Materialization rechecks the
scope version under the same action lock so cancellation cannot create late targets.

Follow start policy is shared by the watchlist and direct Follow adapters. A new follow
without a start episode means new episodes only, with the acceptance timestamp as its
cutoff. Ongoing follows use the Unix epoch cutoff and a stable start Episode ID; hunter
compares season/episode coordinates, not air-date ordering. Repeated saves retain the
new-episode cutoff. The worker admits at most `TorrentFlow:Targets:MaximumScopes` film/season scopes
(default 8, maximum 8), using FIFO target creation order with Download now first. Waiting targets retain their reason,
retry time, chosen hash where applicable and immutable last plan history. They are not
searched again until due or explicitly retried. Source/check retry timing follows the
release-age schedule in design 1.4. There is no separate progress cache.

Bounded discovery records its stopping decision in immutable Attempt history, not
a second verdict or plan cache. An unchanged scope, policy, source pool and valid
Check evidence reuse that decision until the release-calendar retry deadline
(bounded by the source-cache window and verdict expiry). Plan still runs against
the current Check verdicts. Unfinished/cancelled hashes remain unchecked; a warm
read does not refill their submission budget. Changed metadata, item policy,
owned inventory, exclusions, source pool or verdict evidence invalidates reuse.
This stopping boundary is shared by the worker and survives process restart (OPS-751).

Selected Plan files pass through Library placement and Engine admission. Fetching is
committed with its Download and Current associations under target CAS. Filing waits for
every selected file of that item, including sidecars, to have all touching pieces
complete. Paused/removed associations are retired and callbacks are fenced. Startup
requeues interrupted discovery leases and restores durable engine bindings; a committed
download without bindings is treated as an orphan, not blindly started. Admission queue
composition always reads the full Target catalog, not just the admitted work. Discovery
claims compare the captured target version under the state lock, so overlapping owner
and periodic scope flights cannot claim a target already claimed or admitted by another
flight.

## Current integration boundary

Library filing returns an opaque, Store-issued inventory proposal. Targets alone authors
the target state and commits that proposal, the target version CAS and filing history in
one Store transaction. The standalone Library filing harness no longer writes Target state.

The queue is FIFO by target creation time. Download now is the only override; those
targets run first in the order Download now was pressed. `ExpectedAt` comes from Metadata;
release retries run at five minutes around release, then 15 minutes, one hour, six hours
and one day as the release ages. File/drive/cap retries retain their short recovery delay.

Targeted real HTTP evidence is in gitignored `tools\.targets-proof\finish-summary.json`.
No unit tests or full hard-set reruns are required for this slice.

## Find another and recovery

`POST /api/downloads/{transferId}/find-another` marks the current release blocked for
the affected target, detaches and removes the current download and its partial files,
then returns the target to Wanted so the normal pipeline can select another release.
Automatic stall recovery uses the same behavior. Import review holds still apply.

`RecoverySettingsAsync` and `UpdateRecoverySettingsAsync` persist thresholds (default
180 seconds without metadata, 600 seconds below 1 MiB progress), enablement, maximum
automatic attempts (3) and backoff (3600 seconds). Existing Engine active-time signals
drive recovery; paused, queued and completed transfers do not accrue stalls.
The bounded worker routes a stalled download through Find another for its affected
target.

`RawDownloads` owns the raw admission, recovery, queue and completion lifecycle,
extracted from the development harness rather than duplicating it for production.
Owner-only `POST /api/torrent/send` validates the legacy input and delegates to it.
Library owns raw destination and payload paths; Engine resolves URL-only torrent
metadata with its existing public-address, redirect, size and timeout constraints.
Unidentified files retain their original names in `Downloads/{hash}` under a confirmed
root; Import can identify them without guessing a catalog identity at admission.
An empty selected-file set means all torrent files. Duplicate hashes reuse the
existing download. Failure rolls back raw/download intent and Engine ownership.
The legacy durable raw ID prefix remains readable; the development routes now
delegate this same service. Raw recovery and completion also run in production.
Completed raw files are published before intent is marked Done. Download actions
reuse the raw pause/resume, ordering and removal ports.

Licensed real HTTP evidence and scoped contract results are in
`tools\.aswap-proof\report.md`.

## Downloads HTTP adapter (4.5)

`Api/DownloadEndpoints.cs` projects the persisted downloads and per-file Engine snapshots
onto `/api/client/torrents`, `/api/wanted`, and `/api/settings/client`. Progress includes
already-filed files and never copies live counters into Store. `TargetSnapshot.Queue`
exposes the Targets-owned ordering for truthful queue positions. Target actions permit
removing completed intent while retaining Library files, and Try now dispatches a Wanted
target immediately. The cap update calls Engine directly and applies in both directions.
`GET /api/client/torrents` projects a shared season-pack download as one row per active target,
using `builtin:<40 hex hash>:<target id>` for target actions. Pause, resume, force and delete
resolve that target only; `deleteFiles` removes only its bound file indices. Bare hashes still
address the whole download.

Target-backed deletion supports `deleteFiles`, using Library's digest-checked, path-bounded
payload removal. Tidy reports the already-reserved final layout without moving active files;
Keep acknowledges an already-filed download. Wanted excludes targets represented by a
download, including failed admissions. Admission exceptions roll back bindings, associations
and download state before retrying. Failed admission persists Waiting with the original
Engine failure code/message (or the actual exception), a cleared admission lease and
choice, and a retry at least five minutes later. Its resume state is Wanted, never an
orphaned Fetching download, and the failed fetch attempt remains in history. Library media identity is based on its physical path,
so retaining a file and downloading the same hash to another root cannot collide on filing.
Readiness checks SettingsCatalog's required sections rather than a fixed section count.
This also fixes OPS-780: adding or changing the recovery section must not invalidate a
healthy migrated database. Fresh-instance proof changes recovery thresholds, checks
readiness five times, restarts, verifies the saved thresholds, and checks readiness five
more times (`tools\.dlapi-proof\finish\OPS-780-*.json`).

`TargetSnapshot.RawIntents` exposes the existing durable raw intent, not a second download
state. `RawActionAsync(id, Pause|Resume)` commits raw intent and Download intent together
before applying the derived Engine queue and run decision. `BulkActionAsync(Pause|Resume)`
includes unfinished catalog targets and raw intents; completed/review/removed items are
left alone and repeated actions are idempotent. Queue composition reads raw state too,
so initially paused raw admissions become eligible on Resume all. Desktop's tray and local,
owner-only `POST /api/desktop/downloads/pause|resume` call this one Targets action surface.
Real HTTP verified-byte stop/resume and initially-paused admission evidence is in
`tools\.tswap-proof\report.md` (OPS-769).

Remaining: external client UI finishing/seeding controls. External recovery import
adopts completed files or admits explicitly identified unfinished transfers.
Download recovery restores persisted Engine bindings; it does not import another client's
storage. Real HTTP and headless 1280/390 proof lives in `tools\.dlapi-proof\finish\`.

External unfinished handover (OPS-808) uses the public `AdmitExternalAsync` port:
full hash-bound torrent metadata, original indexed paths, confirmed catalog picks
and explicit paused/run intent. Engine caches verified metadata before admission
is committed, then rechecks existing bytes. A Store-issued placement proposal
commits original bindings, Download, Targets and Current associations atomically;
the confirmed Import decisions commit in that transaction too, so restart cannot
leave a handed-over transfer trapped behind its own review. Reservation failure
leaves no admission rows. A subsequent Engine-open failure retains the accepted
original bindings in Waiting (or Paused) for the existing recovery flow, without
unlinking the foreign payload.
Library/Store deduplicates identical source/final physical claims. Normal
transfer filing therefore commits inventory and Done in one version-fenced
transaction, with no second placement pipeline or synthetic watch intent.
Pending in-place filing replays only after its recorded digest matches.
A truncated container requires an explicit Import pick rather than speculative
ownership. Fresh HTTP recheck, finish, interrupted-filing restart and ordinary
Sintel regression evidence is in `tools\.eadm2-proof\report.md`.

## Library deletion

`DeleteLibraryAsync` consumes Library's exact preview. Whole-download deletion commits
Stopped download intent and Removed target state before draining Engine and unlinking
payloads; bindings, associations and the Download identity are then removed. Recovery
never changes an already Removed orphan target back to Wanted. A title without bytes
can still retire its accepted targets. Ordinary deletion never means "get again";
explicit acquisition is required to revive removed intent.

Shared-pack deletion drains Engine through its existing public detach API, deletes
only the scoped bindings/media, persists Library's unselected hidden fragment bindings,
and recovers the remaining selection under the same Download identity. This briefly
pauses the pack rather than adding an unsafe native per-file deletion implementation
inside Engine. Library supplies paths and Store performs snapshot-checked inventory
and binding changes; Targets supplies state and association changes. Development filing
serializes the HTTP composition with its existing recovery gate.

Licensed Sintel mid-transfer removal, three scheduler-enabled minutes without
re-admission, synthetic episode/season scopes over the free Blender pack, and
unbound import/sidecar deletion are recorded in gitignored `tools\.tdel-proof\report.md`.
