# Scheduling

The shared `WaitReasonService` keeps existing precedence: queued downloads wait
for download hours first, then higher-priority queued lanes, then a transfer
slot. Monitoring reports future air dates before seeder grace and future checks.
Seeder grace includes its start and timeout; a timeout is not a promised
download completion. Download windows use the **server's local timezone**;
opening times are converted to UTC with daylight-saving handling.

Title payloads (`GET /api/title/{workKey}` and its `/progress` poll) use one
transfer shape for the title, each season and each episode: `status` (the
acquisition row's own `queued`, `downloading`, `downloaded` or `failed`),
`state`, `progress`, `infoHash`, `filePath`, `error`, `queuePosition` and
`waitReason`. `state` splits `queued` in two: `looking` means no release has
been found yet; `queued` means a release waits for a download slot, and only
then are `queuePosition` (1 is next) and `waitReason` (`queue-full`,
`lower-lane` or `outside-window`) set, read from the engine's own list so they
match the Downloads page. Episode cards show "Queued #3" and "Looking".
Requesters get only `state` on each episode (see `remote-access.md`).

Only enabled monitoring produces scheduled checks. Expected air times come from
the existing metadata lookup for the current episode cursor. Provider failures
omit unavailable air dates. Metadata lookups have a bounded eight-second budget.
Existing queue promotion, forced downloads, lane ordering, and scheduler/backoff
intervals are unchanged.
