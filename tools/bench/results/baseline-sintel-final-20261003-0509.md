# TorrentFlow benchmark: baseline-sintel-final

Server: `http://127.0.0.1:3931/`. Started: 20261003-0509. Wait: 120s. Search only: False.

Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first bytes with a peer; early samples are labelled. Pre-existing transfers are never deleted.

| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Sintel | 471 | 85 | 3394 | 1/1 | 120.0 | 1 | 0/0 | accounted | verified |

## Sintel

Identity: `sintel-2010` (tmdb:45745); query: `Sintel`.
- `43f4001de4ab25d521c63684e2b69804193ed9d9` www.UIndex.org    -    Sintel.2010.1080p.WEB.H264-CLASSiCALHD: downloaded; listed seeds 29; connected peers 0 (peak 6); connected seeds unavailable; progress 100.00 %; first bytes 2372ms; at 120.0s. 
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
- Download response: Looking for Sintel.
- File lists and connected seed counts may be absent from the public API; blank means unavailable, never zero.
