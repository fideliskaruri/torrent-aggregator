# Handover: how TorrentFlow actually works

Read this before changing anything. It is the map an agent (or a future you)
needs to be productive without re-deriving decisions that were made for
non-obvious reasons. `README.md` is for *running* the app; `AGENTS.md` is the
behavioural contract; this file is the *why*.

---

## 1. What the product is

One install that replaces the *arr stack: **search many indexers → rank the
results → send the best one to a built-in BitTorrent engine → organise the
files into a smart library path**. Single user, no sign-in, bound to
`127.0.0.1`.

The whole product is that pipeline. Every module below is one stage of it.

### Request boundary and deployment model

TorrentFlow remains a one-process, local single-user application. It may be
reached directly over loopback, through a private VPN, or through a reverse
proxy, but forwarded headers are never authentication inputs.

Mutation routes using `src/lib/http/request.ts` apply a browser-only origin
check before parsing JSON. Browser requests classified `cross-site` are
rejected; `same-origin` is accepted (including a correctly configured reverse
proxy), and `same-site` must carry an `Origin` exactly matching the request
origin. Requests without Fetch Metadata remain compatible with curl,
server-to-server callers, and non-browser test clients. JSON media type, byte
limits, and scalar/array bounds are then validated before any side effect.

```
 UI (/search)                    automation (scheduled or manual)
      │                                        │
      └────────────► searchTorrents ◄──────────┘
                     (aggregator.ts)
                            │
        adapters ──► applyFilters ──► rankResults ──► best magnet
     (nyaa, apibay,   (filters.ts)     (ranking.ts +      │
      yts, csv, 1337x)                  quality.ts)       │
                                                          ▼
                                          builtin-engine.ts (WebTorrent)
                                                          │
                                          content-layout*.ts + smart-category.ts
                                                          │
                                              downloads/TV/Show/Season 03/
```

---

## 2. The pipeline, module by module

### Search and ranking — `src/lib/torrents/`

| File | Role |
|------|------|
| `aggregator.ts` | Fans out to every adapter, merges, caches, dedupes. **Owns the indexer budget** (see §4). |
| `adapters/*.ts` | One per indexer. Each returns `SearchResult[]`. Adapter failures are isolated — one dead indexer must never fail the search. |
| `filters.ts` | `applyFilters` — seeders, size, category, `releaseKind` (packs vs episodes). Runs **before** ranking. |
| `ranking.ts` | Orchestrates scoring and attaches `episode` metadata to each result. |
| `quality.ts` | The comparator. Ported from Sonarr's logic. **This is the most subtle file in the repo** — read `docs/architecture/release-ranking.md` before touching it. |
| `episodes.ts` | `parseEpisode(title)` → season/episode/pack detection. Consumed by ranking, filters, path layout and category detection, so a change here ripples everywhere. |
| `work-identity.ts` | Which **film or series** a release belongs to. `workIdentity()` / `groupReleasesByWork()`. Identity comes from the *release name*, never `metadata.title` — see the invariant in §3. |
| `search-cache.ts` | TTL cache + the budget counter. |
| `adapters/mirrors.ts` | Mirror failover. Public indexers lose hostnames; without this, one dead host silently deletes an entire source (see §4). |
| `target-resolution.ts` | Short-lived memo of the user's quality target. Must be invalidated when settings change or the user sees stale ordering. |

**Indexer reality, as measured.** Adapters do not degrade gracefully by
accident — they degrade because the code says so, and the source-health strip in
search results is the only thing that tells the user the difference between "the
indexers answered and had nothing" and "half of them are down".

| Source | Status | Notes |
|--------|--------|-------|
| `torrentscsv` | working | The only source answering for older TV. |
| `yts` | working **via mirror** | `yts.mx` stopped resolving; `yts.lt` and `movies-api.accel.li` answer. Movies only. |
| `nyaa` | working | Anime. |
| `eztv` | working | TV only, and only recent seasons. Requires `TMDB_API_KEY` — its API filters by IMDb id and **ignores free text**, so titles are resolved through TMDB first. Returns `[]` (not an error) when unconfigured. |
| `apibay` | **down** | Cloudflare interstitial; a browser User-Agent no longer passes it. No working mirror found. Reports honestly rather than pretending to be empty. |
| `1337x` | off by default | Cloudflare-blocked from most networks. `ENABLE_1337X=1`. |

### Download and layout — `src/lib/clients/` and `src/lib/download/`

| File | Role |
|------|------|
| `builtin-engine.ts` | The in-process WebTorrent engine. The biggest file in the repo. Durable state lives in the `EngineTorrent` table so torrents survive a restart. |
| `content-layout*.ts` | Strips release-name wrapper folders so files land *in* `Show/Season NN`. Three files: policy (what should happen), the applier, and repair (fixing what already landed wrong). |
| `smart-category.ts` | Title → category (Anime / TV / Movies / Software / …). Domain signals beat weak movie heuristics — an app with a year in its name is not a film. |
| `qbittorrent.ts`, `transmission.ts` | Optional external clients. The built-in engine is the default and the supported path. |
| `disk-space.ts` | The storage cap and free-space floor, enforced on **every** send. |

### Playback — `src/app/api/stream/`, `src/components/watch/`

| File | Role |
|------|------|
| `api/stream/[infoHash]/route.ts` | Lists the video files in a live torrent so the player can offer a file picker. |
| `api/stream/[infoHash]/[...filePath]/route.ts` | The byte-range endpoint. Serves HTTP 206 straight out of the live swarm via `file.stream({start,end})`. |
| `builtin-engine.ts` → `findBuiltinTorrentFile`, `prefetchBuiltinFileEdges` | The lookup and the head/tail warm-up. Purely additive to the engine. |
| `components/watch/inline-player.tsx` | The in-tab player, plus "Copy stream URL" for VLC/MPV. Built-in engine only. Negotiates capabilities with the server and uses HLS.js for remux/transcode playback. |
| `lib/media/probe.ts` | Runs ffprobe against the stream endpoint to identify codecs, container, channels, HDR. Caches in `MediaProbe` Prisma model. Also owns `requestOrigin()` and `streamUrl(infoHash, path, origin)`. |
| `lib/media/capabilities.ts` | `ClientCapabilities` type — what the browser can decode (canPlayType + MSE). Sent from client, validated on server. `supportsCodecTag()` is the decision primitive. |
| `lib/media/decide.ts` | Pure playback decision: `decidePlayback(probe, caps, opts) → PlaybackPlan`. 4 rungs: direct / remux / transcode-audio / transcode-full. Exhaustively unit-tested. |
| `lib/media/session.ts` | FFmpeg session manager. Spawns `-c copy` remux or transcode into fMP4/HLS. Ref-counted, idle-timeout, concurrent session cap, stall watchdog, orphan cleanup. |
| `api/playback/plan/route.ts` | `POST /api/playback/plan` — probes, decides, starts session if needed, returns the play URL. |
| `api/playback/hls/[sessionId]/[...segment]/route.ts` | Streams HLS manifests and fMP4 segments from active ffmpeg sessions. Range-capable, never reads a whole segment into memory. |

Streaming exists **only** for the built-in engine — `file.stream()` is an
in-process WebTorrent API with no qBittorrent or Transmission equivalent, so the
route answers 409 and the UI hides the button for other clients.

#### Playback rules that are load-bearing

- **Capability is a codec tag inside a container family, not an exact MIME
  string.** The browser only ever probes a handful of literal
  `type="video/mp4; codecs=..."` strings; matching those exactly meant any
  untested combination (`hvc1.2.4.L120.B0,ec-3`) silently answered "no" and got
  needlessly transcoded. `canDecodeViaMSE` now takes an exact hit as
  authoritative in *both* directions and otherwise decomposes into per-tag
  evidence. A negative is only authoritative for an exact string — that is what
  keeps `video/x-matroska` (the real blocker) unsupported while letting new
  codec pairings through.
- **Never blind-downmix.** `-ac <source channels>` is always emitted; a
  re-encode targets `eac3` precisely because it carries 5.1 losslessly enough
  and is universally supported. AAC above 2 channels needs `-strict -2`.
- **Channel *count* is the source of truth, never `channel_layout`.** The
  bundled ffprobe 4.0.2 reports an empty layout for 6-channel E-AC-3.
- **ffmpeg runs with `cwd: outputDir` and relative HLS filenames.** With an
  absolute `-hls_segment_filename`, ffmpeg still resolves
  `-hls_fmp4_init_filename` relative to the process CWD, so `init.mp4` landed in
  the repo root while the playlist pointed at the session dir. That broke *all*
  fMP4 playback.
- **One audio track per HLS session.** `plan.audio` lists every track for the
  picker; `selectedAudioIndex` is what ffmpeg muxes. Switching language restarts
  the session. Streams are selected with explicit `-map 0:<idx>` — without it
  ffmpeg keeps exactly one audio stream and *silently ignores* `-c:a:1`. Note
  `-c:a:N`/`-ac:a:N` are output-relative indexes while the plan carries ffprobe
  indexes; never mix the two spaces.
- **Seek = restart the session at an offset.** `-ss` before `-i` rebases output
  timestamps to ~0, so the HLS timeline always starts at zero and the *player*
  owns the offset (`startSec + video.currentTime`). With `-c copy` the start
  snaps back to the preceding keyframe, so expect up to one GOP of drift.
- **The native control bar must stay off in HLS mode.** Its scrubber measures
  the *generated segment window*, not the film, so it read `0:00 / 0:04` for a
  2:30 film — directly beneath our source timeline reading `1:50 / 2:30`. Two
  scrubbers that disagree are worse than one, and dragging the native one went
  nowhere. `inline-player.tsx` owns the transport in HLS mode and speaks only in
  film time. Direct (non-HLS) playback keeps native controls, where the timeline
  *is* the file and is therefore correct.
- **Transport state follows the media events, never the click.** `isPlaying` is
  set from `onPlay`/`onPause`, so a refused autoplay or a stall cannot leave a
  pause icon sitting over a stopped video. `togglePlay` reads `video.paused` and
  swallows the play rejection rather than optimistically flipping state.
- **`-rw_timeout` fires but ffmpeg still exits 0.** Verified against a server
  that goes silent without closing: ~15 s, `Error number -138`, exit code 0. A
  clean exit code therefore proves nothing — `session.ts` scans stderr *and*
  runs an output-progress watchdog (45 s startup / 30 s mid-stream, counting
  `.m4s` files). Once the watchdog has diagnosed a stall, the exit handler must
  return early or it overwrites the useful message with "exited with code null".
- **Binaries resolve lazily *and* never trust the path they are handed.**
  `require('ffmpeg-static')` at module load meant a missing binary crashed the
  entire server at import. Worse, both static packages build their path from
  `__dirname`, which Next's server compiler rewrites — inside a route handler
  they advertise `/ROOT/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe`,
  which exists nowhere, so **playback was dead in the running app while every
  script and unit test passed**. `src/lib/media/ff-binaries.ts` resolves on
  first use, honours `FFMPEG_PATH`/`FFPROBE_PATH`, re-roots any advertised path
  under the real `node_modules`, and otherwise throws `FfBinaryMissingError`
  with an actionable message. Any future bundled binary must go through it.
- **A torrent-backed HTTP source will be cut short; ffmpeg must reconnect.**
  The stream route caps an open-ended `Range: bytes=N-` at 8 MiB (browsers
  re-request; ffmpeg does not). ffmpeg logged
  `Stream ends prematurely at 8388608` and killed the session, so **every file
  over 8 MiB failed to remux**. `buildFfmpegArgs` now passes `-reconnect 1
  -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5`.
  Do **not** add `-reconnect_at_eof` — sessions would never finish. The bounded
  backoff (~7 s) matters: it leaves the 30 s stall watchdog its turn.
- **`startPosition: 0` in the player's hls.js config is not cosmetic.** ffmpeg
  writes an EVENT playlist and only appends `#EXT-X-ENDLIST` when muxing
  finishes, so while a session is still running hls.js classes it as *live* and
  starts at the live edge. Measured on a 120 s clip that remuxes far faster than
  real time: hls.js defaults landed at **44.0 s**, the shipped config at
  **0.2 s** (`scripts/media-browser-playback.mts`, "Start position on a
  still-growing playlist"). Pinning to 0 is always safe because `-hls_list_size
  0` keeps every segment in the window, and a seek-restarted session's timeline
  also begins at 0 (the player owns the offset).



| File | Role |
|------|------|
| `cursor.ts` | The hunt cursor: which episode a monitored show is waiting for. `advanceCursorAfterMiss` is a data-loss surface — see §3. |
| `runner.ts` | `runUserAutomation(userId)`. The whole automation pass. |
| `run-lock.ts` | Per-user row lock, 15-minute stale window. Prevents two overlapping runs double-grabbing. |
| `scheduler.ts` | The background timer. See `docs/architecture/automation-scheduling.md`. |
| `ondemand.ts` | "Download next" / rewatch from the Library UI. Shares the cursor rules with automation. |

### Metadata and suggestions — `src/lib/metadata/`, `src/lib/recommend/`

| File | Role |
|------|------|
| `metadata/enrich.ts` | Title → catalog record. Arbitrates between AniList and TMDB, penalises a media type that contradicts the request, strips release noise from the title, and falls back to progressively shorter prefixes (see §4). |
| `metadata/tmdb.ts`, `metadata/anilist.ts` | The two catalogs. TMDB needs `TMDB_API_KEY`; AniList needs nothing. |
| `recommend/index.ts` | One "Because you're watching X" rail from the catalogs' own `/recommendations`. **No recommender is implemented here and none should be** — TMDB `/similar` is a genre-vector match that returns 320,032 films similar to *Oppenheimer*, and a hand-rolled version over a five-row library would be strictly worse. Cached by `next: { revalidate }`, nothing else. |
| `scripts/backfill-metadata.mts` | One-time repair for library rows created without a real catalog id or artwork. Resolves each row against the catalog its `mediaType` implies, because the schema's `externalId` is "AniList id **or** TMDB id" and `mediaType` is what tells them apart. |

---

## 3. Invariants you must not break

These are all things that were once wrong, shipped, and cost real debugging.

**Nothing is ever rejected for its resolution.** The quality target is a
*target*, not a floor — releases are ordered by closeness to it. If you add a
hard resolution filter, a monitored show with only 720p available silently
starves forever. `docs/architecture/release-ranking.md` has the full ordering.

**Never filter out 0-seeder releases upstream of the viability gate.** A
brand-new episode has 0 seeders for its first minutes. When the search filter
dropped them, automation saw "no results", recorded a hunt miss, and after
three misses `advanceCursorAfterMiss` rolled to the next season — silently
skipping episodes forever. The gate that decides "too thin to finish" must be
the *only* place seeders are judged, and it has a 6-hour escape hatch
(`seederWaitSince`) so a stable 2-seeder swarm is not deferred indefinitely.

**`normalizeTitle` already strips resolution, codec and episode tokens.** So
`"One Piece S01E05 480p WEBRip"` normalises to exactly `"one piece"`. There is
deliberately **no exact-title relevance tier**: it rewarded scene naming and
punished `[SubsPlease]`-style anime releases.

**Bare `4k` is marketing text, not a resolution**, but standalone `UHD` is a
real one. Unknown resolutions rank last, so misparsing a genuine 4K disc put it
below 360p.

**`overflow-x: hidden` belongs on `html` only.** Per CSS Overflow 3, a
non-`visible` value on one axis forces the other to `auto`. It used to sit on
`html`, `body`, `.app-shell` and `.app-main`, which stopped the UA propagating
`body`'s overflow to the viewport — so `body` became its own scroll container,
nothing scrolled, **every** `position: sticky` element was broken, and the
mobile modal's scroll lock was inert. One cause, three symptoms. `globals.css`
carries the full rationale in comments. Do not re-add it lower down.

**Automation grabs one episode at a time, in order.** The Library UI says so
explicitly. If you change that, change the copy in the same commit.

**A duplicate at the hunt cursor must still advance the cursor.** "Already in
the client" means the episode *has been acquired* — by a manual grab, an
auto-rule, or a previous pass that crashed after sending. The dedupe branch used
to return early and record nothing, on the reasoning that a duplicate is not a
miss. True, but it does not follow that nothing should happen: the cursor never
moved, so every subsequent run re-found the same episode, deduped, and skipped
again. The show froze at that episode **permanently**, with no error anywhere —
worse than a skip, because nothing ever signals it. A duplicate at the cursor is
success-by-other-means. It advances the cursor exactly as a successful grab
does, but only when the candidate genuinely matches the cursor episode; advancing
past an episode that was neither sent nor already held must stay impossible.

**The client send happens *before* the recording transaction, never after.**
The send is an external side effect that cannot be rolled back. With send first,
a crash leaves the cursor un-advanced and the next run retries — safe. Reversed,
a crash after the commit would advance the cursor past an episode that never
reached the client, losing it silently. `GrabJob`, `DownloadHistory` and the
caller's cursor/rule state all commit in **one** transaction (hooks receive the
`tx` handle) so they can never disagree. Keep no network calls inside it.

**The app must never claim something it does not do.** The watchlist said
"monitoring" for months while nothing ran on a timer. Honest copy is a feature.

**Work identity is derived from the release name, never from catalog
metadata.** A "dune" search once rendered as a single card headed
`DUNE · 2017 · 127 releases` whose "S01" tab interleaved *Dune: Prophecy*
episodes with *Children of Dune* episodes. The page decided its subject by a
majority vote on `metadata.title`, so one bad fuzzy enrichment match relabelled
five distinct works at once — and because seasons were bucketed by number alone,
two different shows shared one season tab. `src/lib/torrents/work-identity.ts`
keys on the release name, which is self-describing and always present; catalog
metadata may only *improve a label it agrees with*. A wrong match can now make a
heading less pretty. It can no longer merge two works. Films key on name **+
year** (*Dune* 1984 ≠ *Dune* 2021); series key on name alone, because a series'
releases disagree about the year and including it shatters one show into several.

**A catalog title may refine a name, never blur one.** The corollary to the
above, and a bug in its own right. `catalogAgrees` originally tested
containment in *both* directions, so a single mis-enriched row titled "Dune"
contains-matched *Dune Prophecy*, *Children of Dune* and *Dune Part Two* at
once. The grouping stayed correct — identity never comes from metadata — but
all five works came back named "Dune" wearing Dune's poster, so a correct split
rendered as five identical headings under five copies of one artwork: exactly
the illegibility the split exists to remove. The test is now one-directional —
the catalog title must *contain* the release-derived name, not be contained by
it — so "The Office" → "The Office (US)" is still accepted and "Children of
Dune" → "Dune" is not. Rejecting the vaguer title costs nothing: the
release-derived name was already correct, just less pretty.

**An empty result and a failed request are different states.** `/history` ran
its fetch in a `try`/`finally` with no `catch`, so a rejected request cleared
the spinner and rendered the empty state — telling the user their download log
was empty when it could not be read, and offering no retry because nothing
thought anything had gone wrong. Use `useApiQuery` (`src/hooks/use-api-query.ts`),
which keeps `loading` / `error` / `data` mutually exclusive, and render failures
with `TfErrorState` (`src/components/tf/error-state.tsx`), the sibling of
`TfEmptyState` that always offers a way to try again. Never narrow a failure
into an empty list.

Being *near* this pattern is not the same as following it. `/watchlist` set an
`error` state and rendered it, so it looked correct at a glance — but the
banner and the empty state were separate, non-exclusive branches, so a failed
load rendered the error *and*, directly beneath it, "No items yet — Search a
show, Add to library". The user is told to go and populate a library they
already have. The exclusivity is the whole point: `error ? <TfErrorState/> :
empty ? <TfEmptyState/> : <list/>`, one chain, never two independent `{x ? …}`
blocks. That page also ran the same fetch twice, from a `load` callback *and* a
mount effect, which is how the two branches drifted apart in the first place.

**`availability: null` is not `"unavailable"`.** `null` means *not yet
determined* — resolving `fetchable` needs an indexer search, which is too slow
for the home page. It must render as a neutral, clickable affordance. Treating
it as `unavailable` tells the user something is unwatchable when it may already
be on disk.

**Derive `mediaType` through `src/lib/metadata/media-type.ts`, not inline
comparisons.** Six call sites had each grown their own `mediaType === "anime" ?
… : "tv"` chain, and they disagreed in three ways: the fallback (`"all"` vs
`"tv"` vs `null`), normalisation (only one trimmed and lowercased), and aliases.
A row stored as `"Movie"` — the casing TMDB's own UI uses — matched no branch and
fell through to the `"tv"` fallback, so the hunt searched the TV category for a
film, found nothing and counted a miss. Nothing errored. The shared module owns
normalisation and the mapping but deliberately **not** the fallback: it returns
`null` for anything it cannot vouch for, and each caller states its own default
in the open, because a hunt is right to assume `"tv"` and a browse rail is right
to render no category at all.

**Never reconstruct another caller's `SearchCache.cacheKey`. Look up by
`normalizedQuery`.** `cacheKey` is a sha256 over the *entire* search option set
— category, limit, sources, filters, and the user's target resolution. The
browse availability resolver used to rebuild that hash from the outside with
guessed values (`limit: "default"`, `filters: {}`, and no `target` at all), so
it could never collide with what `searchTorrents` actually wrote. Every lookup
missed, which made `fetchable` and `unavailable` **unreachable states**, and the
page still looked perfect because a miss degrades to the neutral "not checked"
affordance. The unit tests stayed green throughout because they call
`resolveFromSearchCache` with a hand-built object and never cross the seam.
`SearchCache.normalizedQuery` exists so the consumer can ask its real question —
"the latest search for this title" — without knowing which caller ran it or with
which options. `npm run test:seam` writes through the real producer and reads
through the real consumer; it fails if that link is ever broken again.

**A rail may not assert an availability it did not check.** `Continue Watching`
hardcoded `availability: "warm"` for every `PlaybackProgress` row. There is no
foreign key from `PlaybackProgress` to `EngineTorrent` and nothing deletes
progress when a torrent is removed, so a deleted download kept rendering as
partially-downloaded with a resume position and a Play button that could not
play — the one thing the availability contract forbids. Every rail now resolves
state from `EngineTorrent`, and `null` ("we cannot say") is an acceptable
answer; `unavailable` is a claim and must be earned.

**Catalog-title matching is one-directional everywhere, not just in
`work-identity.ts`.** The poster lookup in `src/lib/browse/rails.ts` had its own
`normName.includes(metaKey) || metaKey.includes(normName)`, re-introducing the
exact bug `catalogAgrees` exists to forbid — and it compared against the *raw
torrent name*, which contains every short catalog title appearing anywhere in
it. Because rows are scanned `updatedAt desc` with a `break` on first match,
*which* wrong poster you got depended on your recent search history. Derive the
work name first, then use `catalogAgrees`. A miss costs nothing; wrong artwork
costs trust.

**Every cursor-advance site resets `cursorMisses` and `seederWaitSince`.**
There are three (`automation/runner.ts` on success, the same file's
duplicate-at-cursor branch, and `library/ondemand.ts`), and the on-demand one
used to reset neither. Leaving `cursorMisses` non-zero keeps an item in hunt
backoff for hours immediately after we proved releases are findable; leaving
`seederWaitSince` set points the 6-hour thin-swarm escape hatch at the
*previous* episode's wait, so it can fire instantly on the new one and grab a
0-seeder release that should have been deferred. Both failures are silent — the
grab reports success and automation just quietly does less than it should.

**Normalise an infoHash before it touches a unique key.** `EngineTorrent.hash`
is stored lowercase and the playback-plan route normalises, but `POST
/api/progress` stored `body.infoHash` verbatim into the
`[userId, infoHash, filePath]` unique key. A player posting a mixed-case or
base32 hash would create a *second* progress row for the same file, and resume
would silently restart from zero while the original row sat there invisibly.
`normalizeInfoHash` is the single gate.

**A bare space is not a scene-group delimiter.** `filmNameFromRelease` strips a
trailing `-GROUP` so that three prints of one film key together. It used to
accept a space as the delimiter too, guarded by a small allow-list of words it
would not eat (`the`, `of`, `and`, `part`, ...). By shape alone the last word of
an ordinary title is indistinguishable from a group name, so that rule
truncated real titles whenever *neither* the year cut nor the quality cut
fired — which is most releases scraped from listing sites rather than scene
names. Observed live on a `breaking bad` search: the plain torrent
`Breaking Bad` became a work called **"Breaking"**, and
`El Camino A Breaking Bad Movie (2019) [1080p] [WEBRip]` lost its "Movie",
keying apart from the same film's other prints so that one film rendered as
**two** works. Scene groups are always joined with `-` or `_`; require one.

**A cut can strand an opening bracket.** The bracket-block strip in
`filmNameFromRelease` only removes `(...)`/`[...]` blocks with at most 48
characters inside. A longer block survives, the quality cut then fires *inside*
it, and the name keeps a dangling `(` — live, `El Camino - A Breaking Bad
Movie (`. The trailing-punctuation cleanup that follows did not list brackets,
so this reached the heading. Any future cut added to this function must be
followed by the same cleanup.

**A screen reader does not see `margin`.** Adjacent text nodes are announced
with no separator, so a work heading built as `{name}<span class="ml-1.5">
{year}</span>` says "Dune1984". Visual spacing and accessible spacing are
different things: emit an explicit `{" "}` and shrink the margin to match.
`scripts/shoot-dune.mjs` asserts this — axe cannot see it, and neither can a
screenshot.

**...and `gap` is not a separator either — and `{" "}` will not save you in a
flex row.** The browse teaser announced "Active downloads2" for exactly the
reason above, but the fix that works in an inline heading does not work here:
CSS Flexbox does not generate anonymous flex items for whitespace-only text, so
a bare `{" "}` between two flex children is dropped outright and the accessible
name is unchanged. The separator has to be a real glyph — an `sr-only` comma —
which is also what makes a screen reader pause between the label and the count.
`npm run test:browse` asserts no heading glues a letter to a digit.

**A card's artwork must not repeat the words printed beneath it.** Every rail
card renders a caption (title, then subtitle) directly under the poster box,
*unconditionally*. The no-artwork fallback tile used to set the title and
subtitle inside the box as well, so every poster-less card showed its name
twice, eight pixels apart — and posters are missing for most releases (engine
rows carry none, and the metadata join misses often), so this was the common
case, not the edge case. The hero variant already existed to avoid precisely
this collision with its `h1`; the same reasoning simply had not been applied to
the card. `FallbackTile` is now a mark only — tint, hairline, ghosted initial —
and takes no `subtitle`. `npm run test:browse` fails if any card's artwork
contains its own caption.

---

## 4. Things that look wrong but are deliberate

- **`.mkv` is served as `Content-Type: video/x-matroska`.** This used to be a
  lie (`video/webm`) that worked because Chromium would demux MKV; the playback
  ladder now handles incompatible containers properly via the `decidePlayback`
  engine in `src/lib/media/decide.ts`, so the MIME type is honest. The ladder
  probes the file, negotiates with the browser's real capabilities, and remuxes
  MKV → fMP4 when needed (the dominant case) at near-zero CPU.
- **The stream route emits a fake `torrent.emit("verified", -1)` when a request
  is aborted or stalls.** WebTorrent's `FileIterator.next()` parks on a
  `'verified'` listener that only unregisters when the emitted index matches the
  piece it wants *or* the iterator is destroyed — so with zero peers it never
  fires and the listener leaks. `-1` can never match a real piece index, so it
  can only take the destroyed branch: it evicts the listener and can never cause
  a spurious read. It must be emitted **after** awaiting `reader.cancel()`,
  because that is what sets `destroyed`. Emitting it earlier silently leaks;
  there is a regression test that fails if you reorder it.
- **Silent audio is detected with `webkitAudioDecodedByteCount`, not
  `audioTracks`.** Chrome and Edge do not implement `HTMLMediaElement.audioTracks`
  at all, so the spec API is dead code there. The check waits for real playback
  progress before firing, because both counters read 0 before the first frames
  land and checking earlier reports every file as silent. This matters because
  the common failure is **soundless video, not an error** — most WEB-DL releases
  carry Dolby AC-3/E-AC-3, which no browser will ever decode (a licensing
  decision, not a bug), so without this the user blames the downloader.
- **`ADD_OPTIONS.strategy = "sequential"` in `builtin-engine.ts` is worse for the
  swarm on purpose.** It is what makes playback-before-completion possible. It
  was paying that cost for a long time before the stream route existed; if you
  ever remove playback, remove the strategy too.

- **The rate limiter is an *indexer* budget, not a request limit.** It lives
  inside `aggregator.ts` at the upstream fan-out, not on the API route.
  Reasoning: on a no-auth localhost app there is no adversary to throttle; what
  needs protecting is the indexers, which ban IPs. A route-level limiter also
  charged cache hits (which contact nobody) and missed automation entirely
  (which calls `searchTorrents` directly). Stale cache is served in preference
  to erroring. **Foreground and background draw on separate budgets** — a
  watchlist pass over twenty shows would otherwise spend the whole minute's
  allowance and throttle the human sitting at the search box. Pass
  `background: true` from anything scheduled.
- **Repeatedly-missing watchlist items back off, but are never dropped.** See
  `huntBackoffMs` in `src/lib/library/cursor.ts`. A cursor parked at S04E01 of a
  three-season show cannot roll over (rollover requires `episode > 1`, because
  at E01 an empty result means "not available", not "season finished"), so it
  would otherwise burn one indexer request per scheduler tick forever. Backoff
  rather than a terminal "give up" is deliberate: an empty result is ambiguous,
  and with apibay down it is frequently a lie. A grab resets `cursorMisses` to
  0, so it self-heals.
- **An adapter that is unconfigured returns `[]`, not an error.** `eztv` without
  `TMDB_API_KEY` is not an outage, and claiming one in the source-health strip
  would be false.
- **Automation dedupes on what the client still holds, not on history.** The
  library check queries `EngineTorrent` by info hash, not `DownloadHistory`.
  That is deliberate in both directions: an episode reappearing on another
  indexer under a different magnet is not downloaded twice (which is how the
  duplicate release folder in §8 was created), but a release the user has
  deleted *is* grabbable again.
- **An auto-rule verifies its own category before grabbing.** The indexer's
  category filter is a request, not a guarantee — a rule named "Weekly anime"
  once grabbed a live-action drama. `matchesRuleCategory` in `rules/runner.ts`
  re-derives the kind from the release itself and deliberately does *not* pass
  the rule's own category in as a hint, which would let the check answer with
  the question. This is why rules run with `enrich: true`: catalog metadata is
  the only thing separating an anime episode from a live-action one when both
  are `SxxEyy` on the same indexer.
- **`resolveMetadata` penalises a candidate whose media type contradicts the
  request.** "Severance" is a 2015 film and a 2022 series, both exact title
  matches, so whichever the catalog listed first used to win — and the wrong id
  was then written to the library row. Anime is exempt, since anime is
  legitimately both series and films.
- **The recommendation rail renders nothing rather than an empty shelf.** No
  catalog id, no TMDB key, a provider outage and "everything suggested is
  already in the library" all resolve to *absent*. An empty rail reads as
  "there is nothing for you" when the truth is "we could not ask".
- **Suggestions are added `planned` and unmonitored.** A suggestion has not
  earned disk. `POST /api/watchlist` takes `monitored: false` for exactly this;
  it used to hardcode `true`, which would have made clicking a poster start a
  download.
- **Automation is opt-in and defaults to off.** A timer that downloads files
  while nobody is watching should be switched on, not discovered afterwards.
- **`cleanTorrentTitle` strips a bare season token, and `resolveMetadata`
  retries on shorter prefixes.** Catalogs match literally: TMDB returns *nothing
  at all* for `The Bear S03`, so a season search rendered twenty results with no
  artwork. Release names carry noise no denylist will fully cover, so rather
  than grow the denylist forever, the resolver falls back to everything before
  the first token containing a digit, then the first three words, then two —
  stopping as soon as a candidate scores 55. Only failures pay for the extra
  catalog calls.
- **A failed metadata lookup is remembered for 3 minutes, not 30.** Negative
  answers are usually a rate limit or a blip; caching them as long as real ones
  turned a five-second outage into a page of grey boxes long after it passed.
- **A missing poster renders an initial, never an empty box.** An empty grey
  rectangle is pixel-identical to the loading skeleton, so a fully-loaded list
  of unmatched releases read as "still searching". Library cards, search rows
  and the recommendation rail all use the same initial tile, filling exactly
  the box a real poster would. Every one of them also falls back on `onError`,
  not just on a null URL — the library mixes TMDb and AniList CDNs.
- **The replaced-element reset in `globals.css` lives inside `@layer base`, and
  must stay there.** Tailwind v4 sorts *unlayered* CSS above every `@layer`, so
  while `img, video, svg { height: auto }` sat bare at the bottom of the file it
  beat `@layer utilities` — silently killing `h-full`/`inset-0` sizing on every
  `<img>` in the app. Posters laid out at their intrinsic ratio inside taller
  columns and left grey slabs beneath, and no Tailwind height utility could fix
  it. If images start mis-sizing app-wide, check this first.
- **A season marker with no episode number is a season pack.** `parseEpisode`
  reports `<Show> S04` and `<Show> Season 4` as `isSeasonPack`, because that is
  what every indexer calls a complete season. Treating them as ordinary
  episodes made the `Packs` filter hide real packs. Ambiguous shapes (absolute
  numbering, `Ep 1233 S23`) are matched by earlier branches, so reaching the
  bare-season branch really does mean "whole season".
- **Search results are grouped by *work*, never by a majority vote.** This
  entry used to describe the opposite — "at ≥60% of rows sharing a metadata
  title, artwork and name move to a single header" — and that rule is exactly
  the bug the user reported: a `dune` search collapsed five distinct works into
  one card headed "DUNE · 2017 · 127 releases", whose "S01" tab interleaved
  *Dune: Prophecy* with *Children of Dune*. Identity now comes from the release
  name (`src/lib/torrents/work-identity.ts`), which is self-describing;
  catalog metadata may only *refine* a group's label, never decide membership.
  See §2 and the module docstring for why.
- **Seasons are listed newest-first and capped at three releases each.** The
  reason to search a running show is almost always the newest season; ascending
  order buried it under the back catalogue. The rest of each season is one
  honest, counted click away.
- **The search skeleton deliberately draws no per-row poster.** Artwork appears
  on only one of the two result shapes, and a placeholder that vanishes on load
  is a reflow the user reads as the page changing its mind.
- **`.app-shell` *is* `body`.** Confusing, but true, and it matters when
  reasoning about scroll containers.
- **There is no auth and that is the design.** `src/lib/auth.ts` returns a
  constant local session. Every table still carries a `userId`, so real user
  management is a two-file change rather than a migration.

---

## 5. How to verify a change

Run the smallest thing that covers what you touched, then the gates.

```powershell
npx tsc --noEmit          # types
npm run lint              # eslint
npm run test:unit         # offline, no network
npm run build             # production build
```

**Playback changes require the real-media harnesses.** The unit tests are pure
and prove only the decision logic; every serious bug in this pipeline was found
by running actual ffmpeg. The first three generate their own media into
`os.tmpdir()` with the bundled ffmpeg and clean up after themselves — no
torrent, no network, no server needed. The last two are heavier: they run a
real BitTorrent swarm (and, for the UI one, a real dev server and Edge).

```powershell
npm run test:media          # the ladder: 9 cases, probe → decide → real session
npm run test:media:stall    # a source that stops sending without closing
npm run test:media:browser  # real Edge + hls.js actually decoding the output
npm run test:media:torrent  # the same ladder, but bytes pulled through WebTorrent
npm run test:media:ui       # the actual inline-player driven in Edge
```

`test:media:browser` also carries the **start-position** check: it takes a real
session's playlist, strips `#EXT-X-ENDLIST` to recreate the mid-mux state, and
compares hls.js defaults against the config the player ships. `test:media:ui`
covers what only a browser can: a real click on play, a scrubber drag past the
generated segments, an audio-track switch that must not silently downmix, and a
process-count sweep proving the session dies with the component.

**Data-panel changes require `npm run test:errors`.** It drives real Edge
against a running dev server, forces `/api/activity`, `/api/rules`,
`/api/history`, `/api/watchlist`, `/api/settings/client`,
`/api/client/torrents` and `/api/browse`
to return 500, and asserts the four things a unit test cannot
see: the error state renders, the *empty* state does **not** render alongside
it, the API's own message reaches the user, and the retry control genuinely
re-issues the request and recovers. This is the one regression that does not
look like a regression — the component "works" in both cases, and the only
symptom is the app confidently telling the user their data is empty when it
merely failed to load. Screenshots land in `qa-screens/error-states/`.

```powershell
npm run dev                 # must be running; the script defaults to :3100
npm run test:errors         # BASE_URL / SHOT_DIR override host and output
node scripts/qa-a11y.mjs    # keyboard/SR checks; same BASE_URL override
```

**Changes to the search cache or to browse availability require
`npm run test:seam`.** It is the only test that crosses the producer→consumer
boundary: it writes through the real `setSearchCache` using an option shape the
consumer cannot guess, then reads through the real `resolveAvailabilityBatch`.
Everything else in that area is a pure test over hand-built objects and will
stay green while the two halves have stopped speaking to each other — which is
precisely how `fetchable` and `unavailable` became unreachable states without a
single failing test or a single visibly broken page. It needs the dev database,
not a server, and cleans up the rows it writes.

```powershell
npm run test:seam
```

**Changes to browse rails require `npm run test:rails`.** It seeds a throwaway
user with the exact data shapes that make rail bugs appear — a catalog row whose
title is a *substring* of another work's name, a half-downloaded torrent, a
removed torrent, and progress for a torrent that no longer exists — then asserts
against the built payload. Both defects it guards rendered as a completely
normal-looking page: a card wearing another work's poster, and a Play button on
something that had been deleted. Neither is reachable from a unit test over
pure functions, and neither is visible in a screenshot unless you already know
which artwork is correct.

```powershell
npm run test:rails
```

**Layout changes require `node scripts/check-layout.mjs`.** Beyond horizontal
overflow and sticky-header behaviour it asserts, at 375px, that the document
reserves at least the fixed mobile tab bar's height below its last content.
Note *why* it is written that way: the obvious version of this check — "is any
interactive element currently sitting under the bar?" — is nearly useless,
because whether a control lands in the bar's band depends entirely on how tall
the seeded content happens to be. Deleting the reservation left that version
completely green. The reservation itself is the invariant, and it fails the
instant the padding goes.

```powershell
node scripts/check-layout.mjs   # PLAYWRIGHT_BASE_URL overrides the host
node scripts/shoot-dune.mjs     # multi-work grouping, in the rendered DOM
npm run test:browse             # the browse board, populated (BASE_URL)
npm run test:watchlist          # the library, populated (BASE_URL)
```

**Changes to the browse board require `npm run test:browse`.** It seeds a
library into the local user, photographs `/` at 1440 and 390, asserts the rails
rendered with tiles in them, that a populated board does not *also* render the
empty state, that no card prints its title twice, and that no heading glues a
count onto its label — then deletes exactly the rows it added (scoped to the
hashes it seeded; never a blanket delete by `userId`, because `local` is the
real user).

> **Why this script had to exist.** Nothing else seeded the local user, so every
> screenshot ever taken of `/` was of the *empty* board. The product's actual
> home page — hero, rails, cards — had never once been looked at. The first time
> it was rendered with data it showed two obvious defects that had survived the
> entire test suite, a code review and eighteen screenshots. An empty screen is
> not a cheap version of a full one; it is a different screen, and a suite that
> only ever sees the empty state is blind to the product. If you add a view that
> renders from data, seed it and *look at it* before believing it works.

`npm run test:watchlist` is the same idea applied to `/watchlist`, the last
high-traffic page whose populated state nothing rendered. Beyond the obvious
"the rows appear" checks it clicks a status filter, because the rows there are
server-owned but locally editable and are therefore synced into component state
*during render*. That sync is easy to break in a way no failure test would
catch — the page would load, show nothing, and look convincingly empty — so the
filter assertions exist to prove the sync produced live state the page can still
operate on rather than a frozen snapshot.

> **Kill the old server by PID before starting a new one.** `next start` exits
> immediately on `EADDRINUSE`, and if a previous server is still holding the
> port it keeps serving the *previous* build. After a `rm -rf .next` that old
> HTML references a CSS chunk that no longer exists, so every page loads
> completely unstyled — and the symptoms read exactly like real product bugs:
> `.app-header` computes to `position: static`, and the `md:hidden` mobile bar
> renders at 1440px. This cost a long detour chasing a header-stickiness
> "regression" that did not exist. `Get-NetTCPConnection -LocalPort <p> -State
> Listen` gives the owning PID; check the served HTML's CSS href against
> `.next/static/chunks/*.css` when anything looks unstyled. (Next 16 emits CSS
> under `static/chunks/`, not `static/css/`.)

> **The base-URL env var is not the same in every script**, and every one of
> them falls back to a *different* default port, so pointing the wrong variable
> at your server produces a wall of confident failures that look like real
> regressions (6/6 error-state failures, 8 a11y findings, 21 layout failures —
> all of them just "connection refused" against the default). The mapping is:
> `BASE_URL` for `qa-error-states`, `qa-a11y`, `shoot-dune`, `shoot-first-run`
> and `shoot-routes`; `PLAYWRIGHT_BASE_URL` for `check-layout`; `TF_BASE_URL`
> (or argv[1]) for `api-smoke`; `BASE` for
> `test-all`. If a gate fails, read the first line of the error for a *port* you
> did not start before believing the failure.
>
> `scripts/test-all.mjs` now pins all three variables to `BASE` when it shells
> out, so a full regression only needs `BASE` set.

- `media-ladder-e2e.mts` — generates the codec matrix, serves it over HTTP
  (with a `?slow=1` trickle mode), drives the real `probe`/`decide`/`session`
  path, then **re-probes the produced `init.mp4`+segment** to assert the output
  codecs and channel counts. Also covers seek-at-offset and the stale-session
  sweep. Report includes time-to-first-segment.
- `media-browser-playback.mts` — Playwright `msedge`, real hls.js. Asserts
  `currentTime` advances and reports the codec strings hls.js handed to
  `addSourceBuffer()` (from `BUFFER_CODECS`), which is the only honest
  browser-side signal — no web API exposes the decoder's channel count.
- `media-torrent-e2e.mts` — the only test where a real user's bytes flow.
  `scripts/lib/local-swarm.mts` runs a `bittorrent-tracker` server and a
  WebTorrent seeder on loopback; the magnet deliberately carries only a local
  `tr=`, and the engine treats an all-local announce list (`127.0.0.1`,
  `localhost`, `::1`, or RFC1918 IPv4) as a private swarm that must not gain
  public trackers. That explicit rule is what guarantees the test never touches
  the internet. It mounts the real
  `handleStreamFileRequest` (injecting only `getConfig`) so `file.stream()`,
  the stall guard and the range semantics are all the production ones. This is
  the harness that found the 8 MiB truncation bug above.
- `media-player-ui.mts` — drives the *component*, not the endpoints: click play,
  drag the scrubber past what has been generated, switch audio track, and assert
  the channel count of the session the player is **currently** pulling from
  (matched by the sessionId in its HLS requests — "newest directory on disk"
  lies, because a still-running earlier session keeps touching its own). Also
  screenshots 1440/390 into `qa-screens/player/`.
- Test clips must be **≥ 120 s** for anything that needs a *live* session:
  with `-hls_time 4` the first segment only lands once 4 s of media is muxed,
  and a short clip finishes before there is anything to observe.

**UI changes additionally require the two probes**, against a *running* server.
Static gates pass while real visual bugs ship; these measure the properties
that were actually broken:

```powershell
npm run start                                            # in another shell
node scripts/check-layout.mjs   --base http://127.0.0.1:3000
node scripts/check-ui-fixes.mjs --base http://127.0.0.1:3000
```

- `check-layout.mjs` — sticky positioning and horizontal overflow, 7 routes ×
  3 widths. It ignores content an ancestor deliberately clips (a Radix progress
  bar legitimately has a negative x).
- `check-ui-fixes.mjs` — contrast sweep on real rendered text for every route
  (WCAG AA, with the large-text threshold), the quality control, and the mobile
  sheet's scroll lock and focus trap.

Neither replaces **looking**. The `visual-qc` agent drives the running app with
Playwright and reads screenshots; it has repeatedly found real defects that all
four static gates passed.

### Test conventions

- `scripts/run-unit-tests.mjs` auto-discovers `src/**/*.test.ts` and reports
  every suite, so one failure does not hide the rest. Indexer-backed tests are
  excluded — they fail on networks that block those hosts, which says nothing
  about the code.
- Tests are hand-rolled: a `check(name, fn)` helper, `node:assert/strict`, and
  a `failures` counter. No test framework.
- Encode the **rule class**, not the reported example. Table-driven cases over
  many shows and title formats. See `AGENTS.md`.
- Assert on a dedicated `data-*` attribute, not a generic tag. A Playwright
  assertion on `h3` once matched card titles instead of section headers and
  produced a false pass.
- **Prove every new assertion goes RED before you trust it.** Break the code on
  purpose, watch the test fail, restore. Three suites in this repo were found
  vacuous this way — including a gate whose own first version printed a
  confident `PASS` over three real live defects.
- **A sabotage edit and its restore belong in the same batch of work.** Never
  leave one in the tree while you go and read files, think, or run something
  else. Three parallel agents were each caught mid-verification with a break
  still live: catalog titles left as raw scene filenames (which silently took
  poster coverage to 0/72), `availability: "unavailable"` hard-coded onto rows
  nobody had checked, and the opaque search-cache key rebuilt by hand. In all
  three cases the suite was green, `tsc` passed, and the page rendered.
  `npm run check:sabotage` (`scripts/check-no-sabotage.mjs`) now scans every
  tracked *and untracked* source file for the announced-break comment and fails
  the run; it is the first gate in `scripts/test-all.mjs` because a break in the
  tree makes every result after it a lie.

### Gates that check the product, not the code

Most of this repo's suites check that the code is correct. These two check what
the user actually sees, and both exist because a fully green suite shipped a
front page the owner rejected outright:

- **`npm run test:catalog`** (`scripts/check-catalog-quality.mts`) — hits the
  live `/api/browse` and fails when a card caption is shaped like a scene
  release name (`Severance S02E05 2160p ATVP WEB-DL DDP5.1 Atmos HDR H.265-FLUX`
  is a filename, not a title), when a discovery rail's poster coverage falls
  under 60%, when a rail is titled with placeholder copy, or when a rail renders
  empty. It also fails if no discovery rail exists at all, so it can never pass
  vacuously against an empty catalog.
- **`npm run test:images`** (`scripts/check-image-hosts.mts`) — proves every
  artwork host survives `next/image` by asking the running server's
  `/_next/image` rather than reimplementing Next's matcher. Add a sample here
  whenever a provider host is added; a host in `poster.ts`'s
  `OPTIMIZED_IMAGE_HOSTS` but missing from `next.config.ts` returns 400 and the
  card renders blank.

---

## 6. Local environment gotchas

- **npm must use the private Azure Artifacts feed** pinned in `.npmrc`. Never
  the public registry.
- **`prisma migrate dev` does not work here.** Write the migration SQL by hand:
  create `prisma/migrations/<timestamp>_<name>/` (the directory must exist
  first), write `migration.sql`, then `npx prisma migrate deploy` and
  `npx prisma generate`.
- `path-organization.test.ts` occasionally crashes at *process exit* with a
  libuv `UV_HANDLE_CLOSING` assertion. Pre-existing, unrelated to its
  assertions, and it passes.
- The dev server binds `127.0.0.1`. `Get-NetTCPConnection -LocalPort 3000
  -State Listen` finds the PID to stop.
- **PowerShell treats `[sessionId]` as a glob.** Any command touching an App
  Router bracket directory needs `-LiteralPath`.
- **A Windows absolute path is not a valid ESM specifier** — `D:` parses as a
  URL scheme. Use `pathToFileURL()` when importing a computed path.
- **`.cmd` shims cannot be `spawn`'d without `shell: true`**, and `shell: true`
  means you can no longer kill just the child. Use `node --import tsx <file>`
  when a test needs to kill the process it started.
- **ffmpeg dies with a SIGKILLed parent on this machine** (broken stderr pipe),
  so the classic Windows orphan does not reproduce here. That does not mean the
  sweep is unnecessary — a crash mid-write still leaves the session dir, and the
  sweep's kill path is verified separately against a deliberately detached
  `-re` ffmpeg.
- **ffprobe is 4.0.2 while ffmpeg is 6.1.1.** Do not assume the newer flags or
  JSON fields exist. Verified real values: `hevc` (not h265), `eac3` (not
  `e-ac-3`), `dts` with profile `"DTS"`, `mpeg2video`, `Main 10`, `yuv420p10le`.
- **A dev server must be started as `next dev -H 127.0.0.1`** (what `npm run
  dev` does). With the default bind, the dev HMR client cannot complete its
  websocket handshake against `127.0.0.1`, and a page whose HMR client never
  connects **never finishes hydrating** — it sits on its server-rendered
  skeleton ("Loading client…") forever, with no page error to explain it.
- **Next 16 refuses a second `next dev` in the same directory.** A harness that
  needs a server should probe for one first and reuse it; `media-player-ui.mts`
  additionally parses the `Local: http://…:PORT` line Next prints when it
  objects, and reuses that server instead. If the running server is *wedged*
  (accepts the TCP connection but never answers) there is no way to get a
  second one out of the same tree. The escape hatch that works: copy the repo
  to a sibling directory and run the harness there. It must be a **real copy of
  `node_modules`** — Turbopack rejects a junction with `Symlink
  [project]/node_modules is invalid, it points out of the filesystem root`
  (`robocopy /MT:32` does the 1.2 GB in ~12 s).
- **`require` does not exist in a `.mts` ESM harness** — but it is inside a
  `try`, so a `countProcesses()`-style helper silently returns 0 forever rather
  than throwing. Use `createRequire(import.meta.url)` or a real import.
- **tsx compiles inner named helpers with esbuild's `__name` wrapper**, which is
  not defined inside the browser page, so `page.evaluate(() => { const f = … })`
  fails with `ReferenceError: __name is not defined`. Pass the body as a source
  string instead.
- **ffmpeg runs faster than real time**, so a process-count check on a short
  clip can sample zero and prove nothing. Sample a *peak* on an interval and
  assert against it, or force `-re`.

---

## 7. Where the deeper docs are

| Document | Covers |
|----------|--------|
| `docs/architecture/release-ranking.md` | The full ranking design: affinity curve, seeder gate, junk sources, relevance keys |
| `docs/architecture/download-engine.md` | Pluggable engine design (builtin → external → future sidecar) |
| `docs/architecture/automation-scheduling.md` | The background timer, and why every guard exists |
| `docs/ui.md` | Design tokens and layout rules |
| `AGENTS.md` | Behavioural contract: generalise from examples, never example-patch |

---

## 8. Open work

Tracked here because it is real, not because it is planned:

- **`scripts/playwright-e2e.mjs` has been deleted, and `npm test` works again.**
  It imported `next-auth/jwt` to mint a session cookie, but this app has no
  OAuth at all — `src/lib/auth.ts` returns a fixed single-user session and
  `next-auth` is not an installed dependency, so it died at import with
  `ERR_MODULE_NOT_FOUND` and took `npm test` down with it. It was beyond simple
  repair: it also asserted `401` from routes that now answer directly, and one
  branch referenced an undefined `j`, which proves it had not run since the auth
  removal. `npm test` is now `node scripts/test-all.mjs`, and `test-all` grew
  the browse/discovery gates (`availability-seam`, `browse-rails`,
  `error-states`, `a11y`, `layout`, `browse-screens`, `watchlist-screens`) that
  previously only ever ran by hand.

- **Prefer complete season packs** in automation instead of one episode at a
  time (requested; needs a cursor-jump story and a size guard against a
  500 GB One Piece pack eating the whole 100 GB cap).
- **Series-completion detection** — stop hunting a series that has ended
  instead of burning three misses per run forever.
- **One duplicate left on disk from before the dedupe fix**:
  `downloads/TV/The Bear/Season 03` holds `S03E02` both flattened and inside a
  `www.SceneTime.com …` folder. Deliberately not deleted — it is the user's
  data, and nothing in this app deletes downloaded files on its own. New
  duplicates are prevented (see §4).
- `/client` polls with `setInterval`; it should be a self-scheduling
  `setTimeout` gated on `document.visibilityState` so a hidden tab stops
  polling.
- `src/lib/download/path-organization.test.ts` has an intermittent libuv
  teardown assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`). It
  passes on re-run; the assertion fires after the test body, during cleanup.
- **Playback, still unverified** (honest list, in risk order): hardware AMF
  encoding (`h264_amf`/`hevc_amf` exist in the build but nothing selects them,
  so the transcode-full rung is software-only and untimed on a 4K source); the
  Windows orphan case where the *parent* is killed (ffmpeg dies with it on this
  machine, so it cannot be reproduced here); the `MediaProbe` DB cache path (the
  harnesses run with `userId` unset and never write it); and the 8 MiB
  open-ended range cap itself, which is now survived by reconnecting rather than
  removed — the extra request per 8 MiB has not been measured on a large file.
