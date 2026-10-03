
I couldn't create `docs\design\critique.md`: my operating constraints don't allow me to write files, so the full critique is below in a form you can save as-is. I didn't edit any design files, commit anything, start sub-agents, message other agents or touch 3930/3931.

**Counts:** 4 blockers, 14 majors, 9 minors.

**Top 5:**
1. **Season-pack episodes are renamed while the pack is still downloading.** A neighbour's shared piece then recreates a ghost `.partial`, and a restart downloads the episode again.
2. **Swap reuses the `checking`/`planning` states while the old download still runs.** If the old one finishes, the owner pauses, or the replacement never proves itself, the target gets stuck or ends up with two engine rows.
3. **An empty mount point looks like a deleted library.** Files get marked Missing, are no longer owned, get downloaded again, and their records are pruned after 30 days.
4. **The Current download link is never retired when a target is done or fails.** The one-current-per-target unique index then blocks every later Upgrade or new download.
5. **Upgrade/Replace has no way back to `done`.** Plan's "never owned episodes" rule rejects every candidate, and Remove on an upgrade can delete the original file.

---

# Phase 1 design critique (task 1.7, FEAT-35)

Inputs reviewed: README, 1.1–1.6, Domain `Enums.cs`/`Records.cs`/`Interfaces.cs`, judged against rebuild-plan, architecture-rethink, rules, behaviour-inventory and contract `routes.md`.

## Blockers

### BL1. A pack's episodes are filed while the pack is still downloading
- **Where:** 1.2 T13/T14; 1.5 "Partial names and completion".
- **Problem:** T13 fires per target ("every target video … whole"), then renames `<final>.partial` and sets the DownloadFile paths to NULL. In a shared pack, other episodes are still downloading through the same MonoTorrent manager.
- **What goes wrong:** MonoTorrent still holds E1's old path. Its last piece is shared with E2, so writing or re-hashing that piece writes into E1's old path. That recreates `E1.mkv.partial` beside the filed `E1.mkv`, which is exactly the leftover Jellyfin must never see.
- On restart, `RecoverAsync` gets E1 still selected but with NULL paths, or the hash-check finds the file missing. E1 then downloads again, and the next filing hits a collision ("no overwrite") and becomes a duplicate.
- T13's "stop seeding/detach" for E1 would also kill the manager for E2 to E10.
- **Fix:** Pick one of these and write it into 1.2/1.5:
  - **(a)** Per-file filing goes through the engine: drain writes, mark the file DoNotDownload, have Engine rebind the path (`MoveFileAsync`), then rename. Only allowed once every piece touching the file is complete, including boundary pieces.
  - **(b)** File a pack's targets only when the whole selected set is complete.

  In both cases, detach only when no selected file remains incomplete, and add a Phase 5 check: pack restart after a partial filing must leave no `.partial` and download nothing again.

### BL2. Swap reuses `checking`/`planning` while the old download keeps running
- **Where:** 1.2 T21–T23, swap/stall section; 1.4 cap.
- **Problem:** During a swap, Target.state says `checking`/`planning` while a Current download is live. T22 also admits a Replacement while the state stays `planning`. No transition covers these cases:
  - **Old download finishes mid-swap.** There is no `checking`/`planning → filing` transition, so finished bytes sit unfiled.
  - **Pause during swap.** T26 resumes `checking`/`planning` as `wanted`. T04 then searches again and T11 tries a new Current while one exists. That gives either a unique-index failure (stuck) or a second engine row if the implementer works around it.
  - **Replacement never reaches 64 KiB.** There is no timeout, so the target sits in `planning` forever with two live managers.
  - **Cap accounting.** It's unspecified whether the Replacement takes a slot. It could exceed the cap or evict another owner download.
  - **Stalled pack.** A stall is a Download-level event, but T21 is per target. A stalled 10-episode pack fans out into 10 swap entries, and partial retirement isn't defined.
- **Fix:**
  - Keep the target in `fetching` during a swap. Model the swap as a Replacement association plus an open Swap Attempt with its own deadline (e.g. 20 min): prove the replacement, or abort and remove only the replacement.
  - Handle Current completion during a swap by cancelling the swap, then T13.
  - Pause/remove cancels the swap and keeps the old download.
  - The Replacement shares its target's slot, the same rule as a pack's one slot.
  - A pack stall opens one swap per Download, re-planned for all its targets together.

### BL3. An offline drive or empty mount point is treated as deleted
- **Where:** 1.5 "Root disconnected…", 1.2 T29, 1.1 MediaFile/StorageRoot.
- **Problem:** "Online" is just "accessible". A Docker bind mount whose host drive is absent, a Windows mounted folder, or a drive letter now taken by another disk all look like an online, readable, empty root. A complete scan then marks every file Missing.
- **What goes wrong:** Missing is not owned (owned = Present or Offline). The next Download season, request, rule or follow downloads the whole library again. T29 even does this automatically for followed series. After 30 days the records are pruned and ownership is gone for good, which directly breaks the owner rule "offline is never deleted and never downloaded again".
- **Fix:**
  - Count a root as online only if a root identity marker (e.g. `.torrentflow-root` containing the StorageRoot.id) and the volume serial / physicalKey match.
  - Add a mass-vanish guard: if more than N% (or N files) of a root vanish in one scan, mark them Offline and ask the owner.
  - T29 must not fire until a Missing state has been confirmed by two scans at least X hours apart.

### BL4. The Current association is never retired
- **Where:** 1.2 T14/T16/T31/T03; 1.1 DownloadTarget `U(targetId) WHERE role='current'`.
- **Problem:** T14 (done), T16 (invalid → wanted), T31 (orphan → wanted) and T03 (Upgrade/Replace) never say to set the role to Retired. Migration also keeps completed downloads as Stopped with their associations.
- **What goes wrong:** The next T11 for the same target violates `U(targetId) current`. Every Upgrade/Replace or invalid-file retry fails at admission (stuck target), or an implementer drops the constraint and duplicate rows come back.
  - Separately, `U(downloadId,targetId)` blocks re-associating a target with a hash it was retired from.
- **Fix:** Every transition that leaves `fetching` without a running Current transfer retires the association in the same commit, and the transition table should list this as a side effect. On re-admission of the same hash, update the Retired row back to Current rather than inserting a new one.

## Major

### M1. FileOperation has no claim, no path exclusivity and no written lifecycle
- **Where:** 1.1 FileOperation; 1.4 services; 1.2 T27/T13; 1.5.
- **Problem:** Three things run file operations: the filing path (`Observe`), MaintenanceWorker ("file … operations") and startup recovery. FileOperation has no lease/owner column, and nothing stops two pending operations on the same path.
- **What goes wrong:**
  - Remove + Delete during `filing`: a Delete is queued while the Rename is mid-flight. Delete misses the `.partial`, and the Rename publishes an orphan final file into Jellyfin.
  - Delete committed "before engine detach" can run while MonoTorrent still writes, so the engine recreates the file.
  - States are only Pending/Verified/Committed/Retry: "stop with owner reason" can't be represented, so a digest mismatch retries forever.
- **Fix:**
  - Add `leaseToken`/`leaseUntil` and one executor.
  - Add a unique active-path claim on source and destination (or a path-claim table).
  - Delete supersedes a pending Rename for the same paths, and runs only after the engine confirms detach and drain.
  - Add a NeedsOwner state.
  - Write the transition table (Pending → Copied → Verified → InventoryCommitted → SourceDeleted → Done) in 1.5.

### M2. Joint commits contradict the scoped Store capability
- **Where:** 1.1 transaction invariants; 1.3 "Store protocol and owners".
- **Problem:** `StoreCommit` has a single `StoreOwner`, and the capability "checks table/column ownership". Admission (Download/Target owned by Targets plus DownloadFile paths owned by Library) and filing (MediaFile owned by Library plus Target/RequestItem owned by Targets) are both required to be single commits.
- **What goes wrong:** Either the check is bypassed (no enforcement) or the commits are split. A split filing commit makes a crash between MediaFile Present and Target done routine, and "who commits MediaFile" is stated both ways (Library via scoped IStore, and "Targets commits").
- **Fix:** Library returns unsaved rows only. Targets is the only committer for those joint commits, and the column exceptions are listed explicitly. Do the same for Verdict: Check self-commit versus "via coordinator" is also inconsistent.

### M3. Upgrade/Replace can get stuck and can delete the original
- **Where:** 1.2 T03/T28/T27, "Acceptance, owned and Upgrade"; 1.3 Plan pack rule.
- **Problems:**
  - Once a Replace target goes to `waiting` (no healthy release, stall), no transition returns it to `done`. T28 explicitly excludes Replace. The owned item now projects as "wanted/Looking", breaking "owned never shows Download".
  - Cancelling an upgrade is only possible via T27 `removed`. With `deleteFiles`, the delete preview enumerates the item's MediaFiles, so the original can be deleted.
  - Plan's "One healthy pack … never owned episodes" rejects every candidate for a Replace target, because the item is owned.
  - The Upgrade command doesn't bind the healthy candidate that justified showing the button, so a fresh search can come back empty.
- **Fix:**
  - Add "Replace cancelled/failed → done", keeping the original.
  - Cancel Upgrade is its own action and never deletes the original.
  - Add a Replace gate to Plan: the item's own target is exempt from the owned exclusion. Upgrade requires resolution strictly above the best owned video; Replace requires at least the same quality.
  - Upgrade carries a choice token for the verified candidate.

### M4. No store for upgrade evidence
- **Where:** 1.1 WatchItem; the plan's "720p is the best available, checked 2 hours ago" and "4 can be upgraded".
- **Problem:** WatchItem is per user/work and holds a single `upgradeCandidateHash`. Owned items without a watch have nowhere to keep "best healthy available / checkedAt", and per-episode upgrade candidates can't be represented.
- **Fix:** Store per-item upgrade evidence as a small expiring table keyed by work/episode: best candidate hash, resolution, checkedAt and expiresAt. Or define precisely how the result is recomputed from Verdict + Release + Plan on read, with a stated check-age source.

### M5. Target.priority is a stored derived value
- **Where:** 1.1 Target.priority; 1.4 scheduler.
- **Problem:** One Target serves owner, request, follow and rule intents at once. FreshRelease depends on time ("around air window").
- **What goes wrong:** When a request is cancelled, a follow disabled or the air window passes, the stored class goes stale, and owner-rank-versus-plain-click is ambiguous.
- **Fix:** Store only the owner's inputs (`nowAt`, explicit owner rank, origin flags). Compute the class at sort time from the attached RequestItems/Follow, expectedAt and now.

### M6. Download state and the cap are owned twice
- **Where:** 1.1 Download.intent; 1.3 IEngine (`ApplyQueueAsync` with Cap/Windows, "Engine enforces slots"); 1.2 T17/T18.
- **Problem:**
  - Download.intent Run/Queued/Paused duplicates Target.state (`paused`, `waiting` DownloadCap). For packs it's really derived from several targets' states.
  - Cap and windows are evaluated by both Targets (T11/T17) and Engine.
- **What goes wrong:** The two can disagree after a restart, e.g. Target paused while Download is Run, so the engine resumes. Or Target says `fetching` while the Engine has queued it, so stall/active time is wrong.
- **Fix:** Targets alone computes which Downloads are admitted (cap, windows, Now) and sends plain Run/Stop per Download. Engine enforces only physical limits. Either derive Download.intent from its associations, or document it as Targets' only cache of the admission decision, written in the same commit as the target transitions.

### M7. Pending intent lives in Attempt, and raw add has no lifecycle
- **Where:** 1.2 "unresolved season-scope acceptance … open materialization Attempt"; 1.3 raw add as Attempt LegacyEvent; 1.1 MediaFile.workId NOT NULL.
- **Problem:** Attempt is meant to be immutable history (decisionJson is cleared after 30 days), yet it's used as a work queue for owner intent, with no index on open items. The raw download lifecycle (paused, cap, complete, filing, removal) has no state machine. A raw completion can't create a MediaFile because workId is NOT NULL.
- **Fix:** Put pending scope intent in an intent table, e.g. Request with an owner origin, or a scope row. For raw add, either require identity before payload, or finish it into the explicit folder and send it through the import review (Library proposal) so ownership follows the normal path. Either way, add a defined state holder for target-less Downloads.

### M8. New episodes can split an existing series folder in Jellyfin
- **Where:** 1.5 item folder = Safe English Title; rule 2 pins only the root.
- **Problem:** "English first including anime" (and any TMDB title change) produces a different folder name from the existing one (old canonical, e.g. a romaji anime title).
- **What goes wrong:** New episodes land in a second series folder and Jellyfin shows the series twice. That breaks "Jellyfin sees no change".
- **Fix:** Pin the item folder as well. Reuse the series/film folder of existing MediaFiles for that work (store it per work, or derive it from the dominant parent folder). Migration records the existing folder for every work. Renames are explicit owner actions only.

### M9. Thin swarms can never start
- **Where:** 1.4 Check/ranking; 1.2 T10.
- **Problem:** Unknown is only eligible "with safe complete file metadata", but for magnet-only releases metadata comes only from the 20 s probe. A fresh Unknown verdict is cached for 6 h. There's no path that attaches the best candidate and waits for seeders. The rethink's own answer for Little Fires Everywhere was the healthiest pack plus a clear "waiting for seeders" state.
- **What goes wrong:** Little Fires Everywhere-type titles stay in `waiting` NoHealthyRelease forever, retried at most every 6 h.
- **Fix:**
  - Add a bounded "metadata wait" attachment: an outside-cap budget of N per target, top Unknown candidates only, no payload, with a transition to `planning` when metadata arrives.
  - Use a shorter Unknown TTL (30–60 min) for wanted targets.
  - Use the `.torrent` from torrentUri sources for the file list without needing peers.

### M10. Probe → admission handoff for the same hash is undefined
- **Where:** 1.3 IEngine; 1.4 MonoTorrent hazard.
- **Problem:** The hot path probes hash X and then admits X, with `ReleaseProbe`/`Start` as independent calls. A probe can also attach to a hash whose Download is detached (Queued/Paused), and T18 then starts it. MonoTorrent rejects duplicate registration of the same hash, or the 3.0.2 per-hash piece cache contaminates the real download.
- **Fix:** Add a per-hash engine mutex plus an explicit `AdmitFromProbe`/ownership-transfer contract to IEngine now. Don't attach probes to hashes that have a Download row. Keep the Phase 3 proof gate.

### M11. Swap deletes the old partial too early
- **Where:** 1.2 swap; 1.5 "Swap deletes old partials only after replacement is attached+delivering".
- **Problem:** The replacement only has to deliver 64 KiB once before the old manager is removed, its partials deleted and its hash blocked.
- **What goes wrong:** The replacement stalls a minute later and both downloads are lost. This is the same class as the past "files deleted before replacement landed" failure.
- **Fix:** Keep the old partials (detached, not seeding) until the replacement has finished, or has passed old's completed bytes with a Good sustained rate. Free them earlier only under disk pressure, and say so to the owner.

### M12. API routes with no port
- **Where:** 1.3 vs `routes.md`.
- **Problem:** These need synchronous Find/Check/Plan or file system reads, but no interface method exists, and Api may not reference Find/Library:
  - `GET /api/title/{workKey}/releases` (picker) and `GET /api/client/torrents/{hash}/alternatives`
  - `GET /api/search` (raw)
  - `/api/settings/browse-folders`, `untracked-files`, `download-recovery[/sources]`
  - `library/backfill-estimate`
- **Fix:** Add typed ITargets read methods (picker/alternatives/plan dry run returning pool + verdicts + rejections, with a token) and Library-through-Targets folder and recovery queries. Don't route them through `SystemAsync` with a JsonElement payload.

### M13. Policy revision in cache and flight keys defeats sharing
- **Where:** 1.1 SearchCache unique key; 1.4 flight identity.
- **Problem:** Source HTTP answers don't depend on quality/size/audio policy, and policyRevision is per target (bumped on pause/rank/etc.).
- **What goes wrong:** Episodes of one season, or two users, miss each other's cache and flights. You get more source calls and 429s, and B11's goal is undone.
- **Fix:** Key the cache and flights on query, scope, source and parser/credential revisions only. Apply policy in Plan; B06 is solved by per-waiter Plan, not by splitting HTTP flights.

### M14. Cutover can download things the owner already has
- **Where:** 1.6 tool rules and staging.
- **Problems:**
  - "Never read legacy `D:\Torrents`" is right for rehearsal, but for live cutover the owner's real library is at those paths. The design doesn't say the live path map covers them. Otherwise all 12+ owned items become Missing and are downloaded again.
  - Hand-copied media is unknown to MediaFile, so the scheduler starts on 52 converted wanted targets plus follows before any import scan. That downloads duplicates of files already on disk.
- **Fix:**
  - Live mode requires an identity path map for the real roots (read-only verification).
  - The new server starts with the scheduler paused until a first full root scan and owner import review complete. At minimum, auto-adopt only exact-path Confident matches.

## Minor

- **N1 – 1.2 T12:** `waiting` with resumeState=`planning` has no outgoing transition; it only works through T20 by implication. Add an explicit transition or remove that resume value. Also, cap-queued targets have no Download row, so `/api/client/torrents` loses its old Queued rows. Confirm that against the contract.
- **N2 – 1.2 leases:** Lease renewal isn't defined. A stage wait longer than `leaseUntil` lets the worker claim the target again. CAS prevents a double admit, but you get a duplicate search/probe. Define a heartbeat, or a lease longer than the maximum stage budget.
- **N3 – T31 orphan:** Cleanup of stale `.partial` files and DownloadFile `physicalKey` reservations isn't specified. A re-pick then hits `U(physicalKey)`.
- **N4 – Requests:** Behaviour when an approval or auto-approve hits a `paused` or owner-`removed` target is undefined. Auto-approve shouldn't bring back owner-removed targets.
- **N5 – WaitReason:** ReplacementPending, OwnerPickRequired and FileInvalid have no transitions that set them. Wire them or drop them.
- **N6 – 1.1:** DownloadFile.targetId and DownloadTarget store "which targets a download serves" twice. Add a consistency check in Store or derive one from the other.
- **N7 – 1.6 rollback:** The old server's OPS-656 same-size replacement/tidy can overwrite files the new server placed in shared folders. Disable tidy/promotion on the rollback start, or quarantine post-cutover files first.
- **N8 – 1.5:** New roots default to `Anime` while existing ones use `Anime Series`. Default new roots to the installation's existing folder names to keep one Jellyfin convention.
- **N9 – README coverage:** B04 is marked "Designed", but BL2/M11 show the ordering is still unsafe. L02/L05 are restored, but M9 shows Unknown can never be acted on. Mark these "partially designed" until fixed.

**Coverage check:** the other 18 LOST IN PORT rows and 13 known-bug rows (excluding B04/L02, plus B15 which is deferred to Phase 3) are actually present in the design text, not just in the table.

## Resolution

Applied to the Phase 1 design and compilable Domain contracts for OPS-658 / FEAT-35.
These are design fixes, not proof of MonoTorrent/filesystem/runtime behaviour; Phase 3/5
and live converter gates remain mandatory. Original critique above is preserved.

- **BL1:** 1.2 T13/T14, 1.3 hash ownership/filing contract, 1.5 option (a) touching-piece drain/unselect/rebind+rename and option (b) fallback; Domain EngineFilingPermit/AllTouchingPiecesComplete/enginePath/filed; Phase 5 partial-pack restart/no `.partial`/no re-download gate.
- **BL2:** 1.2 T21-T24 and swap flow keep fetching with one Download-scoped 20 min Swap Attempt/all pack targets, completion/pause/remove cancellation and shared slot; 1.4 cap ownership; Domain Attempt deadline/SwapDecision.
- **BL3:** 1.1 StorageRoot/MediaFile, 1.2 T29, 1.5 scan require `.torrentflow-root`+volume serial, >10% OR >20 mass-vanish Offline guard/owner review, two identity-valid scans >=6 h before reacquisition; Domain VolumeSerial/MissingConfirmedAt/RootScanEvidence.
- **BL4:** 1.1 DownloadTarget, 1.2 explicit retirement table side effects and re-admission, 1.6 completed/paused history conversion retire Current; same-hash Retired updates to Current, no duplicate association insert.
- **M1:** 1.1 FileOperation/FilePathClaim, 1.4 sole executor, 1.5 operation lifecycle/lease/path exclusivity/superseding Delete/detach+drain/NeedsOwner; Domain lease/resume/permit fields and operation states.
- **M2:** 1.1 invariants, 1.3 Store ownership exception table: Library and Check return unsaved proposals, Targets alone commits joint rows including Verdict/enrichment; Domain recovery/filing results return rows.
- **M3:** 1.2 T03/T16/T31/T40, owned flow and 1.3 Replace gate/token contract: failed/cancelled Replace returns done retaining original, separate CancelUpgrade never deletes original; Domain ReplacementMode/CancelUpgrade.
- **M4:** 1.1 UpgradeEvidence per work/episode with expiry/check age independent of WatchItem; 1.2 Upgrade token; Domain UpgradeEvidenceRow and read projection.
- **M5:** 1.1 Target owner inputs and 1.4 dynamic sort: no stored priority class, recompute from current requests/follows/dates/time; Domain OwnerRanked/Rank/NowAt.
- **M6:** 1.1 Download admission cache, 1.3 Run/Stop contract, 1.4 Targets-only cap/windows/Now; Domain EngineQueuePolicy contains decisions only, no duplicate Engine cap policy.
- **M7:** 1.1 ScopeIntent/RawIntent, 1.2 raw lifecycle/leases, 1.3 raw API and 1.6 conversion: owner scope not Attempt; target-less raw transfer finishes explicit folder then import Review, no fake MediaFile ownership; Domain typed state holders.
- **M8:** 1.1 WorkFolder, 1.5 pinned root+item-folder layout, 1.6 actual-folder migration; Domain WorkFolderRow/PlacementResult.Folders; title refresh never renames existing work folder.
- **M9:** 1.2 T10/T39, 1.3 metadata-wait capabilities, 1.4 max 3 top Unknown/target no-payload attachments outside cap, 45 min wanted Unknown TTL and torrentUri `.torrent` file lists; Domain metadata-wait methods/records.
- **M10:** 1.3 hash ownership and 1.4 probe safety enforce per-hash mutex, bar probe attachment for any Download row, consumed AdmitFromProbe handoff/drain/recheck; Domain IEngine.AdmitFromProbeAsync; Phase 3 isolation proof remains required.
- **M11:** 1.2 swap and 1.5 retention keep old partials detached/not seeding until completion or surpass old bytes at sustained Good rate (5 min), early disk-pressure cleanup only with owner message; Domain SwapDecision baseline/proof evidence.
- **M12:** 1.3 typed API-through-Targets route table, Domain ITargets/IFind/ILibrary records/methods for picker/alternatives/raw search/dev plan/folders/recovery/backfill; captured untracked-files POST is exact-path deletion, handled by typed command/sole executor, not misclassified as a query or SystemAsync JSON.
- **M13:** 1.1 SearchCache, 1.4 flight/cache identity and per-waiter Plan remove policyRevision from source HTTP keys; Domain SearchCacheRow corrected.
- **M14:** 1.6 live identity map/read-only verification, durable scheduler scan+review startup gates and exact-path Confident-only auto-adopt; README defaults and Domain SchedulerSettings flags.
- **N1:** 1.2 T38 explicit waiting->planning; 1.3 captured contract compatibility retains cap-Queued `/api/client/torrents` projections without fake Download rows; Domain QueuedTransferProjection/TargetReadModel.
- **N2:** 1.2 lease heartbeat/fencing and 1.4 scheduler: 90 s Target/RawIntent lease renewed every 20 s, lost renewal forbids commit and releases only private handles.
- **N3:** 1.2 T31/restart and 1.6 orphan conversion require detach/drain plus exact stale-partial cleanup before releasing physicalKey reservations/re-pick.
- **N4:** 1.2 request approval: paused stays paused/Open, removed stays removed/StoppedByOwner; auto-approval never resurrects, only explicit owner retry/acquire/Now.
- **N5:** 1.2 waiting/escalation wires OwnerPickRequired; drops ReplacementPending/FileInvalid as current wait reasons (swap stays fetching, invalid is T16 block/history); Domain WaitReason matches.
- **N6:** 1.1 DownloadFile and 1.3 Store guards validate same-download target association and selected-file mapping atomically, including Retired filed history.
- **N7:** 1.6 rollback fences old tidy/promotion/same-size replacement before start, else exact-map quarantine protects post-cutover files; rehearsal proof required.
- **N8:** 1.5 naming table/installation-default rule and README use existing Anime Series convention on new roots unless explicit owner override.
- **N9:** README B04/L02/L05 coverage now says design corrected/runtime proof pending, lists all 27 resolutions and honest Phase 3/5/converter gates.
