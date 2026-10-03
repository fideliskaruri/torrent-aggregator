# Plan: backend rebuild, phase by phase

Owner decisions (2026-10-03):
- Rebuild the whole backend. The web app and its API contract stay.
- Downloads go into one folder.
- The swarm check is essential.
- Unknown language is not checked for now. Only clearly foreign releases are refused.
- Separation of concerns.
- Fast agents (GPT-6.1 Sol, low or medium effort), with the coordinator reviewing every phase.

On approval, this plan is also saved to the repo as `docs/rebuild-plan.md`. Design background is in
`docs/architecture-rethink.md`.

## Starting point (main 90ef590)
- About 42k lines of C# in 7 projects: Engine 10.6k, Metadata 8.4k, Library 7.1k, Api 6.4k, Core 4.3k, Search 3.7k,
  Data 2.2k.
- 23 tables.
- 7 JSON side files: sources, tmdb-settings, remote-access, desktop, push-vapid, layout-manifest and anime-list-full.
- 16 background services.
- The web app calls about 52 route families under `/api`.

## Ground rules for every phase
- **Where the work happens.** A new `backend/` folder in a new `rebuild` worktree branched from main. The old `server/`
  keeps running live on 3930 until the switchover, and the two servers never share a database.
- **Projects enforce the module boundaries.** One project per module. A wrong dependency fails the build.
- **No unit tests.** Evidence comes from three places:
  - the `bench` tool, which talks to a running server over HTTP;
  - the contract check, which compares real responses with the captured contract;
  - headless walks through the web app at 390 and 1280 px.
- **Real data.** Every run uses a fresh copy of the 3930 database, settings and folder layout.
  - Full downloads use freely licensed titles: Sintel, Big Buck Bunny and Tears of Steel.
  - Real titles are taken only as far as the first bytes and connected seeds, then removed.
- **Agents.**
  - One task per agent, about 30 minutes each.
  - GPT-6.1 Sol at low effort for mechanical tasks, medium for the parser, Plan, the swarm check, the engine and the
    migration.
  - Each task gets an Ops Tracker issue, and every commit carries a `Refs: OPS-n` trailer.
  - Independent modules may run in parallel. Two agents never work on the same module at once.
- **Phase review (coordinator).**
  - Check conformance to the design and the module contracts.
  - Read the risky code line by line.
  - Tick off the behaviour inventory.
  - Run the benchmark and show the owner the numbers.
  - A failed review sends the phase back. Nothing is patched forward into the next phase.

## Module dependencies (compile-time)
```text
Domain   <- every module (types and interfaces only)
Parser   -> Domain                (pure)
Plan     -> Domain                (pure)
Metadata -> Domain
Sources  -> Domain
Engine   -> Domain                (MonoTorrent)
Check    -> Domain, Engine
Find     -> Domain, Parser, Sources, Metadata
Library  -> Domain
Store    -> Domain                (EF Core, the one database)
Targets  -> Domain, Find, Check, Plan, Engine, Library, Metadata, Store
Api      -> Domain, Targets, Metadata, Store
Bench    -> HTTP only
```

## Phase 0: Baseline and inventory
Goal: know exactly what "better" means before writing any new code.

| Task | Work | Owner |
|---|---|---|
| 0.1 Bench tool | `tools/bench`, HTTP only. For each title it records: time to first result, pool size, time until every target is downloading or honestly waiting, the chosen release, listed and connected seeds after 2 min, unsafe or foreign picks, and duplicate engine rows. Output is CSV plus a Markdown summary. | Sol medium |
| 0.2 Title list | Hard set: Scorpion (2014), Little Fires Everywhere, Frieren S1, A Silent Voice, an older finished network show and a non-English show (the owner names the last two). Control: Rick and Morty S1. Pipeline check: Sintel, Big Buck Bunny. | coordinator |
| 0.3 Source audit | For each of the ~14 sources, run against the hard set: results, results that match the right work, releases no other source has, how many of those are healthy, latency, errors and 429s. | Sol low |
| 0.4 Contract capture | Call every web route on a copy of 3930 and save path, method, status and JSON shape to `backend/contract/`. The web app's TypeScript types are the spec. | Sol low |
| 0.5 Behaviour inventory | For each module, list what works in the old code, from main and from the Next.js build at 5824ed5~1. One line per behaviour, with its source file. This becomes the port checklist. | Sol medium + review |
| 0.6 Next.js baseline | Build and benchmark 5824ed5~1 in the same hour as main, time-boxed to 30 min. If it doesn't build, say so plainly. | coordinator |
| 0.7 Name corpus | Real release names from the 3930 SearchCache plus the old matching regression cases, each with its expected parse, in `backend/corpus/names.tsv`. | Sol low + coordinator labels the hard rows |

**Gate:** the baseline numbers, the source audit and the behaviour inventory go to the owner, who decides which sources
to drop.

## Phase 1: Design
- **1.1 Data model.** One fact lives in one place. Tables:
  - Work: names, ids, kind, format, original language
  - Season and Episode
  - Target: one per film or episode, holding its state, reason, next try and chosen release
  - Release, plus Verdict (the swarm check result)
  - Attempt (history) and Block (the one exclusion list)
  - Download (the engine row)
  - Request, User, Notification, PushSubscription, WatchItem, AutoRule
  - Setting: typed sections that replace the JSON side files; secrets stay in files
  - SearchCache
- **1.2 State machine.** Every target state and every transition, with its trigger:
  - the main path is wanted, finding, checking, planning, fetching, filing, done;
  - the side states are waiting (with a reason and a next try), paused and removed;
  - swap, stall, the download cap, restart and removal are each written out as transitions.
- **1.3 Interfaces.** C# interfaces and records for every module contract. Inputs and outputs only, no implementations.
- **1.4 Concurrency.**
  - Each source has its own queue and rate limit.
  - Two priority lanes: owner actions run before background work.
  - A background search budget.
  - About 10 swarm checks at once.
  - Engine connection limits.
  - One pipeline worker with a bounded number of targets in flight.
- **1.5 Library layout.**
  - Folders: Movies, TV, Anime, Anime Movies.
  - Names per kind.
  - Unfinished files carry a partial suffix and are renamed in place when done.
  - Unwanted files sit in a hidden `.unwanted` folder with a `.ignore` file.
  - Swap and remove delete the right files.
  - Seeding stops on completion.
  - Jellyfin sees no change from today's layout.
- **1.6 Migration mapping.**
  - Each old table maps to its new table, field by field.
  - Anything dropped is listed, with the reason.
  - `.staging` payloads move into place with a hash check.
  - Orphan targets go back to wanted.
  - There's a rollback path.
- **1.7 Critique.** A system-level review against the rules and the behaviour inventory, by a rubber duck on GPT-6.1 Sol
  medium.

**Gate:** the owner says go on the design.

## Phase 2: Foundations, metadata and the read-only API
Goal: the web app runs on the new server for everything that doesn't download.

- **2.1 Skeleton (Sol low):** the projects with their dependency rules, Store (EF Core + SQLite), typed settings,
  logging, and a host that serves the web app.
- **2.2 Users and access (Sol low):** roles, remote access, `/api/me` and features.
- **2.3 Metadata (Sol medium):**
  - TMDB, AniList and Cinemeta, with caching;
  - the Fribb id map, refreshed weekly;
  - one labelled names list per work, plus its ids;
  - kind and format come from the provider, never from release names.
- **2.4 Catalog API (Sol low):** browse, recommendations, title search, title page, artwork and watchlist.

**Gate:**
- The contract check passes for every read route.
- A headless walk of home, browse, search and title pages looks the same as on 3930.
- Startup time and memory are recorded.

## Phase 3: Find and check (nothing is downloaded yet)
- **3.1 Parser (Sol medium):**
  - Normalize the name first: separators, Unicode dashes, brackets, group tags and hashes.
  - Then read seasons, episodes, absolute numbers, ranges, batches, quality, source, group, year and language markers.
  - `bench parse` must pass the whole corpus.
- **3.2 Sources (Sol low, 2 to 3 adapters per agent):**
  - Only the sources the owner kept after 0.3.
  - Each source owns its queue, its rate limit and a 6 s deadline.
  - A source that's cooling down is skipped, and there are no retries inside a search.
- **3.3 Engine core (Sol medium):** MonoTorrent with a stored listen port and a fallback, DHT and UPnP, metadata-only adds
  for probing, and connection limits.
- **3.4 Find (Sol medium):**
  - Queries come from the names list: English first, then romaji for anime. Queries are broad, and the parser filters
    the results.
  - Releases are deduped by hash, keeping the trusted seed count: the scraped count, or else the lowest listed count.
  - Stop early once a healthy release is found.
  - Cache results for 30 min and share identical searches already running.
  - Owner actions take priority, and background searches share one budget.
- **3.5 Swarm check (Sol medium):**
  - Probe inside the main engine for about 20 s: file list, connected peers, bytes delivered.
  - Verdict: good, weak, dead or unknown.
  - Metadata is cached by hash for good, and verdicts for about 6 h.
  - The tracker scrape is only a pre-filter.
  - Probes start while search results are still arriving.
- **3.6 Dry-run endpoint (Sol low):** `/api/dev/plan` returns the pool, the verdicts and the reason for every rejection,
  without adding anything. The bench uses it.

**Gate:**
- A checked pool arrives faster than the baseline.
- Every hard-set title finds its right releases.
- No lookalikes survive, such as Scorpion King for Scorpion.
- Verdicts agree with the connected seeds we measure.

## Phase 4: Plan, targets and downloading
- **4.1 Plan (Sol medium):**
  1. Gates against metadata: names, episode map, year, size for the runtime and quality, file safety, clearly foreign
     language, and blocks.
  2. Health bands: good, weak or dead. Dead is never picked.
  3. Quality fit: preferred, then nearest above, then nearest below. Then source and recency.
  4. Finished seasons weigh packs against singles. A pack downloads only the missing episodes' files.
  5. The reason for every rejection is kept.
- **4.2 Targets and worker (Sol medium):** the state machine from 1.2 behind Download, Download season, Try now and
  Remove. Each click is accepted instantly, and never errors at click time.
- **4.3 Engine downloads (Sol medium):**
  - selected files only;
  - the concurrent cap applies instantly in both directions, and Download now overrides it;
  - a stall means no metadata after 3 min, or almost no progress in 10 min;
  - seeding stops on completion.
- **4.4 Swap and stall (Sol medium):**
  - Find another release runs the same finder, minus the current and blocked releases.
  - Recovery from a stall happens in two steps: the new release starts first, then the old one is removed and blocked.
  - The only candidate is never discarded.
- **4.5 Downloads API (Sol low):** downloads, wanted, actions, and the cap and recovery settings.

**Gate:**
- Sintel and Big Buck Bunny download completely.
- Hard-set titles either reach connected seeds or wait with an honest reason.
- No duplicate engine rows.
- The cap works both ways.
- A forced stall swaps the release.

## Phase 5: Library
- **5.1 Placement (Sol medium):**
  - The final folder and names are decided when the file list arrives.
  - Files are written straight to that folder with the partial suffix, then renamed in place when done.
  - Unwanted files go into `.unwanted`.
- **5.2 Removal (Sol low):** remove, swap, library delete and on-demand leave no leftovers.

**Gate:**
- Free titles land in the right folders with Jellyfin names.
- A Jellyfin scan in the middle of a download shows nothing partial.
- Removal leaves nothing behind.

## Phase 6: Everything else (Sol low, one agent each)
- **6.1** Requests: requester, approve, decline, retry and pick, all through the same targets.
- **6.2** In-app notifications and activity.
- **6.3** AutoRules and the scheduled hunter, on the background budget.
- **6.4** Desktop shell, updates, open folder and browse folders.

**Gate:** the contract check passes for every web route, and a full headless walk of every page at 390 and 1280 px
looks right.

## Phase 7: Switchover
- **7.1 Converter (Sol medium):**
  - Back up first.
  - The conversion is idempotent.
  - `.staging` payloads are hash-checked and moved into place.
  - Orphan targets go back to wanted.
- **7.2 Rehearsal (coordinator):** run the converter on a copy of 3930, then check that:
  - everything is present;
  - nothing already on disk downloads again.
- **7.3 Live (coordinator, with the owner present):** stop 3930, back up, convert, and start the new server. The old
  server and database stay untouched for rollback.
- **7.4 Clean up (owner go, after a week of real use):** delete `server/` and the leftovers.

**Gate:** the owner downloads a real series on the new server, and it lands in Jellyfin.

## Local data, import and storage (owner, 2026-10-03)

### What today does
- One base download path, plus a subfolder rule per kind (`PathRules`).
- Import only adopts torrents from other clients (qBittorrent and Transmission resume data).
- The server knows only the files it downloaded itself, through engine rows. Media copied in by hand is invisible to it.

### What we store (principle: store only what can't be recomputed)
| Group | Tables | Notes |
|---|---|---|
| Catalog (a cache, refetchable) | Work, Season, Episode | Names, ids, kind, air dates. Safe to rebuild from the providers. |
| Wants (owner intent) | Target, Request, WatchItem, AutoRule | Owner intent, which can't be recomputed. Backed up. |
| Release knowledge | Release, Verdict, Attempt, Block, SearchCache | Verdicts and caches expire. Attempts and blocks are history. |
| Engine | Download | Hash, selected files, state. Progress is read live, never stored. |
| Library (new) | StorageRoot, MediaFile | What is on disk, wherever it came from. |
| People and system | User, Notification, PushSubscription, Setting | Settings become typed rows. Secrets stay in files. |

- **MediaFile** records path, root, size, quality, the episode or film it belongs to, its origin (downloaded, imported or
  adopted) and when it was last seen.
- **"Have it"** is decided from MediaFile in one place. Everything else reads it: title pages, the hunter, the planner's
  missing-episodes set, and requests.
- **The disk is the truth for files.** A scan reconciles MediaFile with the disk. Files missing from an offline drive
  are marked "offline", never deleted and never downloaded again.

### Fields per table (draft for 1.1)
| Table | Fields | Kept how long |
|---|---|---|
| Work | id, kind (film, series), anime flag, format, names (labelled list), ids (tmdb, anilist, mal, imdb, tvdb), year, original language, runtime, poster and backdrop paths, refreshed at | cache; refetched weekly |
| Season, Episode | work, season, episode, absolute number, title, air date, runtime | cache; refreshed with the work |
| StorageRoot | path, kinds accepted, priority, free-space reserve, online, last checked | until removed |
| MediaFile | path, root (or "outside a root" for files tracked in place), work, season and episode (or film), size, resolution, source, audio and subtitle languages if known, origin (downloaded, imported, adopted), download id, added at, last seen, status (present, offline, missing) | while the file exists; a missing file is kept 30 days then dropped |
| Target | work, season and episode (or film), state, reason, next try, chosen release, quality wanted, priority, created by (owner, request, rule) | until done and filed, then kept as history |
| Release | hash, name, parse result, size, source, listed seeders, first and last seen | 30 days unless referenced |
| Verdict | hash, good/weak/dead/unknown, connected peers, bytes delivered, file list, checked at | 6 h (file list kept with the release) |
| Attempt | target, release, started, ended, why it ended | history |
| Block | hash, reason, scope (one work or everywhere), until | until lifted |
| Download | hash, release, targets it serves, selected files, root, state, added, finished | until removed; progress never stored |
| Request, User, Notification, PushSubscription, WatchItem, AutoRule | as today | as today |
| Setting | typed sections (engine, sources, metadata, remote access, desktop, quality) | permanent; secrets stay in files |
| SearchCache | query, source, results, at | 30 min |

### Downloading something you already have (films and series alike)
- **One rule for everything.** Every film and every episode is one item. An item with a present MediaFile, or one on an
  offline drive, is owned, however the file got there: downloaded, imported or adopted from another client.
- **Any download action** (Download, Download season, Download series, a request, a rule or the hunter) creates
  targets only for items that aren't owned.
  - The result message gives counts, for example "8 queued, 2 already in your library".
  - When everything is owned: "Already in your library".
  - Requests for owned items are marked fulfilled at once.
- **Origin is invisible to the user (owner, 2026-10-03).** Imported, adopted and downloaded files look identical everywhere: search, title page, episode rows, library. The title page shows "In your library, 1080p" whatever the origin. Origin is stored only for internal use (cleanup and diagnostics) and never shown.
- **Owned items show Upgrade, not Download (owner, 2026-10-03).**
  - An owned item never shows Download. It shows what you have, for example "In your library, 720p".
  - Upgrade appears only when the quality sweep found a healthy release that is better than the owned file and passes
    every check. Example: "Upgrade to 1080p (42 seeders)".
  - When nothing better exists:
    - there is no button, only the line "720p is the best available, checked 2 hours ago" with Check again;
    - there's an optional "Tell me when 1080p appears", which adds a watch to the hunter on the background budget and
      sends a notification when a healthy better release shows up. It never downloads by itself.
  - When the owned file already matches or beats your preferred quality: "In your library, 1080p" and nothing else.
- **Series:**
  - The season header summarizes, for example "10 of 10 in your library, 4 can be upgraded to 1080p", with Upgrade 4.
  - Each episode row shows its own quality and its own Upgrade.
  - Download season skips owned episodes and never upgrades them silently.
- **Upgrade mechanics:** an upgrade is a normal target of the Replace kind. The new file downloads alongside the old
  one, and the old file is removed only after the new one is complete and filed. If the upgrade stalls or fails, the
  old file stays untouched.
- **Replace** (in the item's menu) re-downloads the same quality, for a broken or wrong file. It uses the same
  mechanics.
- **Season packs** download only the files for items that aren't owned.
- **Where new items go:**
  - next to the title's existing files when they're inside a root;
  - otherwise by the placement rule, and the title page shows every location.
- **Duplicates found** by an import or a scan (two files for one item) are listed for the owner to choose which one to
  keep. Nothing is deleted automatically.
### Import media from another folder
1. The owner picks a folder.
2. The server scans it. Each file name and its parent folder go through the same Parser, and the result is matched to a
   Work through Metadata.
3. A review screen lists the matches: confident, needs a pick, and unmatched. Nothing changes until the owner confirms.
4. Each import asks the owner what to do with the files: leave them in place and track them, move them into the library with Jellyfin names, or copy them in and keep the originals (owner, 2026-10-03). Move and copy are verified before anything is deleted.
5. Imported films and episodes count as "have it", so they're never downloaded again. Better-quality upgrades are a
   later option, off by default.
6. Subtitle sidecars travel with their video file. Files that aren't media are left alone.

### More drives, partitions and folders
- **StorageRoot** records a path, the kinds it accepts (Movies, TV, Anime, Anime Movies), a priority, a free-space
  reserve and online/offline status. Roots are added and removed in Settings.
- **Placement** of a new download:
  - a series stays on the root that already holds it;
  - otherwise fill the highest-priority root that accepts the kind until its reserve is reached, then the next (owner, 2026-10-03);
  - otherwise the target waits with "No drive has space".
- **Jellyfin:** each root has the same kind folders, and each is added to the matching Jellyfin library.
- **Moving a title** between roots is an explicit owner action. It is a copy, then verify, then delete.

### Phases this touches
- 0.5 inventory adds the current path rules and client import.
- 1.1 adds StorageRoot and MediaFile.
- 1.5 adds roots and placement.
- 1.6 maps the old base path and path rules to roots.
- New task 5.3: Library scan and import, with a review screen. This is the one new UI piece.
- 7.1: existing downloads become MediaFile rows.

## Risks
- **Contract drift.** The captured contract and the full headless walk cover it.
- **The inventory misses a behaviour that worked.** It's reviewed every phase, and the owner sees the hard-set results.
- **MonoTorrent struggles on thin swarms.** Measured in phase 3. libtorrent comes in only if the numbers demand it.
- **Scope creep.** No new features until phase 7 is done.

## Open items for the owner
- Name one older finished network show and one non-English show for the hard set.








### Extra data for the user experience (owner agreed, 2026-10-03)
1. Media details from the file (resolution, HDR, codec, audio and subtitle tracks with languages, runtime) on MediaFile, read once when the file is added.
2. Watch state read from Jellyfin (watched, in progress, next up). Phase 6, with the Jellyfin connection.
3. Follow series: a flag per series; new episodes are wanted automatically when they air.
4. Per-title preferences: quality, audio language, size cap.
5. Release reasons: why each release was picked or rejected, kept 30 days (on Attempt and the plan result).
6. Later: drive usage history, a per-title event timeline, source track record.

### Scheduling: priority, ranking, release calendar (owner, 2026-10-03)
- Dynamic scheduling, not fixed backoff. Waiting targets are ordered by priority: owner "now" > owner rank > fresh episode around its air time > requests > followed back catalogue > upgrades and watches. Retry timing follows the likely release window (soon after air time, then easing off), not a flat 15 min to 1 day.
- Owner ranks downloads: drag to reorder the queue; rank decides both which waiting target is searched next and which download gets a slot under the cap. "Download now" on anything, including a request, jumps to the top and bypasses approval and the cap.
- Release calendar: a view of upcoming air dates and digital releases for followed series, watchlisted films and open requests, with each item's state (expected, searching, found, downloading, in library). From it the owner can follow, unfollow, set quality, or mark "grab as soon as it appears". The scheduler uses the same dates to search right after release.
- Stored: Target.priority and rank; Episode and Work air or release dates (digital and physical for films from TMDB release_dates); Target.expectedAt.
- Requesters see the calendar for their own requests only (owner, 2026-10-03): expected date and state per item, read-only.
- Requesters see full details for their own requests (owner, 2026-10-03): quality, size, release name, seeders, progress, speed, ETA and the pick reasons. Read-only; actions stay with the owner.

### Search names (owner, 2026-10-03)
- Every title (anime included) searches its English name first. The original-language or romaji name is searched only when the English search finds no good release (no candidate passes the gates with a good or weak verdict).
- Hard set completed: Prison Break (older finished show) and Money Heist / La Casa de Papel (non-English show).

- Agents: at most two running at once plus the coordinator (owner, 2026-10-03).

### Source decision (Phase 0 gate, 2026-10-03, decided under autopilot from docs/source-audit.md)
- Core: apibay, nyaa, eztv (series), yts (films, provisional), torrentscsv, knaben, animetosho (anime).
- Fallback, only when the core pool has no healthy match: therarbg, bitsearch (mandatory 429 cooldown), limetorrents,
  torrentdownloads, torrentdownloadinfo. The audit found unique healthy releases in each, so none is dropped.
- Off by default: 1337x (TLS failure on every call; retest before enabling), subsplease, archive (public-domain
  webseed use only), torznab (opt-in when configured).
