# Automation (OPS-781, partial delivery)

Rules use the captured `/api/rules` GET/POST/PATCH/DELETE contract, including nullable
filters, default seed count, supported sources and partial edits. They persist as
AutoRule rows in the existing database. Run reports unavailable rather than claiming
a download happened.

`PUT /api/follows/{workKey}` takes `{ "enabled": true }`. Existing watchlist
`monitored` flags use the same Follow rows. `GET /api/follows` reads them.
The single nonoverlapping scheduler honors `TorrentFlow:Scheduler:Disabled` and
`TorrentFlow:Scheduler:IntervalMinutes` (default 15).
The default pass only reads Metadata and Library, enumerating confirmed aired,
unowned episodes with exact air dates. It never calls Find or Engine.
Hunter item `status` reports `queued`, `owned` or `existing` (with the Targets message).

## Integration blocker: OPS-786

Targets' public AcquireInput does not support Origin, background first attempts,
or complete rule constraints. Acquire currently hardcodes Owner and its worker
uses the Owner lane on every first attempt. This module deliberately does not
write Target rows or edit Targets internals. Follow candidates are reported as
blocked, not persisted targets. Rule acquisition, Follow target creation,
release-window retries, and actual target deduplication proof therefore remain
blocked on a public Targets automation acceptance operation.

HTTP proof is in `tools\.hunter-proof\`; run `tools\Test-HunterContract.ps1`
against the isolated development listener. Abbott Elementary produces 92 aired
unowned candidates on 2026-10-03; unfollow removes them from the next pass.
The unrelated Store health readiness count regression is tracked in OPS-788.
