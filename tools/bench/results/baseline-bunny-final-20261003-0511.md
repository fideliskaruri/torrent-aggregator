# TorrentFlow benchmark: baseline-bunny-final

Server: `http://127.0.0.1:3931/`. Started: 20261003-0511. Wait: 120s. Search only: False.

Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first bytes with a peer; early samples are labelled. Pre-existing transfers are never deleted.

| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Big Buck Bunny | 499 | 133 |  | 0/1 | 120.0 | 2 | 0/0 | stalled | verified |

## Big Buck Bunny

Identity: `big-buck-bunny-2008` (tmdb:10378); query: `Big Buck Bunny`.
- `2f24d03eab998ca672b8c1ef567a184609236c02` Big.Buck.Bunny.2008.x264.BDRip.1080p.mkv: error; listed seeds 1; connected peers 0 (peak 0); connected seeds unavailable; progress 0.00 %; first bytes not observedms; at 120.0s (replaced). Couldn't get this torrent's file list from peers. Check the magnet or try another release.
- `f84b51f0d2c3455ab5dabb6643b4340234cd036e` Big_Buck_Bunny_1080p_surround_frostclick.com_frostwire.com: stalledDL; listed seeds 1; connected peers 0 (peak 0); connected seeds unavailable; progress 0.00 %; first bytes not observedms; at 120.0s. 
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
- Download response: Looking for Big Buck Bunny.
- File lists and connected seed counts may be absent from the public API; blank means unavailable, never zero.
