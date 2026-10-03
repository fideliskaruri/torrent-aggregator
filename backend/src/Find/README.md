# Find

`IFind` owns discovery, not swarm health or selection. Dependencies are Domain, Parser,
Sources and Metadata only. Store is accessed solely through the Domain `IStore` Find
capability; no Store assembly reference or EF/SQL escapes into Find.

## Queries and filtering

Metadata's first English name is searched first for every kind, including anime films.
If English is absent, the first provider name is used and `EnglishLabelMissing` is recorded.
Films use one broad English title per source; `TorrentFlow:Sources:<id>:RequiresYear`
adds the catalog year only for a source that needs it. Seasons use title and title/SNN.
Episodes use SNNENN and SNN (packs), plus a confirmed absolute anime number when mapped.
There are no per-episode gap fans. One original/romaji/native name and at most two
authoritative synonyms follow English, in metadata order. Each later source/name tier
requires no eligible candidate from the preceding tier.

`TorrentFlow:Find:OwnerRequestLimit` defaults to 12 physical HTTP requests per scope;
`BackgroundRequestLimit` defaults to 6 (valid range 1..64). The shared atomic budget is
checked before every HTTP send, including pagination, redirects and detail lookups.
Each tier's plan list is bounded too, balancing query forms with source breadth so a
mapped absolute query is not starved. Cached/unsupported plans do not spend the physical
budget or block later name tiers. This is not a process-wide owner rate limiter.

Only coordinator feedback proving Good/Weak **and all Plan gates** covers an item.
Listed seeds, Unknown verdicts and structurally matching packs do not constitute health.
The default diagnostic GET explicitly uses provisional stopping on a structural match
with trusted seeds >= 1. `exhaust=true` disables provisional stopping, but does not
disable the scope request cap or the bounded names list. Production requests keep
provisional mode off and consume the Check/Plan feedback callback stream.
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

Every available source answer is persisted as a thirty-minute SearchCache
row through the typed Find capability and an immutable transaction receipt. Lookups use
normalized query/source plus matching scope/revisions. Failed, skipped, timed-out and
truncated answers keep their incomplete status but are reused, not retried on every
read. Empty successful answers are cached too. Failed/time-out answers schedule at most
one background retry per window, after their initiating scope finishes. The retry
shares the background admission budget, respects Retry-After, uses the remaining
original scope HTTP budget, and durably marks its attempt before sending. Retry success
invalidates empty/diagnostic scope snapshots; already provisional-good snapshots stay
instant cache hits. It does not extend the original cache expiry.
Retry-After sleeps do not hold background admission. A zero-send scope-budget refusal
is not a shared source answer and is never persisted; owner joiners can try it with
their own remaining budget. Scope snapshots inherit source expiry and bypass admission
when replayed.
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

`python tools\bench\find-proof.py` captures the real hard-set responses twice, concurrent
identical requests and Phase 0 CSV under gitignored `tools\.find-proof\`. It does not
instantiate Find, replace providers, create downloads, or touch the stable installation.
Development startup with scheduler disabled leaves TMDB_API_KEY environment-only.
