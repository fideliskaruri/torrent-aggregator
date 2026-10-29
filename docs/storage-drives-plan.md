# Storage drives: priority, failover, reconnect and cleanup

Owner request (2026-10-22, paraphrased from voice): when a drive is unplugged, downloads sit in
"Looking" and stay stuck after it is plugged back in. Let me add several drives or partitions in a
priority list (drag and drop or arrows); if one is full or unavailable the next one is used, never
overfilled. If every drive is full or unavailable, suggest deletions from what I have watched in
Jellyfin (one watched episode counts) and let me pick. Detect a replugged drive and continue on its
own. Not backups. Also confirm whether the slow "find a source" step is fixed.

Background: `docs/design/1.5-library-layout.md` "Multiple roots and capacity" already specifies
priority roots, reserves and WorkFolder pins. The schema supports it (`StorageRoot.priority`,
`reserveBytes`, `maxAllocatedBytes`, `kinds`, `enabled`, `online`, `reviewRequired`), but the code
only ever uses the first root. This plan turns that on and adds the missing reconnect and cleanup
paths.

## 1. Who, context, journeys

Single owner on a Windows PC with external USB drives, checking from desktop or phone. Storage is
an occasional task (setup, a full drive, a drive moved to another port); downloads are daily. Calm
tool, existing TorrentFlow design system (`docs/design-system.md`) applies.

**J1 Add a second drive** (act). Settings > Storage > Add location > pick folder (for example
`E:\Media`) > it appears last in the list with free space and a "Keep free" amount > done. Needs to
see: free space, what will be kept free, its order.

**J2 Reorder** (act). Drag a location by its handle, or press its up/down arrow. The order saves at
once (optimistic, rolls back with a message). Needs to see: the number of each row (1 = used first).

**J3 Drive unplugged mid-download** (glance). Downloads list and title page say "Waiting for drive E:"
(not "Looking", and no new search is started for it). New titles go to the next location that has
room. A series already on E: waits for E: instead of being split across drives by a short unplug.
When the drive is back, the downloads show "Checking files" while the existing pieces are verified,
then continue with no click.

**J4 Drive full** (glance then act). A new title goes to the next location with room. A title
whose files are already on a full drive continues on the next location, in a folder with the same
name (Jellyfin merges them because every location's kind folder is in the same library).

**J5 Nothing has room** (act). Downloads list shows one banner: "Your drives are full" (or "No
drive is connected") with "Free up space". The cleanup sheet lists watched titles from Jellyfin
(movie played, or any episode played), oldest watched first, with size and drive. Tick some, review
the total, confirm, files are removed, waiting downloads start.

**J6 Files vanished check** (act). When many files are missing on a connected drive, the location
shows "Check needed: 42 files missing". Actions: "Files are fine, use this drive" (confirm) or keep
it off.

Hard moments: first run (one location from setup, list shows it), only one location (no arrows,
no handle), last location cannot be removed, a location with files cannot be removed (explain:
remove or move the titles first; offer Turn off instead), folder that is the drive root or inside
another location (refuse with reason), Jellyfin not connected (cleanup says so and links to
Jellyfin settings; no guessing), all drives offline (cleanup can only show titles on connected
drives; banner says plug in a drive), save fails (row snaps back, toast says why).

## 2. Screens

### Settings > Storage (replaces the folder and space-limit fields in "Downloads")

Information budget: primary = the ordered list; supporting = Add location button, the
"Free up space" link. Per-row details (Keep free, Use at most, kinds) behind the row's Edit.
Scroll: the settings page is the one scroller; the list does not scroll on its own.

```
Desktop (inside the existing Settings column, max-w as today)
Storage                                                  [Add location]
Downloads go to the first location with room.
 ┌──────────────────────────────────────────────────────────────────────┐
 │ ⠿ 1  D:\Torrents\Media           Online       ▓▓▓▓▓▓▓░░░  312 GB free │ ↑ ↓ ⋯
 │                                   Keeps 50 GB free                    │
 ├──────────────────────────────────────────────────────────────────────┤
 │ ⠿ 2  E:\Media                    Offline      Plug in this drive      │ ↑ ↓ ⋯
 ├──────────────────────────────────────────────────────────────────────┤
 │ ⠿ 3  F:\Films                    Full         ▓▓▓▓▓▓▓▓▓▓   48 GB free │ ↑ ↓ ⋯
 └──────────────────────────────────────────────────────────────────────┘
Free up space                                                  
```
Phone (375): same rows stacked: line 1 handle, number, path (truncate middle), menu; line 2 status
and free; arrows inside the row menu as "Move up" / "Move down" plus drag handle (touch drag).

Row menu: Edit (Keep free GB, Use at most GB optional, Which kinds), Check now, Turn off/on, Remove.
Status chip values: Online, Offline, Full (free minus keep-free below 1 GB), Check needed, Off.

### Cleanup sheet (right drawer on desktop, bottom sheet on phone)

Primary = the list with checkboxes; supporting = total selected and the Delete button (sticky at the
bottom). The list is the only scroller.

```
Free up space                                               [x]
Watched in Jellyfin, oldest first.
 [ ] ▢ Atlantis (2013)       Watched 26 of 26 episodes · 3 Sep    38.2 GB  D:
 [ ] ▢ Dune: Part Two        Watched 12 Aug                        61.0 GB  E:
 [ ] ▢ Rick and Morty        Watched 3 of 71 episodes · 2 Oct      44.9 GB  D:
 ...
 ───────────────────────────────────────────────────────────────
 2 selected, 99.2 GB                          [Delete 2 titles]
```
Delete opens a confirm ("Delete 2 titles and 99.2 GB of files? This can't be undone."). Delete is
a destructive button style, never the amber primary. Series rows offer "Watched episodes" (default)
or "Whole show".
Titles on an offline drive are listed but not selectable ("Drive offline").
While a reorder save is pending, status polling results for the list are ignored (no snap-back).

### Status copy (everywhere a download is waiting)

| Wait reason | Downloads list and title page | Library card |
|---|---|---|
| DriveOffline | Waiting for drive D: | Waiting for drive |
| NoDriveSpace | No drive has room | No drive has room |

"Looking" is only used when a search is really running.

## 3. Backend design

### 3.1 Placement (`LibraryPlacement.PlaceAsync`)
Candidate roots = enabled roots ordered by `Priority`, then `Id`. For each work:
1. Pinned roots (that already hold a `WorkFolder` for this work) come first: the root holding the
   selected season, then the root with the most files, then priority.
2. Then the remaining roots in priority order.
3. If a pinned root is offline, the work waits with `DriveOffline` (no split because of a short
   unplug). It fails over to the next root only when every pinned root is online but full.
A root is usable when: online (watcher's in-memory status, 3.3, no inventory walk; `PlaceAsync`
no longer calls `CheckRootAsync`), not review-required, accepts the kind, and
`free - reserve - committed >= bytes`, and under `MaxAllocatedBytes` when set (existing check).
`committed` = sum over unfiled selected files of downloads on that root of
`max(0, ExpectedBytes - AllocatedBytes(PartialPath))` (payload files are sparse, so free space has
already dropped by what is written). `PhysicalFiles.AllocatedBytes` moves to Library. Raw grabs
must have `DownloadFile` rows or be counted.
Take the first usable root. If none: `Wait(DriveOffline)` when a pinned root is offline or the only
roots that would fit by kind are offline, otherwise `Wait(NoDriveSpace)`. No enabled root accepts
the kind: `Wait(NoDriveSpace)` with its own text ("No location takes series").
Folder name: reuse the pin's `RelativeItemFolder` on that root; on a new root reuse the leaf name of
the work's existing pin (never recompute from a changed title).
Schema: drop unique `IX_WorkFolder_workId_all`; add unique `(WorkId, RootId)` filtered
`RootId IS NOT NULL`, and keep unique `(WorkId)` filtered `RootId IS NULL` for external pins.
`SavePlacementAsync` and `UpdateBindingsAsync` (`LibraryDownloadRepository.cs:49,77`) and
`RecordAsync` (`LibraryPlacement.Inventory.cs:49`) look up by `(WorkId, RootId)`.

Default keep-free: `min(50 GB, 10% of capacity)`, computed at runtime when `ReserveBytes` is 0 (so
existing roots get it without a data migration). The owner can set 1 GB or more. The existing space limit (`MaxAllocatedBytes`, 200 GB here) is kept as "Use
at most".

### 3.2 Roots API (`LibraryPlacement.Roots.cs`, `ImportEndpoints.cs`)
- `RootsAsync`: all roots, ordered by priority (callers that need usable ones filter).
- `AddRootAsync`: validate full path, not a drive root, not inside or containing another root,
  no links; create folder; write marker `.torrentflow-root` containing the root id; Priority =
  max + 1; default keep-free.
- `ConfigureRootAsync`: allow ReserveBytes, MaxAllocatedBytes, Kinds (non-empty), Enabled,
  ConfirmIdentity (clears ReviewRequired after the folder exists). Optimistic version check stays.
- `PUT /api/library/roots/order` with `{ ids: [...] }` sets Priority 0..n in one transaction
  (must contain every root id exactly once).
- `RemoveRootAsync`: refuse while MediaFiles or unfinished downloads reference it (message says
  what to do); refuse the last enabled root; WorkFolder rows with no MediaFile and no binding are
  deleted first (today they block removal forever); otherwise delete the row (leave files and
  marker). Settings and `DownloadEndpoints.cs:632` order by `Priority`, not `Id`.
- RootView adds `totalBytes`, `committedBytes`, `maxAllocatedBytes`, `usedBytes` (MediaFile sum),
  `status` (online|offline|full|review|off), `missingCount` when review is required.
- `PUT /api/settings/client` keeps working for setup: it edits the priority-0 root only.
- All single-root call sites move to the right root: `TargetTransfers` (`Single` on placement
  root id), `TargetDownloadDeletion.cs:107`, `RawDownloads.cs:31-34` (raw grabs use the first
  usable root), `DownloadEndpoints.cs:47-50,554-659`, `MediaImport.cs:46,75,123`,
  `LibraryPlacement.Inventory.cs:11,40-47`, `LocalFiles.cs:50-66,138-160` (search all roots).

### 3.3 Drive watcher (new hosted service `StorageWatcher`)
Polling every 5 s, not OS events: the poll is a `Directory.Exists` plus marker read per root
(microseconds when the drive is present, immediate false when it is gone), it works the same for
USB drives, partitions, mapped folders and Docker mounts, and needs no window, COM or WMI.
- One probe in flight per root (never stack threads on a dead network drive). A probe slower than
  3 s is "unknown", not offline. Offline needs 2 failed probes in a row (no flapping on spin-up).
- Status and free space live in memory (`IStorageStatus`); the DB row is written only on a state
  change (no `Version` bump every 5 s, so the UI's edits don't conflict).
- Identity: marker `.torrentflow-root` containing the root id, plus `VolumeSerial`. Added roots get
  the marker at Add (owner action). The existing root gets it once at startup only when its
  inventory check passes (most known files present). Never written during a scan. A folder that
  exists without a matching marker is "Check needed" until the owner confirms (protects against a
  different USB stick taking the same letter).
- Offline -> online: full `CheckRootAsync` (inventory, mass-vanish guard), then wake.
- Online -> offline: mark offline, stop the engine for downloads on that root (wrap the flush in
  `StopDownloadAsync` so an IO error on a missing disk doesn't throw every tick), set their targets
  `Waiting(DriveOffline)` with `ResumeState = Fetching`.
- Free space rose by at least 1 GB, or a root was added, re-ordered, enabled or edited: wake.
- Wake = direct versioned write `NextTryAt = now` on targets `Waiting` with DriveOffline or
  NoDriveSpace (not `ChangeAsync`, which no-ops on same state and checks the lease). Fetching
  downloads come back through the existing Waiting/ResumeState=Fetching path in the transfers tick
  (`TargetTransfers.cs:277-283`), gated on the root being online, which runs
  `HashCheckBindingsAsync` (bindings-aware, so filed files stay intact) before starting. The UI
  shows "Checking files" during that check. Never call `TargetTransfers.RecoverAsync` at runtime
  (no gate; it can delete a download mid-admission).
- Startup with a root offline: skip `BindAsync`/recover for its downloads (today `CreateDirectory`
  throws and the tick retries every 500 ms); check the marker before any bind or start.
- Stall recovery: `RecoverStallsAsync` (`TargetRecovery.cs:147`) skips downloads whose root is
  offline or whose snapshot has `engine_error`. This is what turned an unplug into "Looking".
- Engine error "not enough space" on a download maps to `Waiting(NoDriveSpace)`,
  `ResumeState = Fetching`.
- The scheduler on/off switch skips the whole tick, so the watcher does its own waking and status
  writes.

### 3.4 Wait reasons and labels (bug)
- `TargetTransfers.AdmitAsync` and `TargetTransfers.Join.cs`: map `Failure.Code` exactly:
  `DriveOffline` -> Waiting(DriveOffline), `NoDriveSpace` -> Waiting(NoDriveSpace),
  `PlacementRequired` and `InvalidPath` -> new `WaitReason.PlacementBlocked` with
  `NextTryAt = null` (a terminal "Needs you: <message>" state; editing roots wakes it),
  `MappingUncertain` keeps its own reason. No more blanket "not Offline means NoDriveSpace".
- `ChangeAsync`: when the state and reason are unchanged, still refresh `ReasonText` and
  `NextTryAt` (today it is a no-op, so a retry never re-arms).
- Retry backoff for DriveOffline and NoDriveSpace stays 5 min or more (each retry is a full search);
  the watcher wakes them as soon as a drive returns or space frees.
- `TitleTransfers.WaitingState`, `title-download-state.ts`, `CatalogProjection.cs`, Downloads row:
  labels per section 2. Downloads row includes the drive letter.
- Engine `engine_error` with a missing path while the root is offline maps to DriveOffline in the
  pipeline instead of being ignored.

### 3.5 Cleanup suggestions
- `GET /api/library/cleanup` returns `{ jellyfin: "ok"|"off"|"unreachable", items: [...] }`.
- Source: the cached `JellyfinWatchState.ReadBatchAsync` snapshot (already has UserData for every
  item, so it gives "3 of 71"), plus `LastPlayedDate` added to its UserData. No new query.
- Group by work. Item: workId, title, year, kind, poster, `watched` ("movie" or
  `{ played, total }` episodes), `lastPlayedAt`, `bytes`, `watchedBytes` (played episodes only),
  roots (letter and online), `deletable` (every affected file's root online).
- Only TorrentFlow-managed files (`RootId != null`); track-in-place media is never deleted.
- Series default to "Delete watched episodes" (the watched episodes' files only); "Delete the whole
  show" is an explicit second choice. Films delete the film.
- Deletion reuses `POST /api/library/delete` with the suggestion's `workId` and `confirm: true`:
  films use scope `show`, series use scope `episodes` plus the selected `episodeIds` in one
  request, or scope `show` for the explicit whole-show choice. The episode batch only removes
  TorrentFlow-managed files. Each affected root is checked server-side before deletion; an offline
  root returns 409 and a message
  such as "Plug in drive E: before deleting this." Partial results identify each deleted or failed
  source so a split show can't silently lose its DB rows while files stay on an unplugged disk.
- Downloads banner: `GET /api/library/roots` already gives status; the banner shows when at least
  one target waits with NoDriveSpace or DriveOffline and no root is usable.

### 3.6 Search latency
Filled in from the profiling run (section 6).

## 4. Phases and ownership

| Phase | Work | Who |
|---|---|---|
| A | 3.4 reason mapping, PlacementBlocked, ChangeAsync re-arm, labels; stall recovery skips offline/engine_error; error-mode recovery (stop, bindings hash check, restart); skip bind for missing roots at startup; flush wrapped | gpt-6-luna |
| B | 3.1 placement + migration + 3.2 roots API + call sites | gpt-6-luna |
| C | 3.3 StorageWatcher + engine pause/resume on root | gpt-6-luna |
| D | 3.5 cleanup endpoint | gpt-6-luna |
| E | Storage settings UI, cleanup sheet, Downloads banner | coordinator |
| F | 3.6 latency fixes | gpt-6-luna |

A first (smallest, fixes the reported bug's labels). B and C touch overlapping files
(`LibraryPlacement.Roots.cs`), so B then C in sequence. D and F are independent. E after B.

## 5. Real verification

Never pause or touch the owner's real downloads on D: during tests.
`subst` cannot simulate an unplug (open handles keep working, and it shares C:'s serial), and VHD
attach needs admin (this account is not). So:
- With `subst T: %TEMP%\agent-scratch\drives\t` (location 2): placement, failover, all-full,
  offline-before-admission (`subst T: /d` with nothing open), reconnect wake, marker mismatch.
- Mid-download unplug (J3): exercised by a real USB stick by the owner; the code path is also
  driven by forcing the watcher's offline transition for a test root and checking that stall
  recovery is skipped, the target says "Waiting for drive T:", and on return it shows "Checking
  files" then resumes.
- Failover: set location 1 keep-free above its free space: a new movie goes to T:; a series with
  episodes on D: puts new episodes on T: in the same item folder name.
- Offline failover: T: first in order and unplugged: a new grab goes to D:.
- All full: both keep-free above free: banner, target says "No drive has room", cleanup sheet lists
  Jellyfin-watched titles; delete one small test title, the waiting target starts.
- Review: delete 25 test files on T: while online: "Check needed: 25 files missing", confirm clears.
- UI: Playwright at 390/768/1280 (design-system widths), drag reorder and arrow reorder persist after reload,
  keyboard reorder, failed save rolls back.
- API: roots CRUD and order validation errors (duplicate id, missing id, nested path, drive root).

## 6. Search latency (profile, DB 15 to 23 Oct)

| Phase | p50 | p90 | Note |
|---|---|---|---|
| Wanted -> searching | 1.3 s | 1.9 s | fine |
| Searching -> plan, season batch | 1.7 s | 64.9 s | |
| Searching -> plan, single episode or film | 60.1 s | 60.8 s | the 60 s metadata-probe deadline |
| Plan -> download linked | 0.4 s | 0.4 s | fine |
| Found but no seeders -> next search | 600 s | 605 s | fixed 10 min retry |
| Rejected candidates -> next search | 40 min | 21.7 h | backoff doubles to 24 h |

So the earlier fixes did not change this: a single episode or film still waits for the slowest
magnet's metadata (60 s), and "found but unseeded" sits 10 minutes before rechecking.
Fixes (phase F):
1. `DiscoveryPlan.cs:181,244-270`: targets whose `Origin` is owner or request (not lane: one miss
   moves them to Background) wait at most 12 s for metadata. Probes become owned by a registry with
   their own 60 s token (cancelling the plan no longer cancels the fetch), `Task.WhenAny` against a
   12 s timer replaces `WhenAll`, late handles are released by the registry, and shutdown awaits it.
   Late results land in the torrent cache and are used on the next pass. Commit early only when no
   higher-ranked pending candidate covers the same targets. Background origins keep 60 s.
2. `TargetPipelineActions.cs:159-174`: owner targets waiting for seeders recheck after 2, 5, then
   10 min, counted from recent `WaitingForSeeders` attempts (no new column). Rejected/NoResults
   owner retries cap at 2 h instead of 24 h. Watch the search budget and `SourceCooldown`.
3. Every wait has an honest label: WaitingForSeeders "No seeders yet, checking again soon"; metadata
   timeout "Reading the torrent's file list"; DriveOffline and NoDriveSpace per section 2;
   PlacementBlocked "Needs you". "Looking" only while a search is running.

## Non-goals
Backups or mirroring. Automatic moving of existing titles between drives. Following a drive whose
letter changed (it shows Offline; the owner edits the location path). Pushing paths into Jellyfin
libraries (the Storage page tells the owner which folders to add to Jellyfin when a location is
added).
