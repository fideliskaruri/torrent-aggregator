# Season pack fallback: design

Status: plan for critic review. No production code yet.
Branch: `feat/pack-plan`, based on `origin/main` at `c4753b0`. Line references are to that commit unless marked "season-speed".

## 0. The rule this implements

Owner rule (2026-09-30 20:16, `docs/rules.md` in the main checkout): season packs are allowed only as a last-resort fallback, after the single-episode pipeline has really missed an episode (refused searches don't count), only for fully aired seasons, only for the episodes still missing, with the file list verified before download and only the needed files downloaded. Plan and critic before code.

Everything else about acquisition stays as it is. The single-episode grab (`GrabService.Episode`, `EpisodeLadder`, metadata-confirmed admission) remains the first and preferred path for every episode. Packs never appear in the picker (`ReleasePicker.cs:45` keeps filtering them) and are never an episode candidate (`EpisodeRejections.IsPack`, `EpisodeRejections.cs:34`, keeps rejecting them inside the episode ladder). The fallback is a separate, later step owned by the wanted queue.

Once this lands, `docs/rules.md` ("No season packs", line 52), `AGENTS.md` (Downloads section, "No season packs in any form") and `docs/AGENT-GUIDE.md:53` must be updated in the same change so they describe the fallback instead of forbidding it.

## 1. Trigger rules

### 1.1 Where it runs

Only in `WantedQueue.RunAsync` (`WantedQueue.cs:209`), after the season fanout returns and before `Reschedule` (`WantedQueue.cs:260`). Never from the title page's synchronous path (`TitleController.cs:134`), never from an explicit single-episode click, never from requests directly (requests already enqueue into the wanted queue, `RequestGrabber.cs:54`).

The season-speed branch changes `RunAsync` so that each episode settles as soon as its grab finishes (`settled` callback on `GrabService.Season` and `SeasonFanout.Run`, and a local `Settle` function in `RunAsync`). The plan fits that shape:

- Miss counting happens inside `Settle`, per episode, the moment it settles.
- The pack step runs once, after `grabs.Season(...)` has returned, because it needs the complete set of episodes still missing in that unit. It then calls the same `Settle` for the episodes it claimed, so claims show up exactly like single-episode starts (`SettleAsync` plus `ReportStartedAsync`).

### 1.2 What counts as a real miss

An episode attempt is a real miss only when the search actually happened and found nothing usable:

- Counts: failure codes `no_release`, `quality_floor`, `no_seeders`, `audio_preference` (from `GrabFailure.cs:37-46`), and `metadata_unavailable` when every candidate that was probed failed metadata (the swarm is dead, not the search).
- Does not count: `sources_unavailable`, `search_busy` (already the `Unsearched` set, `WantedQueue.cs:55`), any attempt where any source reported an error (`searchFailed`, `GrabService.cs:185`, reported as `search_incomplete`), `no_sources`, `storage_limit`, `download_folder`, `setup_required`, and `download_failed` (unknown engine failure). With season-speed, a busy host is a `SourceBusyException` source error, so it lands in the "does not count" side automatically.

Implementation: `GrabResult` already carries `NoReleaseFound.reason` (`no_release` vs `search_incomplete`, `GrabService.cs:241-245`). Add one boolean to `EpisodeTransfer` (for example `RealMiss`) computed in one place (`GrabFailure.IsRealMiss(result)`), so `WantedQueue` does not re-derive it.

### 1.3 How many misses

- Threshold: an episode is pack-eligible after **2 real misses on 2 separate wanted-queue attempts** (the first retry is at least 1 minute later, `WantedQueue.cs:48`). One constant, `WantedQueue.MissesBeforePack = 2`.
- The count is persisted per episode on the acquisition target (new column `AcquisitionTarget.RealMisses`, section 5), because the in-memory `plans` and `why` maps are lost on restart (`WantedQueue.cs:61-63`). The count resets to 0 when the episode starts from any source.
- The pack step runs for a unit when at least one episode in it is pack-eligible. It then tries to cover every episode of that season that is still missing and has at least one real miss. Episodes with zero real misses (never really searched) are not covered by the pack; they keep going through the single pipeline.

### 1.4 Fully aired seasons only

A season is fully aired when the provider says the season is over, never by guessing:

- New method on the existing `IAirDateLookup` (`Core/Contracts/Metadata/IAirDateLookup.cs`): `GetSeasonAiringAsync(title, mediaType, externalId, season)` returning `Finished`, `Airing` or `Unknown`, plus the provider's episode count for the season.
- `AirDateLookup` (`Metadata/Title/AirDateLookup.cs`) implements it from data it already reads: for AniList entries, `GetFirstAiringAfterAsync(now)` answered with nothing announced and the last listed episode has aired; for TMDB/TVmaze seasons, every listed episode has an air date and the last one is at least 24 hours old, and no later episode of the same season is announced.
- `Unknown` fails closed: no pack. The reason is recorded ("Season still airing, or we could not confirm it has finished. Waiting for single episodes.").
- The provider episode count is also used by the mislabel check (section 2.5).

### 1.5 How the pack search is formed (DRY)

No second search pipeline. The pack step is a new method on the same service, `GrabService.SeasonPack(GrabInput input, int season, IReadOnlyList<int> missing, CancellationToken ct)`, and it reuses:

| Reused piece | Where it is today |
| --- | --- |
| Identity, aliases, AniList mapping, quality floor | `GrabService.Prepare`, `GrabService.cs:92-132` |
| Title variants, alias ranking, category ladder | `EpisodeLadder.SearchTitleVariants`, `AliasTitleForms`, `RankAliases`, `LadderCategories`, `EpisodeLadder.cs:36-111` |
| The search call and its options (`WaitForBudget`, `Background`, `SkipCache`, sources, constraints) | the call in `GrabService.Episode`, `GrabService.cs:165-172` (extract to a private `SearchRung` used by both) |
| Work identity check | `EpisodeLadder.ReleaseMatchesWork`, `EpisodeLadder.cs:260` |
| Quality floor, dub rule, source list, seeder and size constraints, ordering | `GrabService.Eligible` and `PreferRequestedQuality`, `GrabService.cs:249-262` and `:417` |
| Rejection reasons and the "why" text | `EpisodeRejections.Explain` and `GrabFailure.Explain` |
| Metadata-confirmed admission | `engine.AddAsync(... RequireMetadata = true)`, `GrabService.cs:354-360` |

New code is limited to:

- `EpisodeLadder.BuildPackRungs(title, season, mediaType, aliases, floor, mapping)`, a sibling of `BuildEpisodeRungs` built from the same private helpers. Rungs, in order: `"{Title} S{season:00}"` with `Filters.Season = season` and no episode; `"{Title} Season {season}"`; for season 1 of anime, `"{alias}"` and `"{alias} batch"` in the anime category (Nyaa batches are usually named without a season, for example `[Group] Haibane Renmei (BD 1080p)`); when a quality floor is set, the first rung is repeated with `"{floor}p"`, exactly like the `preferred-quality` rung. At most 6 distinct searches per pack attempt.
- `EpisodeRejections.PackScope(candidate, season, mapping)`, the inverse of `IsPack`: accepts a single-season pack for this season, or a season-less batch while the target is season 1 (or an AniList entry whose mapping says the batch is this cour). Multi-season bundles are rejected with reason `multi_season` unless every season the bundle names is itself currently pack-eligible and fully aired for this work (see failure table). Episode ranges (`01-12`) that include at least one missing episode are accepted as packs.
- Seeders: packs need at least 1 seeder. There is no relaxed zero-seeder pack rung, because every pack candidate costs a metadata probe.

Candidates are ordered by the existing `Eligible` ordering. The first 3 in that order are probed (section 2). Among the probed packs that pass verification, the one covering the most still-missing episodes wins, ties broken by the original rank.

## 2. Verification before download

### 2.1 How metadata is obtained today

- `TorrentEngineService.AddAsync` (`TorrentEngineService.cs:98-178`): a `.torrent` URL is fetched (`FetchTorrentAsync`); for a magnet with `RequireMetadata`, a cached `.torrent` is reused (`LoadTorrentFile`), otherwise `backend.DownloadMetadataAsync` runs behind `_metadataGate` (4 concurrent, `:44`) with `MetadataTimeoutSeconds` (default 90, `EngineOptions.cs:58`). Hash mismatches are refused. On timeout it logs "Candidate {Hash} supplied no usable metadata; trying another release" (`:171`).
- `MonoTorrentBackend.DownloadMetadataAsync` (`MonoTorrentBackend.cs:38-39`) is `ClientEngine.DownloadMetadataAsync(MagnetLink)`, which returns the raw info dictionary bytes without admitting a transfer. `MonoTorrent.Torrent.Load(bytes).Files` then gives each file's path, length and piece range, as `ReleaseSwap.IncompleteFilesFromMetadata` already does (`ReleaseSwap.cs:103-112`).

### 2.2 The change

Extract the metadata block of `AddAsync` into one private method, `ResolveMetadataAsync(request, ct)`, and expose a read-only engine operation on `ITorrentEngine`:

`Task<EngineInspectResult> InspectAsync(EngineInspectRequest request, CancellationToken ct)` returning the info hash, piece length, and the file list (index, torrent path, length, first and last piece), or a failure (`no_metadata`, `hash_mismatch`, `timeout`).

- It uses the same `_metadataGate`, the same timeout, the same `.torrent` cache (`SaveTorrentFile`), so a later `AddAsync` for the chosen pack never fetches metadata twice.
- It never creates an `EngineTorrent` row and never loads a manager.
- `AddAsync` keeps its current behaviour by calling the same `ResolveMetadataAsync`. One metadata path, not two.

### 2.3 Mapping files to episodes

A new pure function in Core, next to `ReleaseEpisodeParser` so both the grab side and the engine side can use it: `PackFileMap.Map(files, season, mapping, packName)`.

Per file:

1. Classify with one shared rule. Today the "is this video content, a sample, an extra or a subtitle" rule exists three times (`ContentLayoutPolicy.Role`, `ContentLayoutPolicy.cs:88-99`; the regex in `TitleService.PackCoverage`, `TitleService.cs:255-257`; `NextEpisodeFile`). Move `Role` to Core and have `ContentLayoutPolicy.Role` delegate to it. Only `Video` files are mapped. Samples, anything under an extras folder, `NCOP`/`NCED`/`OVA`/specials (`ReleaseEpisodeParser.SpecialType`) and subtitle files are ignored (never selected).
2. Parse the file name with `ReleaseEpisodeParser.Parse` (handles `S01E05`, `1x05`, `Episode 5`/`Ep 05`/`E05`, `Show - 05`, `[Group] Show - 05 [1080p]`, `05v2`, `S2 - 05`).
3. Season context when the name has none: the nearest parent folder that is a season folder (`Season 02`, `S02`, `Series 2`, same pattern as `ContentLayoutPolicy.SeasonSegment`), else the pack's own season from its name, else season 1 for a season-less anime batch.
4. Bare numbers (`05.mkv`, `05 - Title.mkv`) are accepted only inside a pack, only when every video in the same folder is a bare number, and only when the numbers form a run that fits the provider episode count.
5. Absolute numbering: when the AniList mapping has an `AbsoluteOffset` (or `FranchiseSeason` with `SeasonEpisodeOffset`), a file numbered `offset + n` maps to local episode `n`, reusing the exact arithmetic of `EpisodeLadder.MatchesTargetEpisode` (`EpisodeLadder.cs:245-262`). If both local and absolute readings fit, the reading that matches the pack name's own range wins; if still ambiguous, the pack is rejected (`ambiguous_numbering`).
6. Double episodes (`S01E01E02`, `E01-E02`) map to both episodes; the file is used only if every episode it contains is still missing, otherwise it is skipped (never take an episode someone else owns).
7. Two videos for one episode (a `v2`, or two encodes): prefer the higher version, then the larger file. If they differ by more than 2x in size, reject that episode only (`duplicate_episode_files`).

### 2.4 Hard rejections (whole pack)

- Any archive or split archive in the file list (`.rar`, `.r00`-`.r99`, `.zip`, `.7z`, `.001`, `.tar`, `.gz`): `archive`. Selective download cannot work through an archive.
- Any executable or shortcut (`.exe`, `.scr`, `.bat`, `.cmd`, `.lnk`, `.msi`, `.js`, `.vbs`): `unsafe`, reusing the unsafe-name list in `SearchFilters.cs:12,36-55`.
- Disc structures (`VIDEO_TS`, `BDMV`, `.iso`, `.img`): `disc_image`.
- No video file maps to this season: `wrong_season`.
- More than half of the mapped videos belong to another season (the name said S01, the files say S02): `wrong_season`.
- Video file names that carry a title which fails `ReleaseMatchesWork` against the accepted names: `other_work`. Files with no title in the name are judged by the pack name only.
- Resolution stated in file names below the floor even though the pack name meets it: `mislabeled_quality`.

### 2.5 Partial and mislabeled packs

- Gaps: inside the pack's own numbered run, a missing number (1-13 but no 7) marks the pack partial. A partial pack is rejected (`partial_pack`) unless every still-missing episode is present in it, in which case it is accepted and only those files are selected.
- Count sanity: more mapped episodes than the provider count plus 2 means the numbering is off (absolute vs season numbering, or a different cut): `mislabeled`.
- Size sanity: a mapped episode file under 25% of the median episode file in the same pack is treated as truncated or fake and that episode is not selected (`implausible_size`). If that leaves nothing needed, the pack is rejected.
- Per-file size constraints: the caller's `MaxSizeBytes` constraint and quality floor apply per selected file, not to the pack total.

Every rejection is recorded like an episode rejection (same `CandidateRejection` record), so the owner sees, for example, "3 season packs checked: 1 archive, 1 wrong season, 1 had no peers".

## 3. Selective download

### 3.1 What is selected

Only the video files mapped to episodes that are still missing at claim time (section 4). Nothing else: no samples, extras, subtitles or other episodes.

### 3.2 Persisted selection

MonoTorrent file priorities already exist behind `ITorrentBackend.SetSelectedFilesAsync` (`ITorrentBackend.cs:62`, `MonoTorrentBackend.cs:413-423`, `Priority.DoNotDownload`). The problem is that every keep path resets it to "all files":

| Call site | Today | Change |
| --- | --- | --- |
| `TorrentEngineService.cs:240` (stream row adopted as keep) | `SetSelectedFilesAsync(hash, null)` | use `SelectionOf(row)` |
| `TorrentEngineService.cs:413` (re-add after restart or rehydrate) | reselect all | use `SelectionOf(row)` |
| `TorrentEngineService.cs:1005` (force re-announce) | reselect all | use `SelectionOf(row)` |
| `TorrentEngineService.cs:1035` (resume) | reselect all | use `SelectionOf(row)` |
| `MonoTorrentBackend.cs:186` (non-keep deselect before start) | only for stream/prewarm | also apply `spec.SelectedFiles` before `StartAsync`, so no unselected piece is ever requested |

`SelectionOf(row)` reads a new `EngineTorrent.SelectedFilesJson` (null means all files, which keeps every existing transfer unchanged). `EngineAddRequest` gets `SelectedFiles` and `TorrentBytes` is passed from the inspect step so the manager starts with metadata and the selection is applied before the first piece request.

### 3.3 Completion

- Monitor rule (`TorrentEngineService.cs:1417`): today a keep transfer completes only when `live.Files.All(f => f.Selected)`. A pack would never complete, so requests would never be fulfilled and the transfer would never park. Change to: complete when the live selection equals the persisted selection and every selected file is complete.
- Manifest (`BuildManifest`, `TorrentEngineService.cs:1558-1568`): today every file must exist at full size. For a selective transfer, selected files must exist at full size; unselected files are written with `Path = null`, which is already the convention for "not on disk" (`DeletionController.cs:92-94`, `TitleService.cs:255`). Index alignment with the torrent file list is kept, so `AcquisitionTarget.FileIndex` still points at the right entry after layout.
- Backend snapshot progress already counts only selected bytes (`MonoTorrentBackend.cs:462-474`). Snapshot `SizeBytes` is `m.Torrent.Size` (`:491`), the whole pack. For a selective transfer it becomes the selected bytes, so Downloads, `QueuedReservedBytes` (`DownloadQueue.cs:217`) and storage estimates stop counting unselected episodes.

### 3.4 Storage cap

- The cap check at admission (`TorrentEngineService.cs:273-274`) uses `request.ExpectedSizeBytes`, today the candidate's full size (`GrabService.cs:359`). For a pack it is the selected bytes plus the boundary allowance: for each contiguous run of selected files, up to 2 pieces (one at each end) of neighbour data. Piece length comes from the inspect result.
- If the selected set does not fit, the pack step drops episodes from the end of the season until it fits, and if none fits, it reports `storage_limit` exactly like a single episode (`StorageFacts.Refusal`).
- Disk full during download is the engine's existing error path (`live.State == "error"`, `TorrentEngineService.cs:1400-1407`), which marks targets failed; section 6 covers the outcome.

### 3.5 Boundary pieces and partial neighbour files

Pieces are fixed-size blocks across the concatenated files. A piece that straddles a selected and an unselected file must be downloaded whole, and MonoTorrent writes every byte of it to the files it covers, so the unselected neighbour appears on disk as a partial file. This is the most dangerous side effect of selective download:

- `DropWrapperAsync` (`MonoTorrentBackend.cs:239-255`) moves every file of a kept multi-file torrent into the season folder without its release folder. A partial neighbour would land in the season folder as, say, `Haibane Renmei - 04.mkv` with a few MB of real data at one end: it looks like media to the library, Plex and our own `LocalFiles` scan.

Mitigations, all required:

1. Flatten only selected files. `DropWrapperAsync` skips files whose priority is `DoNotDownload`; they stay in the release folder, which is ours alone.
2. Spike first: check whether MonoTorrent 3's `EngineSettings.UsePartialFiles` is available in our version. If so, turn it on for selective transfers so incomplete files carry the `.!mt` suffix until complete; a partial neighbour then never has a media extension.
3. On completion, before layout and validation, delete every unselected file of this transfer that exists on disk and is not complete, then remove the release folder if it is empty (`DeleteEmptyTree`, `MonoTorrentBackend.cs:257-265`). Never delete a path another transfer's manifest or live file list claims, reusing the protection list built in `ReleaseSwap.cs:42-46` and `PartialFilesToRemove` (`ReleaseSwap.cs:114-126`).
4. `CompletedLayoutFinalizer.FinalizeDetailedAsync` (`CompletedLayoutFinalizer.cs:71-79`) validates and lays out only manifest entries with a path, so it never probes or moves a neighbour fragment.
5. The same cleanup runs when a pack transfer is removed, paused for good, or has files released (section 5, swap and delete).

## 4. Claiming: one owner per episode

### 4.1 The rule

An episode is owned by at most one transfer at a time. Ownership is the acquisition target row: `AcquisitionTarget.InfoHash` (plus `FileIndex` for a pack). A pack never takes an episode that is already downloading, queued in the engine, or on disk.

### 4.2 Claim sequence

1. Inspect the pack and build the file map (no locks held; this is the slow part).
2. Re-read the targets for the unit. Drop from the map every episode whose target now has an `InfoHash`, whose status is not `queued`, or which the title data shows as already on disk (the same evidence `TitleService.Detail` uses: a downloaded target or `PackCoverage`, `TitleService.cs:158-161`).
3. In one database transaction, compare-and-set each remaining target: `WHERE TargetKey = @key AND Status = 'queued' AND InfoHash IS NULL` set `InfoHash = packHash, FileIndex = @index, FilePath = @torrentPath, Status = 'downloading'`. Episodes whose update affected 0 rows lost a race and are dropped.
4. If nothing was claimed, stop (no transfer is created).
5. Admit the pack with `SelectedFiles` = the claimed file indices and `ExpectedSizeBytes` from section 3.4.
6. If admission fails, release every claim in the same way `SettleAsync` handles a failed episode (back to `queued`, `InfoHash = null`, `FileIndex = null`) and record the reason.

`SettleAsync` (`WantedQueue.cs:125-139`) keeps its current semantics for singles: a failure settles only a `queued` row, a success settles `queued` or `failed`, so a pack claim is never overwritten by a late single failure.

### 4.3 Single-episode paths that must respect claims

- `GrabService.GrabCore` reuse check (`GrabService.cs:77-84`) matches on `EngineTorrent.QueueKey`, which is one key per transfer. Add a second check: a target for this work, season and episode whose `InfoHash` points at a non-error, non-removed transfer. If found, answer "This episode is already downloading as part of a season pack." and return that hash, like the existing "already started" answer.
- An explicit episode click calls `SeedAsync(..., restart: true)` (`TitleController.cs:149`), which clears `InfoHash` and `FilePath` (`WantedQueue.cs:115`). For a target owned by a healthy pack file, `restart` must not reset it; the click reports the pack as above. Only a failed or released pack file can be restarted.
- The wanted queue already ignores targets with an `InfoHash` (`WantedQueue.cs:176-178, 213-214`), so a claimed episode is never searched again while its pack is healthy.

### 4.4 A single-episode release shows up later

No automatic replacement. The pack is the owner and the wanted queue does not search claimed episodes, so nothing races. The owner can still replace one episode by hand with "Find another release" (section 5, swap), which releases that one file from the pack first. If the pack file stalls or fails (section 6), the claim is released and the single pipeline takes the episode back; if a single is found then, it wins normally.

## 5. Data model impact

Today one transfer is about one episode: `EngineTorrent.QueueKey` names one episode, and most readers take the first target for a hash or parse the release name.

### 5.1 Smallest safe model

No new table. The per-episode mapping rows already exist: `AcquisitionTarget` is one row per wanted episode and already has `InfoHash` and `FilePath` (`Data/Entities/AcquisitionTarget.cs`). `FilePath` is only ever cleared today, never set. Add:

| Entity | New column | Meaning |
| --- | --- | --- |
| `AcquisitionTarget` | `FileIndex int?` | Torrent file index this episode owns. Null means the whole transfer is this episode (every existing row). |
| `AcquisitionTarget` | `RealMisses int` (default 0) | Real single-episode misses (section 1.3). |
| `EngineTorrent` | `SelectedFilesJson string?` | Persisted file selection. Null means all files (every existing row). |

`FilePath` is set at claim time to the torrent-relative path (display and diagnostics). The on-disk path is always resolved through the manifest entry at `FileIndex`, because layout moves files after completion.

`EngineTorrent.QueueKey` for a pack is the lowest claimed episode's key, so queue ordering (`DownloadQueue.cs:99-100`) sorts it with its season. Nothing may treat a pack's `QueueKey` as "the episode of this transfer"; readers use targets instead.

One migration adds the three columns. All defaults leave existing behaviour byte for byte the same.

### 5.2 Every place that assumes one transfer is one episode

| Area | Where | Today | Change |
| --- | --- | --- | --- |
| Grab reuse | `GrabService.cs:77-84` | "already started" by `QueueKey` | also check pack-owned targets (4.3) |
| Explicit episode restart | `TitleController.cs:149`, `WantedQueue.cs:115` | restart clears the target | never reset a healthy pack claim (4.3) |
| Engine selection resets | `TorrentEngineService.cs:240, 413, 1005, 1035` | reselect all files for keep | `SelectionOf(row)` (3.2) |
| Completion | `TorrentEngineService.cs:1417` | requires all files selected | selected files complete (3.3) |
| Manifest | `TorrentEngineService.cs:1558-1568` | every file at full size | unselected entries `Path = null` (3.3) |
| Size and reservation | `MonoTorrentBackend.cs:491`, `DownloadQueue.cs:217`, `TorrentEngineService.cs:273-274` | full torrent size | selected bytes (3.3, 3.4) |
| Flattening | `MonoTorrentBackend.cs:239-255` | moves every file | selected files only (3.5) |
| Downloads grouping (server) | `ClientTorrentsController.AnnotateAcquisitionIntentAsync`, `ClientTorrentsController.cs:107-190`; `IntentByHash`, `:195-203` | several targets on one hash collapse to a season row with no episodes | add `episodes: [{ season, episode, fileIndex, progress, state }]` to the torrent JSON for pack rows, from targets plus live per-file progress (`EngineFileInfo`, `TorrentEngineService.cs:848`) |
| Downloads grouping (web) | `web/src/app/downloads/grouping.ts:401-420` (pack subsumes loose episodes), `:532` (`torrent.episode ?? parsed.episode`), `:613-621` (`seriesEpisodeTally` skips packs); `series-download-dialog.tsx` episode cards | a pack is one card and hides loose singles of the season | one episode card per claimed episode with that file's own percent; a selective pack never subsumes loose episodes it does not own; tally counts claimed episodes; the pack itself is shown once as the source ("Part of Season 1 pack") with a whole-pack overflow |
| Title page progress | `TitleService.Reconcile`, `TitleService.cs:31-51`; `Progress`, `:54-71`; `Detail`, `:175-196` | target progress = whole transfer progress | when `FileIndex` is set, use that file's progress (live, or 1 when the manifest entry has a path); a failed pack file fails only its own target |
| Library and playback resolution | `StreamService.IndexAsync`, `StreamService.cs:44-47` and `:88-91`; `BrowseService.ResolveNextEpisode`, `BrowseService.cs:444-460`; `PrewarmController.cs:231-252`; `NextEpisodeFile.EpisodeFileInTorrent`, `NextEpisodeFile.cs:50` | pick the file by episode name or main-feature heuristic | prefer the target's `FileIndex`; skip manifest entries with no path; list only selected files of a live selective transfer, so Play never starts an unowned episode (`OpenStreamAsync` would raise a `DoNotDownload` file to `Normal`, `MonoTorrentBackend.cs:431`) |
| Pack coverage on title page | `TitleService.PackCoverage`, `TitleService.cs:246-266` | verified files of a pack | already skips entries with no path; no change beyond the shared video classifier |
| Request fulfilment | `RequestDecisionService.AttachAsync`, `:198-212`; `CheckFulfilledAsync`, `:262-285`; `MediaRequestService.cs:235` | fulfilled when every grabbed hash completes and no target is wanted | works once completion means "selected files complete"; the pack hash is added once |
| Release swap, library side | `ReleaseSwapService.cs:55-63` | first target by hash; season scope for a pack name | for a pack-owned episode: scope is that episode, the search is the single-episode ladder, and the pick releases the file first (below) |
| Release swap, engine side | `ReleaseSwap.cs:20-100`, `CarrySwapLinks`, `:128-157` | replaces the whole transfer and moves every target to the new hash | whole-pack swap is refused ("This release covers several episodes. Replace one episode at a time."); per-episode swap = new `ReleaseFileAsync(hash, fileIndex)` then the normal single send |
| Delete one episode | `DeletionController.Plan`, `DeletionController.cs:78-110`, blocked copy at `:33`; the Downloads dialog per-episode delete | blocked for packs, or removes the whole transfer | when the episode's target has `FileIndex`, delete = `ReleaseFileAsync(hash, fileIndex, deleteFile: true)`; the last owned file removes the transfer |
| Seeding and removal | `TorrentEngineService.cs:934-953` (seeding restore), `RemoveManyAsync`, `:1052-1119`; `RetentionSweeper.cs:21-60` | whole transfer | seeding restore applies the selection; remove deletes selected files plus leftover fragments (3.5); the sweeper handles only stream/prewarm and needs only the size fix |
| Timeline | `TimelineService.cs:97` | label from `QueueKey` or release name | label from targets: "Season 1 pack, 9 episodes" |
| Notifications | `DownloadNotificationWatcher.cs:30-50` | one "Download completed" named from the release name | same single event, named from targets: "Haibane Renmei S01: 9 episodes ready" |
| External client removal | `ExternalClientRegistry.cs:74` | deletes targets by hash | unchanged (built-in engine only; packs are never sent to external clients in v1) |

New engine operation used by swap and delete: `ReleaseFileAsync(hash, fileIndex, deleteFile)`. It sets the file to `DoNotDownload`, removes the index from `SelectedFilesJson`, clears the owning target (`InfoHash = null`, `FileIndex = null`, status `queued` for swap, removed for delete), deletes the file and any fragment it leaves when asked, and removes the whole transfer when no selected file is left. For a completed (parked, detached) pack it only deletes the file and sets its manifest entry `Path = null`.

## 6. Failure modes

Copy follows the rules: plain words, what happened, what to do, no em dashes, no internal names.

| Error | Detection | Outcome the user sees |
| --- | --- | --- |
| Wrong show | pack name fails `ReleaseMatchesWork`, or titled file names fail it (2.4) | Nothing downloads. Activity: "Checked a season pack for another show. Still looking for episode 5." |
| Wrong season | no mapped video in the target season, or most videos in another season (2.4) | Nothing downloads. Activity: "The season pack held a different season. Still looking." |
| Multi-season bundle | `IsMultiSeason` or files in several seasons, not all wanted and aired (1.5) | Skipped. Activity: "Skipped a pack with several seasons." |
| Incomplete or partial pack | gaps inside the pack's own run and some missing episode not in it (2.5) | Skipped, next pack tried. If it covers every missing episode it is used and only those files download. |
| Mislabeled numbering | mapped count above provider count plus 2, or ambiguous absolute vs season numbering (2.3, 2.5) | Skipped. Activity: "The pack's episode numbers did not match this season." |
| Dead magnet or no metadata | `InspectAsync` timeout or no peers (2.2) | Next pack tried. If none: "Season packs for Season 1 have no one sharing them right now. We will keep looking." |
| Hash mismatch | inspected bytes hash differs from the advertised hash (`TorrentEngineService.cs:132, 165, 177`) | Skipped as not this release. |
| Archive inside | `.rar`, `.zip`, `.7z` and split parts (2.4) | Skipped. Activity: "Skipped a pack that only has compressed files." |
| Unsafe files | executables or shortcuts (2.4) | Skipped. Activity: "Skipped a pack with unsafe files." |
| Low quality | pack name below floor, or file names below floor (`Eligible`, 2.4) | Skipped. Episode stays wanted with its quality reason, same as singles. |
| Huge size | selected bytes plus boundary allowance above the storage cap (3.4); per-file `MaxSizeBytes` | Episodes that fit start; the rest stay wanted. If none fit: the existing storage message and its "raise the limit" action. |
| Disk full during download | engine error state (`TorrentEngineService.cs:1400-1407`) | Pack transfer shows the existing disk error. Claimed episodes go back to wanted with "Your download drive is full. Free some space and we will retry." |
| Same episode twice in one pack | two videos map to one episode (2.3 rule 7) | Best file chosen; if unclear, that episode is not selected and stays wanted. |
| Duplicate owner race | claim compare-and-set affects 0 rows (4.2) | That episode is dropped from the selection silently; its other owner keeps it. |
| Explicit click on a pack episode | reuse check finds the pack claim (4.3) | "This episode is already downloading as part of Season 1." |
| Pack stalls mid-way | existing stall and health signal (`TransferHealth`, `Media/Common/Stall.cs`) shows no progress on a claimed file for 6 hours with no seeders | Unfinished claimed files are released (`ReleaseFileAsync`), those episodes go back to wanted with "The season pack stopped downloading. Looking for single episodes again.", and the pack hash is recorded in `ReleaseAttempts` for that season so it is not picked again. Finished episodes stay. |
| Partial neighbour files | boundary pieces (3.5) | Never visible: they stay in the release folder or carry `.!mt`, and are deleted on completion or removal. |
| Invalid media after completion | `CompletedMediaValidator` marks invalid (`CompletedLayoutFinalizer.cs:321-342`) | Today every target of the hash fails. Change: with `FileIndex`, only the targets whose file failed validation fail and go back to wanted. |
| User deletes one episode | per-episode delete (5.2) | "Deleted episode 4. The rest of the season pack stays." |
| User swaps one episode | per-episode "Find another release" (5.2) | Picker shows single releases for that episode; on pick, "Episode 4 now uses the release you picked." Whole-pack swap: "This release covers several episodes. Replace one episode at a time." |
| Request fulfilment | pack hash in `GrabbedHashes`, completion rule (3.3) | Request moves to fulfilled when the pack's selected files and every other grabbed transfer finish. Partial stays partial with the existing copy. |
| Restart mid-flow | claims and selection are persisted; `SelectionOf(row)` on re-add (3.2) | Pack resumes with the same files; nothing else starts downloading. |
| Season still airing or unknown | `GetSeasonAiringAsync` not `Finished` (1.4) | No pack. `why`: "Season still airing, or we could not confirm it has finished. Waiting for single episodes." |
| Search refused or site busy | not a real miss (1.2) | No change from today: retried soon, no pack, no try spent. |
| Pack fallback finds nothing usable | all pack candidates rejected | Episode stays wanted. The existing single owner notification (`NeedsOwnerAsync`) includes the pack result: "No single episode or usable season pack found. Pick a release yourself." |

## 7. Task breakdown

Each task is sized for one agent in about 30 minutes to 2 hours, lands with its own verification, and does not change behaviour for existing transfers.

| # | Deliverable | Task | Estimate | Order |
| --- | --- | --- | --- | --- |
| 1 | Spike | Confirm MonoTorrent version: `UsePartialFiles`, where boundary bytes are written, priority applied before start with torrent bytes. Loopback swarm with a 3-file torrent. Report only. | 1.5 h | 1 |
| 2 | Data | Migration: `AcquisitionTarget.FileIndex`, `AcquisitionTarget.RealMisses`, `EngineTorrent.SelectedFilesJson`. | 1 h | 2 |
| 3 | Engine | Extract `ResolveMetadataAsync` from `AddAsync`; add `ITorrentEngine.InspectAsync`. | 2 h | 3 |
| 4 | Engine | `SelectedFiles` on `EngineAddRequest`; persist; `SelectionOf(row)` at the four reset sites and before start in `MonoTorrentBackend.AddAsync`. | 2 h | 4 |
| 5 | Engine | Completion rule, manifest with null paths, selected `SizeBytes`, reservation and cap on selected bytes plus boundary allowance. | 2 h | 5 |
| 6 | Engine | Boundary fragments: flatten selected only, optional `.!mt`, cleanup on completion and removal with the shared protection list. | 2 h | 6 |
| 7 | Engine | `ReleaseFileAsync(hash, fileIndex, deleteFile)` for live and parked transfers. | 2 h | 7 |
| 8 | Core | Move the video/extra/subtitle classifier to Core; `ContentLayoutPolicy.Role`, `TitleService.PackCoverage` and `NextEpisodeFile` use it. | 1.5 h | 3 |
| 9 | Core | `PackFileMap.Map` with rules 2.3 to 2.5 and hard rejections. | 3 h | 4 |
| 10 | Metadata | `IAirDateLookup.GetSeasonAiringAsync` in `AirDateLookup` (AniList, TMDB, TVmaze), fail closed. | 1.5 h | 3 |
| 11 | Grabs | `GrabFailure.IsRealMiss`, `RealMiss` on `EpisodeTransfer`, persisted `RealMisses` in `Settle` (on top of season-speed). | 1.5 h | after season-speed merges |
| 12 | Grabs | `EpisodeLadder.BuildPackRungs`, `EpisodeRejections.PackScope`, extract the shared search call from `Episode`. | 2 h | 5 |
| 13 | Grabs | `GrabService.SeasonPack`: search, probe up to 3, map, choose, claim with compare-and-set, admit, release claims on failure. | 3 h | 6 |
| 14 | Grabs | `WantedQueue` pack step after the fanout, aired gate, `why` and Activity text, owner notification copy. | 2 h | 7 |
| 15 | Grabs | Claim respect in `GrabCore` reuse check and `SeedAsync(restart)`. | 1 h | 7 |
| 16 | Title | `TitleService` per-file progress and failure for `FileIndex` targets. | 1.5 h | 8 |
| 17 | Playback | `StreamService`, `BrowseService.ResolveNextEpisode`, `PrewarmController` prefer `FileIndex`; live listing shows selected files only. | 2 h | 8 |
| 18 | Downloads API | `episodes` array on pack rows in `AnnotateAcquisitionIntentAsync`. | 1.5 h | 8 |
| 19 | Downloads web | Grouping and dialog: one card per claimed episode, no subsuming by selective packs, pack source label, per-episode delete and swap wired to the new actions. Visual check at 390, 768, 1280. | 3 h | 9 |
| 20 | Swap and delete | `ReleaseSwapService` and engine `ReleaseSwap` per-episode path; whole-pack swap refused; `DeletionController` per-file delete. | 2.5 h | 9 |
| 21 | Stall | Release unfinished claimed files of a stalled pack and record the attempt. | 1.5 h | 9 |
| 22 | Surfaces | Timeline and notification labels from targets; invalid-media fails only the bad file's target. | 1.5 h | 9 |
| 23 | Docs | Update `docs/rules.md`, `AGENTS.md` Downloads section, `docs/AGENT-GUIDE.md:53`, `docs/one-pipeline.md` "Implemented path". | 0.5 h | 10 |
| 24 | QA | Live acceptance run (section 8) with a coverage table. | 3 h | 11 |
| 25 | Critic | Independent review of the merged slices against this plan and the failure table. | 1 h | 12 |

Total about 47 hours of agent work. Tasks with the same order number can run in parallel. Task 11 waits for `fix/season-speed` to merge because it edits the same `Settle` block.

## 8. Acceptance tests (live, no unit tests)

Run on a fresh instance built from the merged branch, an isolated data directory and download root, ports 3921-3940, never 3000, never the owner's `%LOCALAPPDATA%\TorrentFlow` or `C:\Torrents`. Server behaviour through the HTTP API (`/api/wanted`, `/api/client/torrents`, `/api/title/...`, `/api/requests/...`), UI only for the Downloads dialog and title page with Playwright MCP at 390, 768 and 1280. Cap the download rate so the run checks selection and mapping, not full payload.

| # | Case | Steps | Pass when |
| --- | --- | --- | --- |
| 1 | Pack-only anime: Haibane Renmei S1 | Download season. Wait for 2 real misses per episode. | `/api/wanted` `why` shows 2 real misses, then a pack claim. One transfer; `SelectedFilesJson` lists exactly the 13 episode videos; no NCOP/NCED/extras selected; every target has `FileIndex`; Downloads dialog shows 13 cards with their own percent. |
| 2 | Partly covered season | Older western show (for example a 2000s sitcom season) where some singles exist. Download season. | Singles start first. Only still-missing episodes are claimed by the pack. No episode has two owners (query targets by hash). Pack size equals the selected files plus at most 2 pieces per run. |
| 3 | Airing season | A currently airing show's current season with missing episodes. | No pack is ever inspected. `why` says the season is still airing. |
| 4 | Refused search | Turn every source off, or point one at a local fixture that returns 429 and 503. | `RealMisses` stays 0, no pack step runs. |
| 5 | Archive and wrong season packs | Local Torznab fixture returning a `.rar` pack and a mislabeled season pack before a good one. | Both rejected with the right reasons in Activity; the good one is chosen. |
| 6 | Dead pack | Fixture magnet with no peers first. | `InspectAsync` times out once, next pack used, no engine row for the dead one. |
| 7 | Boundary fragments | During case 1 or 2, list the season folder and release folder while downloading and after completion. | No partial media file ever appears in the season folder; after completion no unselected fragment remains. |
| 8 | Restart mid-download | Stop and start the instance during case 2. | Same selection after restart; unselected episodes never start. |
| 9 | Explicit click on a claimed episode | Click Download on a pack-owned episode. | "Already downloading as part of Season N"; no new transfer. |
| 10 | Delete one episode | Delete one pack episode from the Downloads dialog. | Only that file is gone; other cards unchanged; target back to not downloaded. |
| 11 | Swap one episode | "Find another release" on a pack episode, pick a single. | Pack loses that file; the single owns the episode; the pack keeps the others. |
| 12 | Request | Requester asks for the pack-only season; owner approves (by hand, then with auto-approve). | Request goes partial then fulfilled when the pack's selected files finish; a repeat request creates nothing new. |
| 13 | Storage cap | Set a cap smaller than the selected set. | Only the episodes that fit are claimed; the rest stay wanted with the storage reason. |
| 14 | Playback | Play a finished pack episode and a still-downloading one. | The right file plays; the player never lists unowned episodes of the pack. |

Report a coverage table marking each case pass, fail or blocked, with the JSON and screenshots as evidence.

## 9. Open decisions for the owner

1. Miss threshold: 2 real misses per episode (default here) or 3, matching `TriesBeforeAskingOwner`.
2. Partial packs: accept a pack with gaps when it still covers every missing episode (default here), or reject any pack with gaps.
3. Subtitles: ignored per the brief. Many anime batches ship `.ass` files beside the video; selecting the matching sidecar for each claimed episode costs a few KB.
4. Multi-season bundles: rejected in v1 even when every season is wanted, then allowed in a follow-up once v1 is proven.

## 10. Top risks

1. Boundary fragments flattened into the season folder (`DropWrapperAsync` moves every file) would look like real episodes to every library scanner.
2. Four engine paths reselect all files for kept transfers; missing one turns a selective pack into a full-season download that bypasses the storage check.
3. Wrong file mapping (absolute vs season numbering, mislabeled packs) marks the wrong content as an episode that is downloaded, and nothing re-searches it.
4. Ownership races between the pack claim and explicit clicks (`SeedAsync` restart clears the hash) give one episode two owners and two downloads.
5. Completion and size rules assume all files: without the fix a pack never completes, never parks, never fulfils a request, and reserves the whole pack's size.
