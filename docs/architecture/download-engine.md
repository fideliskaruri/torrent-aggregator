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
