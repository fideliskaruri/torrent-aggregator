# TorrentFlow benchmark: baseline-search-final

Server: `http://127.0.0.1:3931/`. Started: 20261003-0509. Wait: 120s. Search only: True.

Blank timings/counts mean unavailable or not reached, not zero. Peer counts are connected peers, not advertised seeds. Real titles stop at first bytes with a peer; early samples are labelled. Pre-existing transfers are never deleted.

| Title | First result ms | Pool | All targets ms | Accounted | Observed s | Releases | Duplicates hash/target | Status | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| Scorpion | 2153 | 196 |  | 0/22 |  | 0 | 0/0 | search-only | not-needed |
| Little Fires Everywhere | 1239 | 125 |  | 0/8 |  | 0 | 0/0 | search-only | not-needed |
| Frieren: Beyond Journey's End | 1492 | 253 |  | 0/28 |  | 0 | 0/0 | search-only | not-needed |
| A Silent Voice | 4742 | 241 |  | 0/1 |  | 0 | 0/0 | search-only | not-needed |
| Prison Break | 1376 | 183 |  | 0/22 |  | 0 | 0/0 | search-only | not-needed |
| Money Heist | 1276 | 168 |  | 0/15 |  | 0 | 0/0 | search-only | not-needed |
| Rick and Morty | 462 | 245 |  | 0/11 |  | 0 | 0/0 | search-only | not-needed |
| Sintel | 1213 | 85 |  | 0/1 |  | 0 | 0/0 | search-only | not-needed |
| Big Buck Bunny | 1187 | 133 |  | 0/1 |  | 0 | 0/0 | search-only | not-needed |

## Scorpion

Identity: `scorpion` (tvmaze:44); query: `Scorpion S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Little Fires Everywhere

Identity: `little-fires-everywhere` (tvmaze:35319); query: `Little Fires Everywhere S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Frieren: Beyond Journey's End

Identity: `frieren-beyond-journeys-end` (anilist:154587); query: `Frieren: Beyond Journey's End S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
- Catalog name: Frieren: Beyond Journey’s End; release query and Download title remain English: Frieren: Beyond Journey's End.

## A Silent Voice

Identity: `a-silent-voice-the-movie-2016` (anilist:20954); query: `A Silent Voice`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Prison Break

Identity: `prison-break-2005` (tvmaze:541); query: `Prison Break S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Money Heist

Identity: `la-casa-de-papel-2017` (tvmaze:27436); query: `Money Heist S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
- Catalog name: La Casa de Papel; release query and Download title remain English: Money Heist.

## Rick and Morty

Identity: `rick-and-morty-2013` (tvmaze:216); query: `Rick and Morty S01`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Sintel

Identity: `sintel-2010` (tmdb:45745); query: `Sintel`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.

## Big Buck Bunny

Identity: `big-buck-bunny-2008` (tmdb:10378); query: `Big Buck Bunny`.
- Search is an atomic JSON response; first-result latency is response completion, not an internal provider time. Search warms the cache before Download.
