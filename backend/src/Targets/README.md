# Targets

`TargetPipeline` owns accepted item intent and the bounded `PipelineWorker`. Its project
references are exactly Domain, Find, Check, Plan, Engine, Library, Metadata and Store.
HTTP performs validation and authorization only. `DiscoveryPlan` is the shared checked
Find -> Check -> Plan composition used by the worker and `/api/dev/plan`.

## Phase 4.2a HTTP proof surface

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
  state actions, with no network at acceptance.

Open a title first so its identity is in Metadata's catalog. Acquire reads the Library
have-it set and stores only missing film/episode targets, with counts. Repeated clicks
reuse deterministic item IDs. Confirmed seasons use one season pool and plan; unresolved
season/episode scope intent is persisted and expanded only after confirmed Metadata.

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
download without bindings is treated as an orphan, not blindly started.

## Current integration boundary

This is the task 4.2a development surface; legacy HTTP projection/routing is phase 4.5.
Engine and Library use their existing proof-era ports. In particular
`ILibraryDownloadRepository.CommitFiledAsync` currently commits the joint inventory
and Target completion; Targets fences this small transaction against owner actions and
records completion. **OPS-754** tracks moving that final state write into a Targets
proposal/CAS transaction, as required by the final 1.2/1.3 contract.

Targeted real HTTP evidence is in gitignored `tools\.targets-proof\summary.json`.
No unit tests or full hard-set reruns are required for this slice.
