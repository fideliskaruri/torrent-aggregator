# Owner bugs 30 Sep: plan

Status: critiqued (GPT-5.6 Luna, 14 findings, all folded in), waiting for owner approval. No code has changed.
Debug reports (evidence, file:line): session files `debug30/season.md`, `queue.md`, `browse.md`, `removals.md`.

## 1. Root causes (confirmed unless marked)

| Bug | Root cause |
|---|---|
| A Frieren stopped at 28 of 38 | Not a stall. Season was started from the AniList page, which lists S1 as 28 episodes (AniList keeps S2 as its own entry). Download season sends the episodes on screen (`episode-list.tsx:362`), so E29-38 were never wanted. When they are wanted, searches use "S01E29" (0 hits) because the AniList season mapping is only loaded for AniList-opened pages (`GrabService.cs:116`), so "Season 2 - 01" names are never tried. |
| B No counts summary | After the 202 nothing summarises the season. `SeasonFailureSummary` (`GrabFailure.cs:117`) already writes "Started X of Y" but only the old streaming path uses it. |
| C Cards don't show queued | Title payload (`TitleService.cs:22`) has status and progress only; queue position and wait reason live in `/api/client/torrents`. "Queued" also means two things today: waiting for a slot, and not found yet. |
| D Cap not instant | The cap itself applies in ~0.1 s. Resume marks a download "forced" like Download now (`TorrentEngineService.cs:981,1009`), and forced downloads ignore the cap (`DownloadQueue.cs:141`) until they finish. Pausing extras also waits on the 10 s stop from K. |
| E Amber pills | Fixed on main (neutral `bg-background/86`). Owner's machine runs an older build. Re-verify on the new build only. |
| F No show-level progress | Only a per-season meter exists. The data to sum seasons is already in the detail payload. |
| G Rails repeat titles | Personal and discovery rails are concatenated with no shared "already shown" set (`BrowseService.cs:96`, `:533-555`). Not reproduced on this instance's current data, cause is structural. |
| H Episodes jump button | Pure removal. |
| I Season header clutter | Watched line plus two different download counts. Removed with J; one download line remains. |
| J Streaming | Whole `TorrentFlow.Media` project, engine stream hooks, watched/progress, player UI, `hls.js`. Nothing outside Media uses its types. |
| J2 ffmpeg | Only non-streaming use is `CompletedMediaValidator`. On the owner's build ffprobe is missing, so nothing is validated today. |
| K Slow delete | Stopping an active torrent waits for a hard 10 s timeout (`MonoTorrentBackend.cs:387`), one torrent after another, inside the request. Files and DB take under 0.4 s. |
| L Triple "done" | Ready badge + Verified badge + 100% bar on finished rows. |
| M Synopsis not clamped | `hidden line-clamp-2 sm:block` in `title-result-card.tsx:121`; `sm:block` overrides the clamp. Only instance in the app. |
| N Blank anime episodes | AniList extras branch emits numbered placeholders with no data (`TitleExtrasService.cs:106-135`); TVmaze (keyless) is explicitly skipped for anime (`:176`); no fall-through to TMDB. |
| O, P, Q, T Downloads page | O no sort; P add panel always open; Q status block wraps and stacks beside the badge; T cap only in Settings (plain inline input in `settings/page.tsx:778-808`). |
| R Select-all per season | Per-card selection exists (`toggleGroupSelect`); no season header checkbox. |
| S Request greyed out from home rows | TMDB id is known when the chart is built but never stored on `CatalogEntry`; `ToRailItem` drops it (and `WorkKey`); `titleHrefForItem` sends no id; title GET never fills one in; `RequestAction` disables without it. |

## 2. Fixes

### Season pipeline (A, B, C)
- **A1 Season list from the server.** `POST /api/title/{key}` scope `season` ignores the on-screen list. One season-shape resolver builds it from provider identities: AniList entries and their sequel chain (`AniListEpisodeMapping`) matched to the TMDB/TVmaze show by provider id, deduped by absolute episode number, specials excluded. Each episode carries both numberings. No "longest list wins".
- **A2 Search names for all anime.** Load the AniList mapping for any anime work, not only AniList-opened pages, so E29 also searches "Season 2 - 01" / "2nd Season - 01" / absolute "- 29". Uses the existing ladder, no new search path.
- **B1 One summary.** Each season download gets a persisted run id. After its first pass, exactly one notification per run using `SeasonFailureSummary`: "Frieren S1: 36 started, 2 not found yet". Later finds update that same notification rather than adding new ones. Counts only.
- **C1 One transfer shape.** One shared server projection for transfer state, with a role-aware redaction step: owners get queue position and wait reason; requesters get only the plain status. Cards show "Queued #3" (slot) and "Looking" (not found yet) as two states.

### Queue and delete (D, K, T)
- **D1** Only Download now sets forced; store why a row is forced (`now` vs legacy). Resume puts the download back in line. Existing forced rows cannot be told apart, so they keep their override until they finish; nothing new gets it from Resume.
- **K1** One shared engine "detach" primitive (stop without waiting on the tracker). Delete, pause and cap-lowering are separate operations on top of it: pause and cap-lowering keep the row and files; delete writes a persisted tombstone, returns at once, and a restart-safe cleanup worker detaches, deletes files, then removes the tombstone (idempotent, retried after restart). The UI removes the row at once. Library delete goes through the same batch delete.
- **T1** `GET /api/settings/client` reports the cap in force and its source (download hours may override it).
- **T2** One `MaxActiveDownloadsControl` stepper used by both Settings and the Downloads status line; saves through the existing `PUT /api/settings/client`; read-only with "(download hours)" while a schedule overrides it. Settings only sends the cap when changed there, so the two never overwrite each other.

### Browse and metadata (F, G, M, N, S)
- **F1** `showProgressFromSeasons` next to the season helpers; the title hero reuses `SeasonProgressMeter` for "12 of 38 downloaded".
- **G1** One `seen` set in `BrowseService.BuildAsync`: personal > because > trending > popular; first rail wins. Key is provider id when known, else normalised title + year + type, with work key as a second guard.
- **M1** `hidden sm:line-clamp-2`.
- **N1** AniList episodes are filled from one shared enrich step that uses the A1 resolver's matched show (provider id, year and type must agree; no loose title match). TVmaze (keyless) or TMDB when a key exists, mapped through the absolute offset. When no confident match exists, cards show the episode number and the show's banner, never another show's data.
- **N2 (later, own plan)** One page per franchise whichever provider opened it. Needs owner input on how S1/S2 AniList entries appear.
- **S1** Store provider + id on `CatalogEntry` at chart write (migration), emit `workKey`, `provider`, `providerId` on rail items, and pass them through `titleHrefForItem` into the existing `titlePath`. Existing rows have no id: the migration empties the chart cache so the next refresh rebuilds it with ids. Verify on Backrooms and Obsession.
- **S2** Title GET fills provider id from `Work.ProviderId` or the catalog row when the URL has none, and returns it in the payload; `requestTitleFor` reads the payload. If still unknown, the page says it couldn't match the title to a catalog entry instead of a grey button.

### Removals and tidy (H, I, J, J2, L, O, P, Q, R)
- **J** Delete `TorrentFlow.Media`, engine stream hooks, watched/progress, the player and `hls.js`; migration `RemoveStreaming` drops `PlaybackProgress` and `SwarmMeasurement`. Migrations run on start, so: back up the DB file before migrating, log row counts, and test against a copy of a real current DB and an old Prisma-adopted DB. Finished files get **Open** (owner's default player) and **Show in folder** via a new owner-only `POST /api/downloads/{id}/open` (local only, refused on the tunnel, in containers and for requesters; only a completed file from that transfer's own manifest; video extensions only; canonical path inside the download roots; no symlinks or junctions on any path segment, checked right before launch).
- **J2** Delete ffmpeg installer, locator and the Settings card. New built-in validator: dangerous files (exe, lnk, scr, double extensions) fail; archives with no video fail; container magic bytes checked for MKV/WebM, MP4/MOV, AVI, TS/M2TS; zero-filled files fail. A file that can't be read is retried; if it still can't, the row shows "Couldn't check this download" and is neither accepted as good nor deleted. Every file in the release is checked for dangerous types; magic bytes are checked on the selected videos (pack fallback).
- **H, I** Remove the Episodes button and Watched line; the season header shows one line: "12 of 38 downloaded · 3 downloading". Downloads series rows use the same wording.
- **L** Finished rows show Ready only; bar only while downloading; "Files missing" badge only when files are gone.
- **P, Q** Add panel collapses to one "Add torrent" row (state remembered). Header becomes one line: dot + Connected · counts · speed · the T2 stepper. Folders move to Settings.
- **O** Sort select (Recent, Name, Quality, Size, Progress), remembered locally.
- **R** Tri-state checkbox in each season tab header, wired to the existing `toggleGroupSelect`.

## 3. Order and owners

Pack fallback (`feat/pack-plan`, flag off) touches the same engine and validator code. If the owner approves, land it first so J/J2 build on top; if not, J/J2 go first and pack-plan is rebased later.

| Lane | Tasks (one agent each, ~30 min) | Model |
|---|---|---|
| Server removals | J-S2 Media project → J-S3 engine hooks → J-S4 send/retention → J-S5 watched → J-S6 migration; J2-S7 ffmpeg → J2-S8 validator; J-S9 open endpoint | Opus 5.5 medium (S2, S3, S6, S8), Grok 4.5 (S4, S5, S7, S9) |
| Web removals | W1 player → W2 title page (+H) → W5 header (I, F1); W3 Downloads Open → W6 (L) → W7 (P, Q) → W8 (O), W10 (T2), W9 (R); W4 Settings | Opus 5.5 medium with the frontend-design rules |
| Queue | D1, K1, T1 | Opus 5.5 medium (K1), Grok 4.5 (D1, T1) |
| Season | A1+N1 shared list/enrich, A2, B1, C1 | Opus 5.5 medium (A1+N1), Grok 4.5 (A2, B1), Opus 5.5 medium (C1, touches cards) |
| Browse | G1, M1, S1, S2 | Grok 4.5 (G1, M1), Opus 5.5 medium (S1+S2) |
| QA | One QA agent, headless Playwright at 390 and 1280, owner and requester views, after each lane lands | GPT-5.6 Luna for review, Opus 5.5 medium for Playwright |

Worktrees: `no-stream` (server + web removals, H, I, L, O, P, Q, R), `queue-cap` (D, K, T), `season-finish` (A, B, C, N1), `browse-tidy` (F, G, M, S). Web conflicts: C1, F1, W2 and W5 all touch `episode-list.tsx`/title page; the no-stream web agent owns that file, and C1/F1 rebase onto it after W5 lands. T2 goes after W7 and D1. Each lane merges to main in turn; the next rebases before QA.

## 4. Proof per bug
- API against a real running build with a copy of real data (never the owner's 3930 instance, never `D:\Torrents`): A (Frieren season asks for 38 and searches "Season 2 - 01"), B (one notification with counts), D (resume then lower cap: running count drops at once), K (delete of an active torrent returns under 300 ms), S (rail JSON carries provider id), G (no key repeats across rails).
- Headless Playwright screenshots at 390, 768 and 1280 for C, F, H, I, L, M, N, O, P, Q, R, T, and a Frieren anime page with stills and no TMDB key.
- `rg -i "stream|playback|hls|subtitle|prewarm|ffmpeg|ffprobe|watched"` leaves only legitimate hits.
- Also: restart during a background delete (files still end up gone), migration on an old DB, requester view of cards (no queue internals), open endpoint refused on tunnel/requester/symlink/traversal, cap change while deletes run.
- No unit tests. Broken ones tied to removed code are deleted.

## 5. Owner decisions needed
1. Land the pack fallback (flag off) before the removals? Recommended yes.
2. J2 validator: fail a release that contains an .exe or similar next to the video (stricter than today)? Recommended yes.
3. J2 validator: fail a release whose only video is under 1 MiB? Recommended yes.
4. N2 franchise page: later, separate plan.
5. FEAT-1 multiple disks: still waiting on the placement model.
