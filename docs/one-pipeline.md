# One episode acquisition pipeline

## Trace before the repair

- **Title episode button:** `POST /api/title/{workKey}` verifies provider identity, calls `EpisodeSearchIdentity.ResolveAsync` (exact-title/year-guarded AniList recovery), then `GrabService.Grab → Episode`. A TVmaze/TMDB My Hero Academia page can therefore search as anime with AniList aliases.
- **Title season/request buttons:** the same title controller resolves identity and `SeasonFanout` runs that episode operation with four workers; engine admission remains serialized. `POST /api/requester/requests → POST /api/requests/{id}/approve → RequestGrabber` also uses `SeasonFanout`, but constructs its input directly from `MediaRequest` and **never resolves the anime search identity**.
- **Query/source divergence:** `EpisodeLadder` selects the category from that input. Requests retain `tv`, so `SourceRegistry.Active("torrent", "series")` excludes anime-only Nyaa; additionally, request-lane-only quality queries/ranking differ from the episode button. Swap builds another input from the saved (still `tv`) Work, so its source chips also omit Nyaa.
- **Automation divergence:** `GrabService.Grab` dispatches background work to `Hunt`, not `Episode`; `SearchAnimeHunt` implements another search loop, selection and seeder-wait policy. Thus sharing the class was not sharing the action. Engine admission was reported as success before peers supplied metadata, allowing dead advertised releases to become “started”.
- **Request state/season investigation:** request approvals store hashes but partial outcomes become `Failed`, even though some episodes started. Request season scope comes from persisted `MediaRequest.Seasons`; displayed download seasons can instead come from parsed release names when exact acquisition targets are absent. The reported extra Season 2 needs reproduction against persisted request/transfer coordinates; no cause is assumed yet.

## Required invariant

Season, request and watchlist episode acquisitions must resolve the same identity and execute the same episode search, selection and metadata-confirmation operation. Queue lane, scheduling and bounded fanout are policy, not alternate acquisition pipelines. Explicit source disablement remains respected.

## Implemented path

`title episode / title season / RequestGrabber / watchlist / episode auto-rule`
→ **`GrabService.Grab`**
→ guarded catalog/AniList identity recovery
→ **`EpisodeLadder`**
→ work/episode/quality/audio checks
→ metadata-confirmed engine admission.

- The separate `Hunt` and `SearchAnimeHunt` search implementations were removed. Four `SeasonFanout` workers call the same operation. Background seeder grace and scheduling remain policy around it.
- Trusted provider genre (`Anime`, or Japanese `Animation`) can recover anime when AniList is unavailable, provided title/year still match. This changes search identity, not provider coordinates: TVmaze seasons remain TVmaze seasons. Saved Work type/aliases carry the recovery into retries and release swaps.
- Anime includes enabled Nyaa. Swap uses the same category, aliases, episode mapping and quality ladder. Persisted acquisition/queue coordinates take priority over torrent filenames.
- Anime dubbed-only releases are excluded by default; dual audio remains eligible. Sub/multisub/dual releases are preferred. `TorrentFlow:Library:PreferAnimeDub=true` explicitly enables/prefer dubs.
- Automatic acquisition sets `RequireMetadata`. Valid cached/downloaded torrent metadata is reused; otherwise a metadata-only peer lookup runs before admission. Four probes maximum across all callers; the existing metadata timeout applies. Failed/hash-mismatched candidates create no engine transfer and the shared ladder tries the next candidate. Metadata confirmation does **not** prove full payload availability or successful playback.
- Queued torrents are also metadata-confirmed without bypassing active-download limits. Search-budget exhaustion waits rather than failing the remaining season; ordinary interactive searches retain their throttle.
- Episode auto-rules still perform their user-configured discovery query, then delegate acquisition to the same episode operation with source, size, seeder and resolution restrictions preserved. Non-episode rules retain their explicitly requested release scope.
- Requests with some started episodes use `partial`, retain their transfer hashes and expose owner-only `POST /api/requests/{id}/retry`. Retry reuses healthy kept transfers by exact Work/episode coordinate and searches only missing/failed ones. Legacy failed requests containing hashes migrate to partial during the request sweep.

## Live evidence — 2026-09-28

The assigned `3928` process (PID 50528, older build) could not be stopped by this account: access denied. Verification therefore used **3929**, with an isolated database/download root beneath `D:\code\memtest\anime-live\verification`. No ports 3930/3000 or owner media directories were used. Requester JWT simulation used local ports 3936/3937 and tunnel listener 3927.

- A real requester created MHA seasons **5,6**, and the owner approval endpoint ran the production request path.
- **50/50** transfers admitted: 25 season 5, 25 season 6. All 50 saved `.torrent` files were bdecoded, their infohashes recomputed and matched against the engine ledger, and nonempty file lists verified.
- **47 Nyaa**, 3 Pirate Bay successful picks. **19 rejected metadata candidates** (18 Pirate Bay, 1 Torrents.csv) were skipped automatically before acceptance.
- Request S6E25: `[Tenrai-Sensei] My Hero Academia - S06E25 - No Man Is An Island [Web][1080p][HEVC 10bit x265] Boku no Hero Academia`, hash `b2bc60458e8abb3f1474cb5ca1bc340fd62abedf`; one metadata-confirmed file, 257,373,251 bytes.
- S6E25 alternatives returned **Nyaa, Pirate Bay and Torrents.csv**, with eight eligible alternatives.
- A second requester asked for **seasons 1,6**: all 25 existing S6 coordinates were reused without duplicate transfers, and S1E1 had usable metadata. The remaining 12 S1 singles did not yield usable releases; the request correctly remained **partial, 26/38**, retaining its hashes rather than becoming failed. This is an availability limitation, not a claim that all old season-one singles are downloadable.
- On the final rebased build, S6E25 was removed with `deleteFiles`, then the real owner retry endpoint was called for that partial request. Its attempt ledger contained **exactly S1E2–13 and S6E25**: no healthy S1E1/S6E1–24 coordinate was re-searched. S6E25 was reacquired with the same valid Tenrai metadata; the unavailable S1 singles left the request honestly partial.
- Final verification rechecked all **51** unique transfers' metadata hashes and nonempty file lists. Bulk removal with **`deleteFiles:true`** returned `Removed 51`; subsequent checks found **zero transfers and zero payload files**. The verification server and both requester proxies were stopped.
- Payload rate was capped, then the download window closed. These are metadata/admission checks, not claims that the copyrighted media was fully downloaded or playable.

### Season 2 investigation

The fresh S5–6 request contained only persisted season values 5 and 6. Its 50 transfers exposed only those coordinates; **no Season 2 transfer was created**. Season scope parsing does not substitute selection count/index for season number. The downloads work dialog intentionally groups all transfers for that work, not just the selected request, and legacy rows can fall back to release-name parsing. The original owner's database was not accessed, so the historical extra tab's precise cause remains unproven. A regression verifies that swap recovery prefers a saved S6E25 queue coordinate even when a legacy filename says S2E25.

## Regression coverage

The full `.NET 10` solution passes after rebasing onto main's storage fix: `dotnet test TorrentFlow.slnx -p:SkipWebBuild=true` (10,207 passed; nine pre-existing optional/live tests skipped). Coverage includes all three acquisition lanes, anime recovery during AniList outage, audio policy, constrained episode rules/deduplication, film fallback, 49/50 partial request plus missing-only retry, owner-only retry authorization, swap sources/coordinates, metadata timeout/wrong hash/cancellation, queued metadata without payload, the four-probe bound and cancellable search-budget waiting. Downloaded as well as peer-fetched metadata must match the pinned release hash.
