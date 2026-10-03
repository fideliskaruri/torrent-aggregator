# Targets

## Switchover import review safety

`TargetAdmission` is the shared item admission read for owner, season, request,
follow/rule/hunter, worker, picker and recovery actions. It reads Library ownership
first: owned items are skipped and counted as already in the library. Pending
Import reviews then hold only the missing items they could represent. The hold is
computed from Library's durable review candidates and their recorded parse evidence,
not a second copied status store. Accepted automatic/request held intent remains
durable in Waiting, is not counted as queued, and becomes eligible when review ends.

An owner acquiring, resuming or trying a review-covered missing item is refused with:
`A file on disk may already be this. Review it in Import first.`
Explicit acquisitions for other items, including the same work, remain eligible.
Batch replies count queued, owned and held items separately; held items never
inflate queued counts. `TargetActionReply.Held` exposes the count and batch messages
retain it for existing HTTP adapters. Explicit owner acquisitions use the existing durable Now priority,
including retries, transfer filing and restart recovery. Worker claims and admission
recheck review state; confirmed inventory is committed before its review is released.
Dismissal explicitly releases a review without changing media. Known candidate
episode IDs/coordinates are exact constraints. If a candidate has no episode
mapping, filename episode/absolute/season evidence still constrains its scope.
Only a known-work review with neither an item identity nor usable coordinates holds
the whole work. An unmatched review with no candidate work cannot claim another
work. The first full root scan and scheduler enablement remain required; unresolved
reviews no longer impose a second, global automatic-download hold.

`TargetPipeline` owns accepted item intent and the bounded `PipelineWorker`. Its project
references are exactly Domain, Find, Check, Plan, Engine, Library, Metadata and Store.
HTTP performs validation and authorization only. `DiscoveryPlan` is the shared checked
Find -> Check -> Plan composition used by the worker and `/api/dev/plan`.

## Owned-item quality sweep (OPS-857)

Targets owns the quality sweep, not Library or the hunter's HTTP adapter.
The bounded worker schedules one film/season sweep at a time using the existing
Find/Check background lane and scope budget. It considers only Library-owned
items below their work/global preferred quality; it never acquires an item.
Confirmed episodes share a season discovery pool. All offers must pass the
normal Plan gates as Replace/Upgrade targets against current Library inventory
and have a fresh Good swarm verdict. Weak, unknown, blocked and rejected
releases never become upgrade offers.

`UpgradeEvidence` is the durable result, unique per film/episode. Positive
evidence expires with its Check verdict (normally six hours); a completed
negative search with a successful source expires after thirty minutes, matching
the source-cache window. A failed search cannot claim best available.
Preference changes invalidate either result, and a changed owned resolution
invalidates a negative result. Title reads do not search or probe: they compose
inventory and evidence, read the stored candidate via Find's selection port,
and rerun pure Plan against current Check evidence and policy. Seeder counts
come from Check/Find, not another copied counter.

Owner-only actions:

- `POST /api/title/{workKey}/check-again`, body `{}` for the title, or
  `{"season":1,"episode":2}` for an episode (`season` alone is supported).
  Runs discovery in the owner lane and returns `{items:[{episodeId,upgrade?,
  bestAvailable?}]}`. The title read remains the UI source of truth.
- `POST /api/title/{workKey}/upgrade`, same scope, returns the existing
  `TargetActionReply`. Only fresh gated offers create deterministic Replace
  targets with `replacementMode: upgrade`, the chosen hash and the old
  MediaFile ID. Repeated acceptance returns Already queued.

The existing one-Target-per-item database identity is retained: an existing
Acquire/history target becomes Replace, and its old Current association is
retired before a new Current is admitted. Acquiring again after file deletion
restores Acquire on that same item row. Filed fallback inventory is not removed
by the generic partial-swap cleanup.

The regular transfer path admits Replace targets even though the item is
owned; Acquire still skips it. Library's existing replacement placement and
filing are reused. The old video and recorded sidecars stay until the new
target is Done and its exact filed binding proves the better inventory file.
Only then does the existing digest-checked Library removal path retire the old
payload. A failed, paused or removed upgrade leaves the old file untouched;
failed cleanup retains it and retries without blocking unrelated downloads.
Store issues the same snapshot-checked removal proposal for both ordinary
removal and upgrade retirement. Targets commits clearing the old MediaFile
reference and deleting inventory/bindings in one transaction, so the restrictive
foreign key cannot leave an untracked payload or a permanently referenced row.

The additive catalog contract and real HTTP proof are described in
`tools\.upg-proof\report.md`. Upgrade-watch notifications are owned by the
separate hunter lane; this sweep never downloads automatically.

## Phase 4.2 HTTP proof surface

Development, trusted loopback owner only:

- `POST /api/dev/targets`: `{ "workKey": "tmdb:movie:45745" }`, or a series key
  with `season` and optional `episode`; optional `quality` is a hard floor.
- `GET /api/dev/targets`: persisted targets, scopes, transition/plan history,
  downloads and exact Engine snapshots. Reads never Find or Check.
- `DELETE /api/dev/targets/{escapedTargetId}`: durable removal accepted immediately;
  the worker drains/removes the engine download when no remaining target uses it.
  Library-owned finished files remain owned.
- `POST /api/dev/targets/{escapedTargetId}/pause`, `/resume`, `/try`: explicit
  state actions. Try immediately dispatches the shared Find/Check/Plan in the owner lane.
- `POST /api/dev/targets/{escapedTargetId}/now`: owner Download now, including
  request approval and the existing Engine concurrent-cap override.

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
`any` is retained as an explicit policy. Developer planning uses the same resolver.
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
new-episode cutoff. The converter preserves mode, cutoff and the current cursor,
including disabled follows.

The worker admits at most `TorrentFlow:Targets:MaximumScopes` film/season scopes
(default 8, maximum 8), using FIFO target creation order with Download now first.
Waiting targets retain their reason,
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
This stopping boundary is shared by the worker and development planning route
and survives process restart (OPS-751).

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

This is the task 4.2a development surface; legacy HTTP projection/routing is phase 4.5.
Library filing returns an opaque, Store-issued inventory proposal. Targets alone authors
the target state and commits that proposal, the target version CAS and filing history in
one Store transaction. The standalone Library filing harness no longer writes Target state.

The queue is FIFO by target creation time. Download now is the only override; those
targets run first in the order Download now was pressed. `ExpectedAt` comes from Metadata;
release retries run at five minutes around release, then 15 minutes, one hour, six hours
and one day as the release ages. File/drive/cap retries retain their short recovery delay.

Targeted real HTTP evidence is in gitignored `tools\.targets-proof\finish-summary.json`.
No unit tests or full hard-set reruns are required for this slice.

## Swap and recovery (4.4)

`FindAnotherAsync(targetId)` keeps Current while the shared Find/Check/Plan runs with
Current and active work/global blocks excluded. A complete checked replacement plan
admits all assignments together and proves 64 KiB hash-valid selected bytes for every
assigned target before one version-fenced Current switch. Only then is the old manager detached and its hash
blocked for this work for six hours. Old partials remain fallback bytes until replacement
filing completes, then exact recorded paths and bindings are removed. Failure or no
alternative keeps Current. Interrupted Replacement associations are cleaned on restart.

`RecoverySettingsAsync` and `UpdateRecoverySettingsAsync` persist thresholds (default
180 seconds without metadata, 600 seconds below 1 MiB progress), enablement, maximum
automatic attempts (3) and backoff (3600 seconds). Existing Engine active-time signals
drive recovery; paused, queued and completed transfers do not accrue stalls. Swap
Attempts record NoMetadata/NoProgress. The bounded worker launches one recovery per
download, replanning its still-fetching targets together.

Development proof routes: `POST /api/dev/targets/{id}/swap` and
`GET|PUT /api/dev/targets/recovery`. Production API composition can call these public
methods directly. Replacement claims last at most 90 seconds and borrow the active
Current download's logical cap slot. Both managers can overlap while proving bytes,
without a Now bypass or an extra logical slot; after detaching Current the replacement
uses its own normal slot. Store retires old associations before promoting replacements
inside the same transaction, preserving the filtered unique Current index regardless
of hash ordering.

Library alone reserves same-name replacement finals and their adjacent partials, using
the full replacement hash as the disambiguator. Targets never rewrites Library paths.
Filing completeness considers only the active download's bindings, not retired fallback
bindings for the same target. Failed grouped admission drains and rolls back every prepared
replacement without changing Current. A pack's old payload is retained until all replaced
targets are filed, including when the new plan splits the pack across multiple downloads.
After final retirement commits Download deletion, Targets calls Engine's
`IEngineRetirement.ForgetAsync` to release the old hash for a new identity.
Temporary detach deliberately retains ownership. Admission rollback, orphan
cleanup and whole-download deletion use that same final-retirement boundary.
Real licensed same-name, two-target pack, two-assignment split, rollback and only-candidate
HTTP evidence is in gitignored `tools\.tswap-proof\report.md`. Earlier single-assignment
Sintel HTTP evidence is in `tools\.swap-proof\finish`.
The fixture completes scheduler onboarding, uses magnets with local seeders (no private
HTTP metadata fetch), and clears persisted discovery caches before restarting.

The owner-only GET/POST `/api/client/torrents/{hash}/alternatives` and POST
`/api/downloads/{transferId}/find-another` compose these same ports.
`AlternativesAsync` and `ReplaceAsync` share recovery's Find/Check/Plan composition.
A manual token restricts the candidate hash without changing persisted target intent;
a site choice passes through Find's source filter and its discovery-stop identity.
Both exclude Current and active blocks before checking, including a one-result pool.
Tokens are protected, current-hash-bound and expire after ten minutes. GET releases
retained probe capabilities; POST checks evidence again before admission. Manual
replacement does not require the background scheduler to be enabled. Import review
holds still apply; automatic recovery retains the scheduler gate.

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
