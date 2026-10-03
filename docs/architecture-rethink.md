# Architecture rethink: find, check, fetch, file

Status: proposal (2026-10-03). Owner asked for a rethink after regressions. No agents; coordinator only.

## What the evidence says (measured 2026-10-03 on 3930, main 90ef590)

| Finding | Evidence |
|---|---|
| Background searches are 5 to 13 times slower than interactive ones | The same indexers answer an interactive search in 2.9 s (172 results). Wanted-queue searches took 13.5, 20, 28, 35.7 s for indexers, plus 2.5 s of language hints every time. |
| One rate-limited source holds every search hostage | bitsearch returns HTTP 429; the backoff spaces its requests 3 s, then 6.4 s apart; background searches wait for the slowest source and retry up to 3 times inline. |
| Searches run per episode | One season of 8 episodes means 8 full fan-outs across about 14 sources, queued behind each other (indexer time grows 13 to 20 to 28 s across consecutive searches). |
| Picks trust advertised seeders | Little Fires Everywhere: 11 engine rows errored. libtorrent (the qBittorrent engine) also gets no file list for 10 of them in 120 s, so the swarms really are dead. The engine is not the cause; the choice is. |
| Fakes are found only after adding | Two "1080p AMZN/HULU WEBRip" releases were refused as Dangerous (program files) after being added and waiting for peers. |
| Fallbacks undo the rules | A rus.LostFilm release was queued after the English rule shipped. |
| Two sources of truth disagree | All 8 LFE AcquisitionTargets say queued or downloading for hashes that no EngineTorrent row has. |
| Machinery grew, the core flow did not | 31 hosted background services. Grabs alone: WantedQueue 858 lines, GrabService 759, AnimeNumberingReconciler 623, EpisodeLadder 349, ReleaseSwapService 315, LanguageLadder 146, SeasonFanout 93, plus pack-retries.json and relocation journals. |
| The port lost the old swarm probe | Next.js had swarm-probe.ts (966 lines: attach 8 s, verdict good/weak/dead/unknown, cached 6 h). The .NET side has a tracker scrape only, and a zero answer just caps seeders at 1. |
| Old build searched fewer, better sources | Next.js: nyaa, apibay, torrentscsv, yts, eztv, opt-in 1337x. Now about 14, including HTML scrapers (torrentdownloads, torrentdownloadinfo, limetorrents, therarbg, bitsearch) that list many dead or fake releases. |
| Engine listens on a new random port each restart | `ListenPort = 0` resolves to a fresh port, so UPnP mapping and DHT reachability restart from zero each time. |

LFE note: even the best live candidates (S01 1080p pack with 17 listed seeders, NTb episodes with 10 to 13) gave 0 connected seeds in 75 s from this machine. LFE is a thin-swarm show; the right answer there is the healthiest pack plus a clear "waiting for seeders" state, not 11 failed attempts.

## Keep

- Choosing another release (swap), the concurrent-downloads cap that applies instantly, the new UI and Downloads page.
- One release finder as the only picker (FEAT-32 intent), the English-only rule, file-list safety rules (`MediaFileRules`).
- MonoTorrent for now: libtorrent did no better on the same swarms. Revisit only if the benchmark shows a gap on healthy swarms.

## The new shape: one pipeline, one state per target

```mermaid
flowchart LR
  W[Want: work + scope] --> F[Find: one search per film or season]
  F --> C[Check: probe top candidates]
  C --> P[Plan: cover the episodes]
  P --> X[Fetch: engine]
  X -->|stalled or bad files| C
  X --> L[File into library]
```

1. **Want.** The owner's click records targets (film, or each episode of a season) and returns instantly. Nothing else happens at click time.
2. **Find.** One search per film or per season (`Show S01` plus `Show` for episode listings), never per episode. Per-episode searches only for episodes the season pool does not cover. Sources in two tiers: fast API sources first (apibay, nyaa, eztv, yts, torrentscsv, knaben); HTML scrapers only when tier 1 has no healthy candidate. Background searches use the same 6 s per-source deadline as interactive ones; a source that misses is retried on the next sweep, never inline. Rate-limited sources are skipped while cooling down instead of waited on.
3. **Check.** Before anything is added, probe the top few candidates per target in parallel for about 10 s: file list (safety, English tracks where the list shows them, which episodes a pack really holds) and connected peers. Verdict good, weak, dead or unknown, cached 6 h. Unknown is not dead. This replaces the language-hints step, the scrape-only health, and finding fakes after the add.
4. **Plan.** Per season: choose the set of releases that covers the wanted episodes with the best verified health, packs and episodes weighed together for finished seasons (owner rule, 2026-10-03). Per film: the best verified release. Non-English and dead releases are never chosen as a fallback.
5. **Fetch.** The engine downloads only the needed files. A stall watch: no progress for N minutes means the release is marked dead and the target goes back to Check with the next candidate. One engine row per target at a time; failed attempts are removed, not piled up.
6. **File.** Downloads write straight into their one final folder, as before (owner, 2026-10-03). No `.staging` folder and no move after completion; the staged-downloads flow from 818be51 is removed.

**One state per target:** `wanted -> finding -> checking -> fetching -> filing -> done`, or `waiting(reason, next try at)`. The target owns its state; transfer progress is read from the engine row it points at, never copied. This one loop replaces WantedQueue's retries, EpisodeLadder, LanguageLadder, SeasonFanout, pack-retries.json and the duplicated attempt bookkeeping.

## How we change it without another regression wave

Every stage must beat the previous one on a fixed benchmark before the next starts. No stage merges without it.

| Stage | Work | Gate |
|---|---|---|
| 0 | Benchmark harness: fixed list (Little Fires Everywhere S1, Fargo S1, Rick and Morty S1, Frieren S1, one recent film, one 4K film, one old film). Metrics: time to first result, time until every target is downloading or honestly waiting, connected seeds of each pick, wrong-language or unsafe picks, duplicate engine rows. Run it on current main and, if it still builds, on the last Next.js commit (5824ed5~1) for the baseline. | Numbers recorded for both. |
| 1 | Find: season-level search, source tiers, same deadline for background, skip cooling sources, fixed engine listen port. | Time to first result and to all-targets-started at or below the Next.js baseline. |
| 2 | Check: port the swarm probe to .NET (MonoTorrent probe engine already exists in HeaderProbe), file-list verdicts before add. | No unsafe or non-English pick; median connected seeds of picks up. |
| 3 | One target state machine plus stall watch; remove the ladders and retry files it replaces. | No duplicate engine rows; every target either progressing or waiting with a reason. Net code removed. |
| 4 | Delete dead code and services; fold anime numbering into Plan. | Hosted service count and Grabs line count down; benchmark unchanged or better. |

## Self-critique

- The probe from this machine saw 0 connected seeds even on listed-healthy LFE releases; verdicts must treat "no peers yet" as unknown and fall back to listed health, or thin shows will never start.
- Season-level search can miss oddly named episode releases; the per-episode search for uncovered episodes covers that, and the benchmark includes an anime and an old show to catch it.
- The Next.js baseline may not build anymore (node deps, Prisma). If it doesn't within a short time box, the baseline is the owner's memory plus current numbers, and that is stated plainly.
- Existing AcquisitionTarget and EngineTorrent rows need a one-time reconcile when the state machine lands; it must run on a copy of the owner's real data, not a sanitized one.
- Probing costs connections and RAM; limit to the top 3 candidates per target and 10 probes at once.

## Connectivity note (owner, 2026-10-03)
Ruled out. Rick and Morty downloads well on the home connection; the Little Fires Everywhere failures were poor torrents. The cause is release picking, which the swarm check addresses.

## Benchmark: hard-to-find set (owner, 2026-10-03)
Sources are judged on hard titles, not only popular ones. Each source's unique healthy finds on this set decide whether it stays.
- Scorpion (2014): one-word generic name that collides with The Scorpion King, Mortal Kombat and other releases.
- Little Fires Everywhere (2020): short limited series with thin single-episode swarms.
- One older finished network show and one non-English show (to be picked with the owner).
- Anime under its romaji name (Frieren, Koe no Katachi).
- Control: Rick and Morty (owner confirmed it downloads well).

## Metadata decides candidates (owner, 2026-10-03)
Every candidate is checked against the work's metadata before it can be picked, and the benchmark records each check's verdict. Frieren is the reference case.
- Names: the release title matches one of the work's names (English, romaji, synonyms); lookalikes are rejected.
- Episode map: the episodes a release claims (SxxEyy, absolute numbers like 01-28, ranges, batches) are mapped onto the metadata's seasons and episode counts. A pack must hold exactly the episodes it claims, confirmed from its file list.
- Numbering: split cours and absolute numbering are mapped onto the metadata; an episode number beyond the season's count is a mismatch.
- Size: the size per episode is plausible for the quality and runtime.
- Year: matches when the release states one.
A candidate that fails any check is out, whatever its seeders.

## Module contracts (owner rule: separation of concerns, one job each)
Each module does exactly its job. Anything listed under "never" belongs to another module.

| Module | In | Out | Does | Never |
|---|---|---|---|---|
| Metadata | provider id or title query | Work: names (labelled), ids, kind, seasons, episodes, air dates, runtime | fetch, merge providers on verified ids, cache | search torrents, decide film vs series from release names, write files |
| Sources | query text, category | raw results (name, hash, size, listed seeders, source) | call one site, respect its rate limit and queue, report errors | parse episodes, rank, scrape trackers, retry inside a search, decide health |
| Parser | release name | title, seasons, episodes, absolute numbers, range or batch, quality, source, group, language markers, year | normalise and read numbers (pure, no I/O) | know about works, metadata or sources |
| Find | Work + target scope | candidate pool, deduped by hash, with which source and query found each | build queries from Metadata names, ask Sources, run Parser, apply the search budget and early stop | judge health, pick, talk to the engine |
| Check | candidate hashes | verdict per hash (good, weak, dead, unknown), file list, connected peers, cached | probe inside the main engine, tracker scrape as a pre-filter | pick, keep downloads, decide language beyond reading the file list |
| Plan | pool + verdicts + Work metadata + target set | choice per target with the reason for every rejection | gate against metadata (names, episode map, size, year, safety), rank by health then quality, pack vs singles (pure, no I/O) | search, probe, add torrents, store state |
| Engine | add, select files, pause, resume, remove | progress, peers, stall signal, completion | move bytes, enforce the concurrent cap, stop seeding on completion | pick releases, rename or move files, know about works |
| Library | target + engine file list | final paths, partial suffix, hidden unwanted files, Jellyfin names | decide folder and names when metadata arrives, rename in place on completion, delete on swap or removal | download, search, decide what to download |
| Targets | owner actions, worker ticks | one state per film or episode, with reason and next try time | own state; the pipeline worker calls Find, Check, Plan, Engine, Library in order | contain search, ranking or file logic; copy engine progress |
| API | HTTP | JSON for the web app | validate input, call Targets, Metadata or settings, shape responses | contain business logic or direct DB queries outside its module |

### Where today's code mixes jobs (do not port these shapes)
- TorrentSearchService fans out to sources, scrapes trackers and rewrites seeders (Sources, Check and Plan in one).
- WantedQueue searches, retries, applies language rules and handles packs (Targets, Find and Plan in one).
- GrabService builds queries, picks and sends (Find, Plan and Engine in one); ReleaseSwapService has its own query path.
- MonoTorrentBackend places and relocates files (Engine doing Library work); HeaderProbe runs its own engine (Check outside the main engine).
- ReleaseRanking dedupes and keeps the max seeders (Find and Plan in one, with the wrong rule).