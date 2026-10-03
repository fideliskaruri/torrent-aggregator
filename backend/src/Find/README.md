# Find

`IFind` owns discovery, not swarm health or selection. Dependencies are Domain, Parser,
Sources and Metadata only. Store is accessed solely through the Domain `IStore` Find
capability; no Store assembly reference or EF/SQL escapes into Find.

## Queries and filtering

Metadata's first English name is searched first for every kind, including anime films.
If English is absent, the first provider name is used and `EnglishLabelMissing` is recorded.
Film queries are title/year and broad title. Series share title/SNN and broad title;
single items and uncovered gaps add SNNENN and confirmed anime absolute numbers.
With a coordinator the gaps are its Good/Weak gated coverage; the feedback-free dev
discovery uses structural coverage only to avoid repeating a fanout per known episode.
Original/romaji/native names, then authoritative provider synonyms, are separate
fallback name phases in metadata order. Each name exhausts Core before Fallback.

Only coordinator feedback proving Good/Weak **and all Plan gates** covers an item.
Listed seeds, Unknown verdicts and structurally matching packs do not constitute health.
Without feedback (the diagnostic GET), every name/tier is exhausted; completion can be
much slower than first candidate, especially with translated provider synonyms.
An active Check may answer at a tier boundary for at most twenty seconds. Find never
attaches metadata wait handles: Check/Targets own the maximum-three Unknown wait policy.

Parser title identity must equal a normalized catalog name, not contain it. A
provider-delimited subtitle can supply a guarded short name (Frieren), while additions
such as The Scorpion King and spelling changes such as Frieden cannot match Scorpion
or Frieren. Accents, punctuation and Unicode separators normalize consistently.
Year tolerance is one year against catalog or requested episode-air years. Explicit
seasons, episode ranges and absolute ranges are independently checked against confirmed
Metadata numbering; wrong-season EZTV results retain `scope_mismatch`. Film/episode
kind mismatches and malformed hashes/names are rejected with source, query and reason.
Foreign/unsafe parser flags are preserved for Plan, including conflicting observations
of the same hash; unknown language is not refused here.

## Sharing, cache and cancellation

One normalized hash retains every source/query observation. Listed seeds are the
lowest known nonnegative observation, including zero; supplied scrape evidence overrides
them, including a zero scrape. There is no advertised-seeder health threshold.

`Lazy<Task>` source flights are registered before starting, replay the latest partial
batch to joiners, and exclude quality/audio/size/session/lane from their identity.
Keys include work/kind/year, season numbering version, query/name phase, selected source
set, source settings and explicit source/credential/parser revisions. Episode-specific
queries have distinct keys, while the broad season queries share across episode scopes.
Each waiter parses and filters against its own scope and policy stays with Plan.
Owner joiners promote queued global/site work using a flight token without new HTTP.
FIFO priority gates reserve scope capacity for owners: eight scopes total, at most two
background scopes. Sources additionally bounds background adapters to eight globally.
No per-minute owner rate budget exists.

Every successful complete source answer is persisted as a thirty-minute SearchCache
row through the typed Find capability and an immutable transaction receipt. Lookups use
normalized query/source plus matching scope/revisions. Failed, skipped, timed-out and
truncated answers are never cached as complete negatives. Empty successful answers are.
The memory LRU holds at most 200 work/season pools, not 200 individual adapter answers;
loading a persisted answer preserves its original expiry. Maintenance owns DB TTL
cleanup. Cache failures log a warning and cannot discard usable source results.
Release and source-observation facts (including partial replies) are committed through
that same typed capability before their batches are published, so downstream checked
knowledge and admissions can reference durable hashes. Existing hash-bound file metadata
is preserved. Observations upsert the Store's hash/source/query identity. Cached
observations retain their actual source start time, not the read time, and cannot
replace a newer source observation.

Feedback coverage and cancellation are per waiter. Early stop requires every requested
missing item, not the first episode of a season. Detaching one subscriber does not cancel
another's HTTP work; the flight CTS is cancelled only after the last subscriber leaves.
Early-stopped source results remain explicitly partial. `CandidateBatch.Complete` means
this caller's discovery is finished, not that all upstream sites returned completely.

## Development HTTP

Development-only, trusted loopback owner:

`GET /api/dev/find?workKey=tvmaze:44&season=1&lane=owner`

Use a saved work key or verified provider identity. Films omit season/episode; episode
scopes require confirmed mapping. JSON includes candidates, parses, all observations,
trusted seeds, requested-item coverage, rejections, query/source diagnostics, name/tier,
timings, and per-query cache/in-flight flags. `stream=true` emits flushed NDJSON snapshots.
No magnets, torrent URIs, credential references or engine handles are exposed.

The GET deliberately does **not** invent health; it returns Unknown discovery pools.
For coordinator protocol verification only, `stream=true&feedback=true` opens a feedback
session. A trusted loopback owner can POST a Domain `SearchFeedback` JSON body to
`/api/dev/find/{sessionId}/feedback`. Its coverage must come from Check/Plan in production;
synthetic feedback tests prove cancellation/coverage semantics, not real swarm health.
Completed or disconnected sessions are removed. Production exposes neither dev route.

`python tools\bench\find-proof.py` captures the real hard-set responses twice, concurrent
identical requests and Phase 0 CSV under gitignored `tools\.find-proof\`. It does not
instantiate Find, replace providers, create downloads, or touch the stable installation.
Development startup with scheduler disabled leaves TMDB_API_KEY environment-only.
