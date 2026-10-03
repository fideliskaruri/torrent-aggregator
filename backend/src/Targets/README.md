# Targets

`TargetPipeline` owns accepted item intent and the bounded `PipelineWorker`. Its project
references are exactly Domain, Find, Check, Plan, Engine, Library, Metadata and Store.
HTTP performs validation and authorization only. `DiscoveryPlan` is the shared checked
Find -> Check -> Plan composition used by the worker and `/api/dev/plan`.

## Phase 4.2 HTTP proof surface

Development, trusted loopback owner only:

- `POST /api/dev/targets`: `{ "workKey": "tmdb:movie:45745" }`, or a series key
  with `season` and optional `episode`; optional `quality` is a hard floor,
  optional `rank` is persisted owner ordering.
- `GET /api/dev/targets`: persisted targets, scopes, transition/plan history,
  downloads and exact Engine snapshots. Reads never Find or Check.
- `DELETE /api/dev/targets/{escapedTargetId}`: durable removal accepted immediately;
  the worker drains/removes the engine download when no remaining target uses it.
  Library-owned finished files remain owned.
- `POST /api/dev/targets/{escapedTargetId}/pause`, `/resume`, `/try`: explicit
  state actions. Try immediately dispatches the shared Find/Check/Plan in the owner lane.
- `POST /api/dev/targets/{escapedTargetId}/now`: owner Download now, including
  request approval and the existing Engine concurrent-cap override.
- `PUT /api/dev/targets/rank`: `{ "targetIds": ["first", "second"] }` ranks
  those targets first, preserving the relative order of other ranked targets. The same
  priority/rank order chooses discovery scopes and Engine slots.

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
(default 8, maximum 8), preserving owner rank. Waiting targets retain their reason,
retry time, chosen hash where applicable and immutable last plan history. They are not
searched again until due or explicitly retried. Source/check retry timing follows the
release-age schedule in design 1.4. There is no separate progress cache.

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

Dynamic priority is persisted and refreshed as dates age: owner now, owner rank, fresh
episode (six hours before through 48 hours after air time), request, back catalogue,
upgrade/watch. Rank orders targets within a priority. `ExpectedAt` comes from Metadata;
release retries run at five minutes around release, then 15 minutes, one hour, six hours
and one day as the release ages. File/drive/cap retries retain their short recovery delay.

Targeted real HTTP evidence is in gitignored `tools\.targets-proof\finish-summary.json`.
No unit tests or full hard-set reruns are required for this slice.

## Swap and recovery (4.4)

`FindAnotherAsync(targetId)` keeps Current while the shared Find/Check/Plan runs with
Current and active work/global blocks excluded. A checked single replacement assignment
uses distinct partial paths, starts and proves 64 KiB hash-valid selected bytes before
the version-fenced Current switch. Only then is the old manager detached and its hash
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

Multi-assignment pack replacements and same-destination-name Library placement remain
follow-up work (OPS-787); those cases keep Current rather than discard it. Real licensed
Sintel HTTP evidence and a zero-warning build are in gitignored `tools\.swap-proof\finish`.
The fixture completes scheduler onboarding, uses magnets with local seeders (no private
HTTP metadata fetch), and clears persisted discovery caches before restarting.

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

Remaining: raw magnet submission, raw-intent actions, pending unresolved-scope wanted rows,
Find another promotion answers, and external client import. External recovery import
explicitly returns 501 rather than claiming success.
Download recovery restores persisted Engine bindings; it does not import another client's
storage. Real HTTP and headless 1280/390 proof lives in `tools\.dlapi-proof\finish\`.
