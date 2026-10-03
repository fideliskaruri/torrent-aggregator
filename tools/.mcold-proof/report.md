# OPS-848: cold Metadata reads

## Outcome

**Improved, but the requested latency target is not fully met. Do not close OPS-848.**
Real HTTP responses: 30/30 status 200. Shape/full-content/stable-identity checks: 30/30.
No timeouts were raised, no new process cache/background service was added, and no empty/partial response counts as a passing proof.

## Three fresh runs per endpoint

| Endpoint | Before cold (s) | After cold (s) | Before warm (s) | After warm (s) |
|---|---|---|---|---|
| all | 16.362, 18.534, 15.798 | 2.375, 2.218, 2.102 | 0.125, 0.131, 0.123 | 0.199, 0.207, 0.160 |
| anime | 14.089, 13.503, 13.658 | 8.405, 6.414, 8.788 | 8.296, 8.687, 8.847 | 0.145, 0.164, 0.136 |
| films | 16.568, 16.505, 16.017 | 4.022, 3.593, 3.368 | 1.397, 1.556, 1.585 | 0.204, 0.200, 0.187 |
| series | 14.042, 14.512, 13.991 | 2.962, 2.831, 2.783 | 0.116, 0.103, 0.177 | 0.140, 0.134, 0.121 |
| extras | 5.768, 5.458, 5.951 | 2.837, 2.699, 2.884 | 0.254, 0.141, 0.226 | 0.122, 0.106, 0.206 |

Each endpoint/run starts a new process on 3962 with its own newly created empty data directory. No endpoint warms another endpoint's cache. Warm means its immediate second HTTP read. TMDB is configured only in the child environment. Scheduler disabled.

## Measured cause and owning-module repair

- The API calls Browse once. Metadata performed a catalog-wide verified-link scan, snapshot reads and a durable commit for each of up to 96 candidates in each rail, under one global semaphore. This serialized growing catalog work.
- Cold All made 157 TMDB calls in baseline run 1, including 66 recent-film details. Type views also overflowed the 64-pending admission limit; AniList waits reached about 9.7s and incomplete rails were fetched again on warm reads. HTTP flights already coalesced requests; no inline retry existed. Provider queue/network timings are in provider-timings.json.
- Native pools now use only card facts, compact labelled-name projections and bounded aliased AniList queries. A shared visible-card selector replenishes only actual shortages, up to the original five TMDB/two AniList page ceiling. Upstream replenishment is re-evaluated against downstream deduplication; canonical identities are assigned only to visible cards, in one listing commit. Existing canonical facts are never replaced by partial listings.
- Browse reads distinct cached release details in one request-local batch, without recent-film network-detail fanout. Unchecked evidence uses the existing 21-day rule; checked cached details use the existing release-window calculation. Extras still resolves checked title details. The old server's BrowseService likewise reads existing release signals rather than awaiting each film's enrichment.
- Browse did not use Fribb facts but started the full map download. Western resolution awaited that download, and loaded readers waited behind its network lock. Browse no longer invokes that unrelated job; western resolution does not wait for an anime map, and already-loaded readers bypass the refresh lock. Anime resolution/maintenance retain the map.
- Typed exact-name/year resolution can use one unambiguous preferred TMDB identity directly. Fuzzy, ambiguous or absent matches still use the unchanged unified search. Extras recommendations use the same bulk listing persistence.
- Provider deadlines/real 429 and Retry-After behavior remain unchanged. TMDB retains four concurrent calls without a second start budget. AniList overlaps four calls while retaining its 700ms start spacing and foreground reservation.

## Verification and limitations

- Build: isolated worktree, Release, zero warnings/errors. No unit tests. CatalogEndpoints.cs and all excluded modules remain untouched.
- Captures compared against backend/contract/shapes.json and declared web types. Checks also reject missing rails, fewer than 24 cards, duplicate work keys, unstable canonical IDs, and Rick and Morty Extras without all 11 S1 episodes and real recommendations.
- Discarded intermediate attempts are not evidence of success: oversized GraphQL batches returned no rails; later versions exposed real AniList 500s and downstream deduplication shortages. Those outcomes were explicitly rejected. One copied build output was corrupt; it was discarded and rebuilt directly before the final matrix.
- The copied-data/converted-catalog, keyless, authenticated requester, personal watch-seed and genre-grid matrices were not run. A provider outage can still produce a partial BrowseResult; the unchanged API's handling of that partial result was not repaired here because CatalogEndpoints.cs belongs to another lane.
- Native card projections intentionally do not fetch full synonym/season/airing enrichment. They remain unrefreshed partial identities; opening a title obtains the full facts.
- Any cold sample >=5s or warm sample >=300ms in the table is a remaining failure, not rounded down.

## Isolation and persistence

- Detached worktree created from rebuild (428cb48): branch rebuild was already owned by the main worktree.
- Final output built directly at D:\code\memtest\bin-mcold; only 3962 was used.
- Live 3930/PID 3188 and D:\code\memtest\stable were not accessed or changed.
- Only the seven owned Metadata files and this proof were copied back; tools/.gitignore was untouched.
- Every proof child is stopped by its recorded literal PID. Worktree, isolated outputs and created data directories are removed at handoff.
- Commit uses Refs: OPS-848, no Co-Authored-By. See the report's introducing commit for its SHA.

## 15-minute follow-up: persisted Fribb, cold catalog

**The remaining latency is not the Fribb download. OPS-848 remains blocked.**

Each run received only the persisted Fribb MetadataCache row from
`D:\code\memtest\rebuild-gatemeta\data\torrentflow.db`, opened read-only.
The fixture was otherwise initialized by a fresh API process. Verified counts:
MetadataCache 1 (Fribb), Work/WorkName/WorkLink/Season/Episode 0. There were
no AniList responses or Browse rails in the fixture. Each measurement used a
new database copy, new process, disabled scheduler and port 3962. No stable
directory was accessed. See `map-fixture.json` and `map-measure.py`.

| Run | Map-present cold anime (s) | Immediate warm (s) | Content |
|---|---:|---:|---|
| 1 | 7.413 | 0.173 | 11 rails, 264 unique cards |
| 2 | 8.962 | 0.172 | 11 rails, 264 unique cards |
| 3 | 8.036 | 0.160 | 11 rails, 264 unique cards |

All six responses passed the contract, full-rail and stable-ID checks.
All three cold traces contain **zero Fribb provider calls**. Browse does not
invoke Fribb after c2f577b, whether its persisted map exists or not.
Historical first-install traces measured Fribb network download at
1.369–1.780 seconds and total fetch/persistence at 1.596–2.650 seconds;
that cost is not on the current Browse path.

### Remaining cause and rejected repairs

The initial aliased AniList fanout has a four-call/700ms start gate, then a
whole-batch completion barrier before any rail mapping. Deduplication triggers
additional serial fetches for comedy, then slice-of-life. Actual queue/network
times and these rounds are retained in `map-provider-timings.json`.
The Fribb-only fixture does not change any of this work.

Experiments fetching both existing pages up front, smaller independent rail
queries, overlapping each rail's mapping with other HTTP calls, and increased
bounded concurrency produced two complete cold responses at 2.982 and 3.233
seconds. They did **not** produce three reliable passing runs. A third response
lost rails; the clean-build confirmation produced 5/10/2 rails, not the required
11, with cold times 10.546/2.680/1.678 seconds. Those are failures, not successes.
One experimental warm sample was 341ms, also a failure.

A direct provider response confirmed AniList currently advertises
`X-RateLimit-Limit: 30`, not the assumed 90 requests/minute
(`map-provider-limit.json`). Eleven physical queries per cold view are therefore
not a safe substitute for compact batching; three consecutive cold runs alone
exceed that minute allowance. Real provider cooldowns were retained, and a
60-second proof-only pause did not make the final experiment reliable.
The large multi-rail/two-page pilot also returned incomplete content.

**All experimental production changes were discarded.** This follow-up commits
only measurements, the reproducible fixture runner and this report. No timeout,
partial-success shortcut, prewarming or production throttling change is shipped.
The remaining repair needs rail-independent completion with bounded compact
batches that respect the real provider limit, then three complete cold/warm
confirmation runs. That is unproven within the 15-minute limit.

Builds of the isolated experiments had zero warnings/errors. No unit tests,
excluded-module edits, live-server changes or independent-agent messages were
made. Proof children were stopped by recorded literal PID; isolated worktree,
build output and created data directories were removed before handoff.
