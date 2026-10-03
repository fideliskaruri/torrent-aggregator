# TorrentFlow benchmark: baseline-identity-check

Server: `http://127.0.0.1:3931/`. Started: 20261003-0516. Wait: 120s. Search only: True.

Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first observed bytes; early samples are labelled. Pre-existing transfers are never deleted.

| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| A Silent Voice | 1715 | 241 |  | 0/1 |  | 0 | 0/0 | search-only | not-needed |

## A Silent Voice

Identity: `a-silent-voice-the-movie-2016` (anilist:20954); query: `A Silent Voice`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
