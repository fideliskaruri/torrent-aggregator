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

## Content layout (no junk nesting)

Smart path leaf is Sonarr-style:

```
{base}/{Category}/{Show}/Season {NN}/   ← season known
{base}/{Category}/{Show}/               ← absolute-ep / multi-season
```

| Engine | How files avoid `Season NN/<torrent-name>/video.mkv` |
|--------|------------------------------------------------------|
| **qBittorrent** | On add: `contentLayout=NoSubfolder` + `autoTMM=false` when `savepath` is set |
| **builtin (WebTorrent)** | Single-file → directly under `savePath`. Multi-file often uses a release root; best-effort `flattenSingleReleaseRoot` after `done` when that root matches the torrent/scene name |
| **Transmission** | Uses `download-dir` only (no subfolder API); multi-file may still create a torrent-name dir depending on client version |

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
rethrows. Guarded getters return the previous good reading rather than zero, so
progress bars and the tracker's `left` value never rewind. It is idempotent and
warns if WebTorrent's internals move. Revisit on every `webtorrent` upgrade —
`webtorrent-piece-race.test.ts` covers the contract in both directions.
