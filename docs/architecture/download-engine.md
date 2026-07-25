# Download engine architecture (durable & scalable)

## Goal

**One app install:** TorrentFlow works out of the box with a **built-in** BitTorrent engine.

**Optional external clients:** users who connect qBittorrent or Transmission in Settings use *their* client instead. Built-in remains available if they switch back.

No multi-container requirement for the happy path.

## Principles

1. **Port over protocol** — UI/automation use `TorrentClientAdapter`; engines implement it.
2. **Process isolation (long-term)** — production BitTorrent I/O belongs in a sidecar; v1 may run in-process for simplicity.
3. **Durable state** — hashes, paths, and progress snapshots live in SQLite (`EngineTorrent` + download history).
4. **Smart paths** — all engines use the same category/show folder resolution (`resolveSmartSendTarget`).
5. **Graceful degrade** — external engines offline ≠ app crash; built-in never requires host:port.

## Engines

| Type | Transport | Notes |
|------|-----------|--------|
| `builtin` | WebTorrent (Node) | **Default.** No extra install; public magnets MVP |
| `qbittorrent` | HTTP WebAPI | Optional; mature UI/private trackers |
| `transmission` | RPC | Optional |

## Defaults (one-app)

- `ensureDefaultClientSettings(userId)` creates `ClientSettings` with `clientType: "builtin"` and `baseDownloadPath` from `DOWNLOAD_DIR` or `./downloads`.
- `getUserClientConfig` always attaches `userId` for EngineTorrent ownership.
- Settings UI lists **Built-in (default)** first; host/username/password fields appear only for external clients.
- Client page: “offline / unreachable” framing is **external-only**. Built-in failures show engine tips (disk, logs, `DOWNLOAD_DIR`).

## Topology

```
Next.js control plane → TorrentClientAdapter
  ├─ qbittorrent  → HTTP host (user-configured)
  ├─ transmission → RPC host (user-configured)
  └─ builtin      → WebTorrent singleton (globalThis)
                      ├─ disk: baseDownloadPath / Category / Show…
                      └─ SQLite: EngineTorrent (per userId + hash)
```

## Built-in engine behavior

| Op | Behavior |
|----|----------|
| add | Free-space check (~500MB min when `statfs` available); write to `savePath`; upsert `EngineTorrent` |
| list | Rehydrate magnets from DB on first use; filter by `userId`; soft progress persist |
| pause / resume | Live WebTorrent + status column |
| delete | Drop EngineTorrent row; destroy store only if no other user owns the hash |
| rehydrate | On first list/add per process: re-`add` magnets with status ≠ `removed` |

### Reported state

The `/client` page filters on qBittorrent's state vocabulary, and the qBittorrent
adapter passes its own strings straight through. So the builtin engine emits the
*same* names rather than a private set — the UI never has to know which engine it
is talking to:

| Emitted | Condition | Shown as |
|---------|-----------|----------|
| `pausedDL` / `pausedUP` | explicitly paused | Paused |
| `metaDL` | not ready, no pieces yet | Fetching metadata |
| `checkingDL` | not ready, pieces known — existing data is being hash-checked | Verifying |
| `stalledDL` | ready, incomplete, no download speed | Looking for peers |
| `downloading` | ready, incomplete, moving | Downloading |
| `uploading` / `stalledUP` | complete | Seeding / Seeding (idle) |

`t.ready` is false until WebTorrent has hash-checked whatever is already on disk,
and metadata always arrives before pieces, so `pieces.length` is what separates
`checkingDL` from `metaDL`. The `ready` read fails *open*: if the property ever
disappears upstream, torrents look active rather than permanently "Verifying".
Peer counts come from `numPeers` (builtin) and `num_seeds + num_leechs` (qB).

Completeness is decided by `progress`, **not** by `t.done` — see `isComplete()`.
WebTorrent latches per-file `done` (`_checkDone` returns early for any file
already marked done, `torrent.js:2028`) and never re-evaluates it, while
`_markUnverified` (`torrent.js:884`) clears bits later when a hash check fails.
The torrent-level flag therefore sticks at the optimistic high-water mark.
Observed live: three torrents advertising `done` at **47–52% progress**, drawn
as "Seeding", their files fully allocated on disk but only half hash-verifying.
Since the `downloaded` getter is now exact, progress is the honest signal.

### Download order

Pieces are requested **sequentially** (`ADD_OPTIONS.strategy`). This is already
WebTorrent's default in the pinned version, but it is set explicitly because a
default is not a decision and this one has moved between releases. The trade-off
is accepted knowingly: sequential is slightly slower than rarest-first and worse
for swarm health, but it means a partially-downloaded video is playable from the
start, which is what this app is for.

## Content layout (no junk nesting)

Smart path leaf is Sonarr-style:

```
{base}/{Category}/{Show}/Season {NN}/   ← season known
{base}/{Category}/{Show}/               ← absolute-ep / multi-season
```

| Engine | How files avoid `Season NN/<torrent-name>/video.mkv` |
|--------|------------------------------------------------------|
| **qBittorrent** | On add: `contentLayout=NoSubfolder` + `autoTMM=false` when `savepath` is set |
| **builtin (WebTorrent)** | `file.path` is rewritten at metadata time, before the chunk store exists — see below |
| **Transmission** | Uses `download-dir` only (no subfolder API); multi-file may still create a torrent-name dir depending on client version |

### How the builtin engine does it

WebTorrent has no `contentLayout` option, and `fs-chunk-store` writes to
`savePath + dirname(file.path)`, so a multi-file torrent always lands one level
too deep. `src/lib/clients/content-layout.ts` patches
`Torrent.prototype._processParsedTorrent` — the last point before the store is
built from `files`, and after `torrentFile` has been serialised, so **the info
hash is unaffected**.

Every rule about what a folder *means* lives in one place,
`content-layout-policy.ts`, and is shared verbatim by the path rewrite and the
on-disk repair. If the two disagreed by a single rule, a torrent would be added
expecting one layout while its own resume data sat in another, and every byte
would be fetched twice.

The rule is deliberately conservative, because "this folder is the only child"
is *not* evidence that it is redundant:

1. **The container root is dropped.** We chose the save path, so the folder
   named after the release adds nothing. This is the same job qBittorrent's
   `NoSubfolder` does, though not identical: qBittorrent drops the top folder
   unconditionally, while we keep it when the layout below it is meaningful
   (`Disc 1`, `VIDEO_TS`). Where the two differ, we are the conservative one.
2. **Standard media structures are never dropped, at any depth** — `VIDEO_TS`,
   `BDMV`, `AUDIO_TS`, `PS3_GAME` and friends. Players and consoles look these
   up by name, so dropping one breaks playback rather than moving files.
3. **Organisational folders are kept unless the destination already says the
   same thing.** `Season 02`, `Disc 1`, `CD2`, `Volume 03` are the only thing
   separating two sets of identically named files; dropping one silently
   merges them. `Season 01` inside `…/Season 01` is pure repetition and goes.
4. **Deeper folders are dropped only on proof of redundancy** — either they
   repeat a destination component, or they are the same release name wrapped
   twice, as EMBER-style packs ship:
   `Solo Leveling 1080p … EMBER/Solo Leveling S01 1080p … EMBER/`.

   "Same release" is an exact test, not a similarity score: the two names must
   agree on every token except season markers. A threshold cannot tell
   `… Dual Audio` from `… English Audio`, or `x264` from `x265`, and getting
   that wrong merges two different releases into one folder. A false negative
   only leaves a folder nested, so the asymmetry is intentional.
5. **Anything ambiguous is left alone.** Traversal segments, or a rewrite that
   would collide two files, cancels the whole thing.

Collisions are compared the way the *filesystem* sees them, not as strings:
`fs-chunk-store` strips reserved characters from every basename it writes (on
every platform), and Windows folds case and ignores trailing dots and spaces.
Two files that differ only in those respects are one file on disk.

The patch is skipped when `skipVerify` or `_preloadedStore` is set — those mean
the bytes already exist at the stated paths (seeding), where rewriting would
point the store at files that are not there.

### Who owns which file

Flattening several releases into one season folder points two chunk stores at
the same directory. Two episodes of the same show routinely ship
`Screens/screen0001.png` — same name, same length, different bytes — and "a
file of the same size is already there" is *not* evidence that it is ours.
Fixed-size RAR volumes, `.pad` files and zero-length placeholders collide the
same way, and the loser gets verified over by the winner's pieces.

So `layout-ownership.ts` writes it down: a JSON sidecar mapping each written
path to the info hash that claimed it. A path claimed by a *different* torrent
is never treated as resume data, whatever its size, and the rewrite is
cancelled so that torrent keeps its own release folder. An unclaimed path of
the right size is still accepted — that is a download from before the manifest
existed. The claim is dropped only when the files are actually deleted.

### Repairing what is already on disk

`content-layout-repair.ts` lifts folders that are already nested — from
torrents added before this existed, or wrapped twice — and runs **before** a
torrent is added, when nothing holds a file handle. It picks the folder by
exact name match against the torrent, because a season folder legitimately
holds one release folder per episode and each episode's torrent may only touch
its own.

A lift is **all-or-nothing**. It plans every move first and abandons the whole
operation on a symlink, a file where a directory should go, or a name that is
already taken — *even if the file there is the same size and the same at both
ends of a sample*. Sampling proves nothing about the middle of a 4 GB file, and
the only way to be wrong is to delete bytes that exist nowhere else. Nothing is
ever deleted to make room; the folder simply stays nested, which costs a level
of nesting and no data.

Moving what fits and stranding the rest would be worse still: it produces a
split-brain layout — half the files at the destination, half still nested —
which the planner then declines to flatten because of the very collision it can
see, and the partial download is orphaned.

Known limits, all of which cost an extra folder or a re-download rather than
data: an untracked file dropped into a release folder (`.DS_Store`, `Thumbs.db`)
can make the repair decline a lift the planner would have allowed; the
ownership manifest is append-mostly and only shrinks when files are deleted;
and Windows reserved device names (`CON`, `LPT1`) are not rejected, because
`fs-chunk-store` would fail the write first.

If the prototype patch cannot be applied (a webtorrent upgrade that moves
`lib/torrent.js`), the engine logs a warning and the repair covers it on the
next add or restart. It deliberately does **not** move files after `done`:
`done` means every piece verified, not that the store closed its handles — the
torrent keeps seeding from exactly those paths.

**Known limit:** only paths are recorded, not the rule version that produced
them. Changing these rules can orphan a partial download; the on-disk repair
re-flattens on the next add, which covers the realistic cases for a single-user
install.

`scripts/e2e-content-layout.mts` proves this end to end with real torrents:
it builds nested fixtures, seeds them from one WebTorrent client, downloads
them over a real socket into a second, and compares the resulting files on disk
byte for byte — including two releases whose identically sized files collide in
one season folder. Run it with `npm run test:torrent`.

## Scalability

1. **v1** — in-process WebTorrent singleton (`globalThis`), `serverExternalPackages: ["webtorrent"]`
2. **v2** — sidecar process over localhost HTTP (same adapter)
3. **v3** — multi-engine / multi-host

Never run torrent I/O on edge/serverless.

## Success (MVP)

- [x] Settings can select **Built-in**
- [x] Send magnet without qBit running (no ECONNREFUSED to :8080 when builtin selected)
- [x] Client page lists builtin torrents
- [x] Pause / resume / delete
- [x] Free-space guard + EngineTorrent durability + rehydrate
- [x] External clients still work when selected
- [x] Docker: single `torrentflow` service + `/downloads` volume

## Known limits (built-in)

- **Public magnets first** — private trackers / passkeys are better on qBittorrent or Transmission.
- **Peer connectivity** — in-process DHT/PEX; Docker may need UDP/TCP 6881 published for better swarming.
- **Not a full client UI** — no sequential download priority, RSS, or advanced ratio rules in v1.
- **Process restart** — live peers drop; magnets rehydrate from `EngineTorrent` (metadata wait may take time).
- **WebTorrent scope** — some hybrid/v2 torrents or uncommon extensions may fail; switch to external if needed.
- **Speed vs progress can disagree** — `downloadSpeed` counts bytes off the wire,
  while progress only counts pieces that pass hash verification. On a network
  where peers are throttled or unreachable you can see a non-zero speed next to
  a progress bar that does not move. This is WebTorrent's own accounting; the
  Client page reports both rather than smoothing one to match the other.

## Upstream workaround: the nulled-piece race

`src/lib/clients/webtorrent-piece-race.ts` patches two methods and four getters
on `Torrent.prototype` before the client is constructed. It exists because
WebTorrent nulls entries in `torrent.pieces[]` the moment a piece verifies, but
several of its own code paths keep dereferencing them:

| Site | Throws |
|------|--------|
| `lib/torrent.js:1941` `_request` → `piece.reserve()` | `reading 'reserve'` |
| `lib/torrent.js:1705` `_updateWire` → `pieces[i].missing` | `reading 'missing'` |
| `lib/torrent.js:227` `get downloaded` → `piece.length` | `reading 'length'` |

The third is read on the tracker announce interval via `getAnnounceOpts`
(`torrent.js:390`), and `progress`/`timeRemaining` delegate to it. All of these
fire from timers and wire callbacks, so defensive reads on our own request path
(`readProp` in `builtin-engine.ts`) cannot catch them — they surfaced as
`uncaughtException` several times a second and buried every real error.

The patch swallows **only** a `TypeError` whose message contains `of null` and
names one of `reserve`/`missing`/`length`/`reserveRemaining`; anything else
rethrows. It is idempotent and warns if WebTorrent's internals move. Revisit on
every `webtorrent` upgrade — `webtorrent-piece-race.test.ts` covers the contract
in both directions.

Two of the three sites are **not** swallowed, because swallowing them was worse
than the crash:

**`get downloaded` is replaced, not guarded.** Returning the last good value on
a throw sounds harmless until you notice the throw recurs on essentially every
read: `_markVerified` nulls the piece one line *before* it sets the bitfield
bit, so the window is hit constantly once a torrent starts verifying. The
number then never updates again. Measured on a real download: the app reported
**69.92% frozen for 60 seconds while the bitfield said 51.86%** — and reported
**0.0%** for a torrent that was actually 56% complete. A progress bar and ETA
that are confidently wrong are worse than ones that are missing, and this is
the real reason the builtin engine "looked slow". The getter now recomputes the
same sum while skipping nulled pieces, which is exact and cannot freeze.

**`_request` checks for the null piece instead of catching it.** The scheduler
walks every piece a peer advertises, and on a half-complete torrent about half
of those are verified and therefore nulled — so it threw **512,968 times in 70
seconds** (~7,300/s), each one paying V8 stack capture on the event loop that
also serves the UI. One property read before the call removed 99.9% of them
(513k → 552 over the same window). The `try/catch` stays as a backstop for the
piece being nulled *inside* the original call.

## Leaked pieces, and why torrents used to plateau near 50%

A null entry in `pieces[]` means one of two things, and the bitfield tells them
apart:

- **bit set** — verified and complete. Nothing to request.
- **bit unset** — the piece has *leaked* and the scheduler will skip it forever.

This is not a race. `_markVerified` (torrent.js:872-875) nulls the piece and
sets the bit on adjacent synchronous lines, so single-threaded JavaScript can
never observe the gap; every orphan found this way is genuinely stuck. Measured
on a fresh 276 MB torrent: **328 of 1055 pieces** leaked, and the download sat
at ~49.6% with 34 connected peers and **zero throughput**.

The repair is upstream's own `_markUnverified`, which reinstates a `Piece` of
the correct length and re-selects the range. With it, the same torrent
went to **1055/1055 pieces (100%) in 21 seconds at 42 MB/s**, repairing 939
pieces on the way. If the method is ever renamed the guard falls back to
skipping, which is the previous behaviour.

Verified against **vanilla WebTorrent with none of this code**: the identical
~49.6% plateau appears (523/1055), plus the `Cannot read properties of null
(reading 'missing')` crash. The plateau is an upstream defect, not a
regression, and this patch is a strict improvement on it.

Known remaining limit: after a torrent reaches 100%, its bitfield can still
wobble back down while the file on disk stays complete. That also reproduces in
vanilla and is not addressed here — `scripts/probe-downloaded-getter.mts`
(`--vanilla` to compare) is the harness for re-measuring it.

## Why the builtin engine was slow: µTP

See `BUILTIN_CLIENT_OPTIONS` in `builtin-engine.ts`. WebTorrent defaults µTP on,
and µTP *replaces* TCP as the first choice for every IPv4 peer rather than
supplementing it. When `utp-native` cannot connect — routine on Windows — TCP is
not tried until a ~41s retry ladder has run out, per peer. Measured on one
torrent, same swarm, same machine:

| µTP | result after 40s |
|-----|------------------|
| on (WebTorrent default) | **0.00%** |
| off | **23.2% within 10s** |

Peak observed with it off: **35 MB/s**. `scripts/probe-engine-speed.mts` is the
harness; it prints reported progress next to a bitfield-derived ground truth so
a frozen or lying getter is immediately visible.

`torrentPort` is deliberately *not* pinned (no measured effect, and it would
collide with a qBittorrent install on the same machine) and `maxConns` stays at
WebTorrent's 55 (no observed swarm came close to saturating it).

## Upstream workaround: the second peer-socket error

A socket is an EventEmitter, so an `error` event with no listener is rethrown by
Node as an `uncaughtException`. WebTorrent registers its handler with `once`:

```js
lib/torrent.js:2134   conn.once('error', err => { …; peer.destroy(err) })
```

which hears the first error and nothing after it. utp-native routinely emits a
second — the peer resets while the teardown from the first is still in flight —
and that one escapes as `⨯ uncaughtException: Error: UTP_ECONNRESET`. Incoming
connections are worse: `lib/conn-pool.js:_onConnection` attaches no lasting
`error` listener at all outside its early-return path.

`src/lib/clients/webtorrent-conn-errors.ts` wraps `Torrent.prototype._drain`
(reading the peer off `_queue` before the call, then guarding the `conn` it
assigns) and `ConnPool.prototype._onConnection` (guarding before the original
runs, which can destroy the socket synchronously). A peer connection failing is
not an application error — WebTorrent already retries with backoff — so the
guard just counts it.

This does **not** replace WebTorrent's handling: EventEmitter runs every
listener, so its `once` still fires and still destroys the peer. The guard only
ensures the event is never *unhandled*. Nothing here touches the process level,
so a genuine bug anywhere else still crashes loudly.

`scripts/test-conn-errors.mts` runs in `test-all` and binds against the real
prototypes, so a `webtorrent` upgrade that moves either seam fails the gate
rather than silently resuming the crashes.
