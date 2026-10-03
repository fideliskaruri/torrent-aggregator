# TorrentFlow benchmark: baseline-rick-final

Server: `http://127.0.0.1:3931/`. Started: 20261003-0513. Wait: 120s. Search only: False.

Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first bytes with a peer; early samples are labelled. Pre-existing transfers are never deleted.

| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Rick and Morty | 2551 | 245 |  | 0/11 |  | 0 | 0/0 | blocked | not-needed |

## Rick and Morty

Identity: `rick-and-morty-2013` (tvmaze:216); query: `Rick and Morty S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
- Pre-existing downloads/targets overlap this scope. Refused to alter or remove them; use a clean sandbox copy for a full measurement.
