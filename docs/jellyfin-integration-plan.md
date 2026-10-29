# Jellyfin and Trakt integration plan

Status: plan, critic-reviewed (gpt-6.1-sol, 13 findings folded in), awaiting owner review. Feature: to file in Ops
Tracker (tracker was down on 29 Oct).

Owner's ask (29 Oct): "rn i have to add folder in library manually to jellyfin. is there a way to configure this to be
automatic? ... for every folder we have, it would just need to hit the jellyfin api and add the folder." Then, on the list
of eight Jellyfin APIs plus Trakt: "yes, lets do all that."

## What exists today

- `backend/src/Library/Jellyfin/JellyfinWatchState.cs`: read-only adapter. One paged `Items` read (Movie, Episode,
  Series with ProviderIds, Path, UserData) plus `Shows/NextUp`, 15 s in-memory cache, 1.5 s deadline. Matches by verified
  TMDB/TVDB/IMDb ids, then exact file path. Feeds `watchState` and `jellyfinNextUp` on title, library and cleanup reads.
- `backend/src/Api/JellyfinEndpoints.cs`: `/api/settings/jellyfin` GET/PUT/DELETE and `/test`. Settings are
  `JellyfinSettings(ServerUrl, Credential, UserId)` (`Domain/Records.cs:796`); the API key is a secret file.
- `web/src/components/settings/jellyfin-settings.tsx`: Server URL, API key, and a typed **User ID** (no picker).
  Copy promises "TorrentFlow only reads watch progress and never changes Jellyfin". This plan changes that promise, so
  the copy changes with it.
- Roots: `LibraryPlacement.Roots.cs` (`AddRootAsync`, `ConfigureRootAsync`, `RemoveRootAsync`, `ReorderRootsAsync`),
  routes in `Api/ImportEndpoints.cs:96-126`. Kind folders `Movies`, `TV`, `Anime Series`, `Anime Movies`
  (`LibraryPaths.cs:10,41-44`), configurable per root.
- Filing: `Targets/DownloadFiling.FileAsync` moves files to their final path and commits targets to Done. No hook after.
  `MediaFileRow.Tracks` is always empty: nothing checks a file's real audio after download.
- Follows: `Requests/Hunter.cs` every 15 min; scope is start episode, "new since" or latest season. Watch state is not
  used in any download decision.
- Cleanup: `GET /api/library/cleanup` needs Jellyfin and uses one user's played state.

## Decisions

1. **One Jellyfin client.** Grow `JellyfinWatchState` into a `JellyfinClient` (reads and writes, one auth header, one
   error mapping) plus small feature services. The 1.5 s deadline stays for reads on page loads; background work gets
   its own longer deadlines and never blocks a page.
2. **Admin access is required** for library sync, match fixes and subtitles. Sign-in checks
   `User.Policy.IsAdministrator`; read-only features keep working for non-admin users and the settings say which parts
   are off and why.
3. **Polling, not the webhook plugin, for watch progress.** A 60 s poll of recently played items is cheap, needs no
   plugin install, and survives Jellyfin restarts. The webhook plugin is a later option only if polling proves too slow.
4. **TorrentFlow only removes what it added.** Library paths it adds are recorded with Jellyfin `ServerId`, library
   `ItemId`, root id and the exact server-side path. It never removes a path the owner added by hand, never deletes a
   Jellyfin library, and never touches libraries outside its roots. A record that doesn't match the connected server or
   a refetched library is ignored, never acted on.
5. **One path mapper** for Jellyfin in Docker or on another machine: `{TorrentFlow prefix -> Jellyfin prefix}`, longest
   prefix on folder boundaries, keeping the destination's separators and case. Every Jellyfin path use goes through it:
   registration, rescans, watch matching (today `JellyfinWatchState.cs:165,209` compares raw upper-cased paths),
   item lookup and Sessions checks. Suggested from Jellyfin's existing folders, but only saved after the owner confirms
   and Jellyfin can see a test folder we create.
6. **Never delete before the replacement is in hand.** A file found wrong after download stays put (it can be played
   meanwhile) until a replacement is downloaded and checked. Owner-picked files are only flagged.
7. **Safety reads fail closed.** If Jellyfin is down, slow, or the account can't see every user, playback and watched
   checks count as "unknown", which blocks deletion; they never count as "safe".
8. **Background Jellyfin work is persisted.** Rescan, inspect, match-fix and subtitle jobs are rows written in the same
   transaction as filing, retried with backoff and resumed on startup. No in-memory-only queues.

## Phases

Each phase is shippable alone, in this order. Every phase: real API tests against a running server and a real
portable Jellyfin; UI checked with Playwright at 390, 768 and 1280 px.

### J1. Easier connection (sign in, user picker, path mapping)

- `POST /api/settings/jellyfin/signin {serverUrl, username, password}` calls `POST /Users/AuthenticateByName`
  (header `Authorization: MediaBrowser Client="TorrentFlow", Device="Server", DeviceId=..., Version=...`). Saves the
  returned `AccessToken` as the credential secret and `User.Id` as the main user. The password is never stored.
- `GET /api/settings/jellyfin/users` lists `GET /Users` (admin) for the watch-users picker (J6).
- API key entry stays under "Use an API key instead".
- New settings fields: `PublicUrl?` (address your devices use; defaults to ServerUrl; used for Play links),
  `PathMappings[]`, `WatchUserIds[]`, `SyncLibraries` (default on), `WatchAhead` (0 = off, default 2),
  `SubtitleLanguages[]` (default empty = off). `SettingsCatalog` default and validation updated; existing rows read
  with defaults.
- Status line: "Connected as Fidelis (admin)" or "Connected as X. Ask an admin account to turn on library sync."

### J2. Library folder sync (the original ask)

- `JellyfinLibrarySync` service runs on: connect/sign-in, root add/configure/remove/enable, drive back online, startup,
  and every 30 min. Runs are serialized (one at a time); a settings or connection change cancels the running pass and
  starts a fresh one against the new configuration.
- Reads `GET /Library/VirtualFolders` (Name, CollectionType, Locations, ItemId).
- For each enabled, online root and each kind it holds, map the kind folder through `PathMappings`, create the kind
  folder on disk if missing (Jellyfin rejects missing paths), then:
  - already in any library's Locations: ok.
  - else pick the library: Movies -> `movies`; TV -> `tvshows`; Anime Series -> a `tvshows` library whose name contains
    "anime", else the TV library; Anime Movies -> a `movies` library named like anime, else Movies. Owner can override
    per kind in settings.
  - no library of that type: `POST /Library/VirtualFolders?name=<Movies|Shows|Anime>&collectionType=<movies|tvshows>&refreshLibrary=false`
    with `{LibraryOptions:{PathInfos:[{Path}]}}`.
  - else `POST /Library/VirtualFolders/Paths?refreshLibrary=false` with `{Name, PathInfo:{Path}}`.
  - After all additions in a pass, one `POST /Library/Refresh` so files that already exist get indexed (a new library
    is otherwise empty until Jellyfin's own schedule).
- Removing a root: `DELETE /Library/VirtualFolders/Paths?name=&path=&refreshLibrary=true` only when the record matches
  the connected ServerId, a freshly read library ItemId, and the exact path. Anything ambiguous is left alone and shown
  as "Remove from Jellyfin?" for the owner. An offline or disabled root keeps its Jellyfin path (removing it would make
  Jellyfin drop watch history).
- Record: new table `JellyfinLibraryPaths(ServerId, LibraryItemId, LibraryName, RootId, ServerPath, AddedAt)`.
- `GET /api/library/roots` gains per root `jellyfin: {state: "indexed"|"registered"|"pending"|"failed"|"off", library?,
  message?}`. "Registered" means the path is in Jellyfin; "indexed" means a scan has completed since.
  Storage settings row shows "In Jellyfin: Movies, Shows" or the failure with **Add to Jellyfin** (retry).

### J3. Fast pickup of new files

- `DownloadFiling.FileAsync` writes a `JellyfinJobs` row (kind `rescan`, filed folder paths, target id) in the same
  transaction that commits filing. A `JellyfinJobWorker` batches due rescans every 10 s into
  `POST /Library/Media/Updated` `{Updates:[{Path, UpdateType:"Created"}]}` with mapped paths. Library delete writes a
  `Deleted` job.
- Failures back off (30 s up to 30 min), survive restarts, and never affect filing. Jobs older than 7 days are
  dropped; the 30 min J2 pass plus a full `Library/Refresh` repairs anything missed.

### J4. Play in Jellyfin, and skip what Jellyfin already has

- The snapshot keeps each item's Jellyfin `Id` and `LocationType` (virtual missing episodes are ignored).
- Title response adds `jellyfin: {itemId, playUrl}` for the film or series, and `jellyfinItemId` per owned episode.
  `playUrl = {PublicUrl}/web/#/details?id={itemId}&serverId={ServerId}`.
- Title hero: **Play in Jellyfin** as the primary action when the item exists; Download moves to secondary. The
  "Up next S2E5" chip links to that episode in Jellyfin.
- Already in Jellyfin but not downloaded by TorrentFlow: Hunter, season downloads and watch-ahead count the episode or
  film as owned. A direct Download click still works ("Download anyway" in the hero menu); never silently refused.

### J5. Watch-driven downloading (stay N episodes ahead)

- The goal is a **window**, not an event: for each series a watch user is in, keep the next `WatchAhead` aired episodes
  after their furthest watched episode available.
- `JellyfinWatchPoller` (60 s) per watch user: `GET /Items?UserId=&Recursive=true&IncludeItemTypes=Episode&SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Fields=ProviderIds,Path`,
  paged until it reaches the saved checkpoint. Checkpoint is persisted per (ServerId, UserId) as
  (`LastPlayedDate`, item id) so ties and downtime don't skip plays. Episodes over 50% resumed also count.
- First connect sets the baseline: past plays only set each series' cursor; nothing is queued for series not played in
  the last 30 days.
- Cursor per series (`WatchCursors(ServerId, UserId, WorkId, Season, Episode, UpdatedAt)`). Every Hunter pass (15 min)
  also re-checks each active cursor, so an episode that airs after you caught up is picked up without a new play.
- Queues missing episodes that are not owned, in Jellyfin, already queued, removed or paused by the owner, through
  `AcceptAutomationAsync` with a new `IntentOrigin.WatchAhead`. This is not "unchanged": it needs
  - a migration for the origin CHECK constraint (`TorrentFlowDbContext.cs:135`),
  - the automatic-origin checks in `TargetPipelineAccept.cs:19-24,96-100,130-134,211-212` and
    `TargetPipelineRun.cs:159-161` extended so it uses the background lane, metadata rules and duplicate suppression
    shared with Hunter.
- Works for any series you watch, followed or not. Activity log: "Watched S2E3, getting S2E4 and S2E5."
- Setting: "Stay ahead of what you watch: Off, 1, 2, 3, 5 episodes".

### J6. Safer cleanup

- Needs an admin connection: Jellyfin filters `/Sessions` to the caller's own sessions otherwise, so an empty list
  proves nothing. Without admin, the cleanup page says "Sign in with an admin account so TorrentFlow can see what
  everyone is watching" and delete still works only with an explicit confirmation.
- `GET /Sessions?activeWithinSeconds=600`: anything with a `NowPlayingItem` under our roots (through the path mapper)
  is excluded from suggestions. The same check runs again at the shared delete path (`TargetDownloadDeletion`), which
  J7 also uses, and refuses with "This is playing in Jellyfin right now. Stop it and try again." A failed or timed out
  read refuses too (decision 7).
- Watched is per episode: an episode is suggested only if every chosen watch user (default: all enabled users) has
  played that episode. A series is suggested when it has at least one such episode, matching the owner's rule that a
  single watched episode counts; the selection lists only those episodes.

### J7. Check downloaded files

- An `inspect` job follows each rescan job. It finds the item by exact mapped path with
  `GET /Items?UserId=<user>&Recursive=true&Path...` or `Ids=` and `Fields=MediaSources,MediaStreams,ProviderIds,Path`
  (UserId is always passed: an API key has no user of its own, so `/Items/{id}` without it returns 404). Retries for up
  to 30 min.
- Inspection state per file: `pending`, `unknown`, `verified`, `rejected`. Only `rejected` acts, and only when the
  media source path equals our file, the probe has at least one stream, and every audio stream has a language.
  Language codes are normalized (`en`/`eng`/`English` alike); empty, `und` or missing tags make the result `unknown`.
  Missing streams or a timeout are `unknown`, never "can't be played".
- Store audio and subtitle languages into `MediaFileRow.Tracks`.
- `rejected` (no audio in an allowed language):
  - Automatic pick: a new persisted **replace** operation (not `FindAnotherCoreAsync`, which rejects Done targets, and
    not library delete, which marks targets Removed and clears watch state). It blocks that release for the title,
    downloads a replacement for the same episode or film while the old file stays, checks the replacement the same way,
    then swaps files and removes the old one through the shared delete path (with J6's playback check). If no
    replacement is found, the old file stays and the title shows "Only Spanish audio found. [Find another source]".
    Each step is recorded so a crash resumes or rolls back cleanly.
  - Owner-picked: title page shows the flag with **Find another source**.
  - Activity: "Charade had Spanish audio only. Getting another source."

### J8. Fix wrong matches (runs before subtitles, which rely on the match)

- After J7 finds the item, compare its ProviderIds with our verified link (the series item for episodes).
- Only a **contradiction** acts: Jellyfin has a TMDB/TVDB/IMDb id that differs from our verified one. Missing ids
  alone do nothing (Apply is a full metadata replace, so it is not used for enrichment).
- Fix: `POST /Items/RemoteSearch/Apply/{itemId}?replaceAllImages=false` with `{Name, ProductionYear, ProviderIds}`
  where ProviderIds is Jellyfin's existing dictionary with only the contradicting keys replaced by our verified ids,
  and `SearchProviderName` set from the id we hold (TheMovieDb, TheTVDB or Imdb). Skipped when the item's metadata
  is locked or the item is outside our roots.
- Any rematch resets the item's inspection to `pending` so J7 and J9 see the corrected item.
  Activity: "Fixed Jellyfin match for Atlantis (2013)."

### J9. Subtitles

- Off unless `SubtitleLanguages` is set. After J8 has verified or fixed the match, for each new item without a
  subtitle stream in a wanted language: `GET /Items/{id}/RemoteSearch/Subtitles/{lang}`, pick the best result (release
  name match, then downloads, not hearing-impaired unless nothing else), `POST /Items/{id}/RemoteSearch/Subtitles/{subtitleId}`.
- No results because no subtitle provider is installed: settings show "Install the OpenSubtitles plugin in Jellyfin
  to get subtitles."

### T1. Trakt watchlist

- Owner creates a Trakt app (trakt.tv/oauth/applications) once and pastes client id and secret; then device sign-in:
  `POST /oauth/device/code`, show the code and link, poll `/oauth/device/token`. Tokens are secret files; refresh before
  expiry; a refresh failure shows "Sign in to Trakt again".
- Every 30 min (skipped when `/sync/last_activities` shows no watchlist change): `GET /sync/watchlist/movies` and
  `/shows`, following pagination headers. Movie -> follow (Get it when it's out). Show -> follow latest season.
  Resolved through TMDB ids.
- Provenance is a flag set, not one origin: a follow records `FromTrakt` and `FromOwner` separately. Any owner action
  on the follow sets `FromOwner`.
- Removal only after a complete, successful fetch of every page. Leaving the watchlist clears `FromTrakt`; the follow
  is removed only when `FromOwner` is unset and nothing was downloaded for it, and its queued (not started) targets
  are cancelled. Started or finished downloads are never touched.

## UI (owner reviews designs before build)

Settings > Jellyfin, connected:

```
Jellyfin                                   Connected as Fidelis (admin)   [Disconnect]
  Address for your devices  [http://192.168.1.20:8096        ]
  Folders            D:\Torrents\Media -> /media   (Change)
  Libraries          Keep my storage folders in Jellyfin            [on]
  Watching           Stay ahead of what you watch     [2 episodes v]
  Counts as watched  [x] Fidelis  [x] Guest
  Subtitles          [English x] [+ language]
```

Not connected: Server address, Username, Password, **Sign in**; link "Use an API key instead".

Storage row adds one quiet line: "In Jellyfin: Movies, Shows" or "Not in Jellyfin. [Add to Jellyfin]".
Title hero: **Play in Jellyfin** primary; Download in the menu as "Download anyway".
Settings > Trakt: Not connected -> **Connect Trakt** dialog with code; connected -> "Watchlist synced 5 min ago, 12 titles".

## Testing

- Portable Jellyfin (latest stable) under `%TEMP%\agent-scratch\jellyfin`, loopback port 8097, its own data dir, admin
  user created through the startup wizard API. Deleted after QA.
- Per phase: real HTTP against TorrentFlow and Jellyfin; licensed Blender films and synthetic episode files.
  - J2: add root -> path appears in `VirtualFolders`; files already there get indexed; remove -> gone; hand-added path
    untouched; offline root kept; reconnect to a second Jellyfin -> old records ignored.
  - J3: filed film visible in Jellyfin within 30 s without a full scan; Jellyfin stopped during filing -> picked up
    after it restarts, and after a TorrentFlow restart.
  - J5: mark S1E1 played through the Jellyfin API -> S1E2/S1E3 queued within 70 s; first connect with old history
    queues nothing; caught up, then a new episode airs -> queued on the next pass.
  - J6: start a playback session through the API -> item excluded and delete refused; Jellyfin stopped -> delete
    refused; non-admin connection -> warning shown.
  - J7: a file with only non-English audio keeps playing until its replacement is checked, then is swapped; `eng` and
    `en` both pass; untagged audio is left alone; an owner-picked one is flagged; API key and signed-in token both work.
  - J8: a deliberately wrong TMDB match is fixed and keeps its other ids; a missing id is left alone.
- Trakt needs the owner's account: tested live with him.
- The owner's real Jellyfin is tested last, once he gives the address and how it runs.

## Open for the owner

1. Where Jellyfin runs (this PC, Docker, another machine) and its address.
2. Default watch-ahead count (plan: 2).
3. Trakt: fine to create a Trakt app on your account?
