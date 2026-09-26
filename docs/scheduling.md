# Upcoming and scheduling

The owner's **Upcoming** page (`/upcoming`, beside Downloads on desktop and in
mobile More) combines monitored release checks, expected episode air times, and
the built-in download queue. It refreshes every 30 seconds without replacing
existing rows with loading skeletons. Requesters cannot access its API.

`GET /api/timeline` is read-only and returns `entries` ordered by UTC `at`, then
queue position and stable ID. An entry includes `kind` (`check`, `airs`, `queued`),
title, episode, poster, optional lane/queue position, and `waitReason`
(`reason`, human `text`, optional `until` and `since`). Checks also expose
`nextCheckAt`. No filesystem paths, magnets, or file inventories are returned.
Unknown queue start times are null, not invented ETAs, and sort last in the API.
The page groups by the viewer's local Today / Tomorrow / Later; overdue checks
and queues without an estimate appear under Today.

The shared `WaitReasonService` keeps existing precedence: queued downloads wait
for download hours first, then higher-priority queued lanes, then a transfer
slot. Monitoring reports future air dates before seeder grace and future checks.
Seeder grace includes its start and timeout; a timeout is not a promised
download completion. Download windows use the **server's local timezone**;
opening times are converted to UTC with daylight-saving handling.

Only enabled monitoring produces scheduled check entries. Expected air times
come from the existing metadata lookup for the current episode cursor, not a
complete series calendar. Provider failures omit unavailable air entries and
set `airTimesUnavailable`; checks and queue rows remain available. Metadata
lookups have a bounded eight-second budget. Existing queue promotion, forced
downloads, lane ordering, and scheduler/backoff intervals are unchanged.
