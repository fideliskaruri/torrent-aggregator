# Phase 4–6 dedicated QA walk (OPS-860)

Tested HEAD: `303c8676f7443022eca2f5b19d5eae73cb1da177`, detached isolated worktree `D:\code\memtest\wt-qag`.
Started 2026-10-04 00:18 +03. No application code fixed. Only this proof folder is committed.

## Outcome

**Contract gate FAIL: 80/86 routes pass the unchanged strict comparator, 6 fail; 105 samples.**
All four previously excluded route patterns were included and still return the host's missing-route 404. Existing OPS-799 received the evidence instead of a duplicate issue.
Two strict sample failures are over-narrow captured nullability, not demonstrated app defects: Activity `infoHash:null` and roots `lastError:null` are allowed by the consuming web types. Activity already passes through its other sample; reviewing the roots nullability raises the reviewed route count to 81/86. The remaining fifth failure is the open-folder response/status discrepancy (OPS-863).
The original library/delete capture used an absent historical ID. A second comparison using a real copied library item passes; both samples remain visible. The contract tool's route result is best-of-samples, not a claim that every sample succeeds.

**Browser:** 96 owner page/width/dataset checks (24 route variants × two widths × copied/empty), 36 focused Settings/season/preview checks, plus 24 lazy-artwork scroll checks and active/completed/removal captures. 179 screenshots retained.
Owner walks recorded no console errors, failed HTTP requests, document-width overflow, em dashes, or flagged internal pipeline jargon. The requester calendar preview alone produced a repeatable HTTP 403 at both widths. These automated checks do not establish contrast compliance or every possible flow.

**Gate spot checks:** Sintel finished with identical seed/final SHA-256, directly in `Movies\Sintel (2010)\Sintel.mp4`; no partial leftovers. The cap worked 2→1→2→1 within the one-second observations. UI Delete with files removed the final film and download row; only the root's operational `.torrentflow-root` marker remains. Completed-file Open actions fail (OPS-865/866).

## Isolation and setup

- A read-only SQLite backup of `D:\code\memtest\stable\data` and side-file copies were converted; all 76 media/supporting files were actual copies, path-mapped from the original media root to `D:\code\memtest\qag-data\media`.
- API/Converter builds were isolated in `bin-qag` / `bin-qag-convert`; the web was built in the detached worktree. Build evidence is retained. The existing dependency store was shared by a junction only; no dependency installation was necessary.
- Development, scheduler disabled, ports 3961 and 3962 only. TMDB credential supplied to child environment, never printed or persisted in proof.
- An initial contract invocation raced host startup; its samples were discarded and the entire run restarted after HTTP health readiness. No startup-race failures are counted. Cold-start latency is not claimed: browser/API work warmed metadata concurrently.
- The first 3962 Sintel gate ran before the empty page sweep. 3962 was then restarted with genuinely fresh `empty2` data for all empty-state captures. After those captures, the final Sintel proof used a distinct fresh root `qag-library-final`.
- Source `tools\.jelly-proof\Seed.ps1` was used, not the stale seeder binary. The cap test used two distinct torrent hashes with byte-identical licensed Sintel copies and a proof-only 256 KiB/s seeder, never real-title payloads.
- The cap was changed using the public PUT settings route; two physical Engine admissions were made through the development fixture endpoint. This proves Engine scheduling and settings propagation, not two end-user search/admission journeys.
- `PLAYWRIGHT_NO_REVEAL=1` was supplied for the second-run finished-file check. An early inherited open-folder contract fixture invoked the existing parent-folder fallback; subsequent targeted reproduction used `reveal:false` and no player was launched.
- No live port 3930 requests, changes, restarts, or stop operations. Live PID 3188 was only checked for continued existence during cleanup.
- Runtime process memory/start timestamps are in `runtime-memory.json`; cold startup time was not measured reliably and is not reported as passing.

## Bugs filed

- **OPS-861**: Canonical catalog keys lose converted episode ownership and offer Download again. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.
- **OPS-862**: Settings audio-language copy still promises removed English probing and waiting states. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.
- **OPS-863**: Open folder success claims nonexistent requested folder while opening its parent. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.
- **OPS-864**: View as requester calendar calls requester-only API with owner session and fails 403. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.
- **OPS-865**: Completed built-in download state complete hides Open and Show in folder actions. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.
- **OPS-866**: Open completed download rejects filed video because filing clears Selected flag. Exact repro, screenshot path, and module ownership are in Ops Tracker and `bugs-filed.json`.

## Per-route contract results

| Method | Route | Strict result | Samples | Failing evidence |
|---|---|---|---:|---|
| GET | /api/activity | PASS | 2 | 200 shape mismatch: $.items[].infoHash type changed: expected ['string'], actual null |
| GET | /api/activity/unread | PASS | 1 |  |
| POST | /api/artwork | PASS | 1 |  |
| POST | /api/automation/run | PASS | 1 |  |
| GET | /api/browse | PASS | 4 |  |
| GET | /api/client/torrents | PASS | 1 |  |
| POST | /api/client/torrents | PASS | 1 |  |
| POST | /api/client/torrents/tidy | PASS | 1 |  |
| GET | /api/client/torrents/{hash}/alternatives | FAIL | 1 | 404 404: $.alternatives missing; $.current missing; $.health missing; $.recommendedToken missing; $.sources missing |
| POST | /api/client/torrents/{hash}/alternatives | FAIL | 1 | 404 404: This API route does not exist. |
| GET | /api/desktop | PASS | 1 |  |
| PUT | /api/desktop/settings | PASS | 1 |  |
| POST | /api/desktop/update/check | PASS | 1 |  |
| POST | /api/desktop/update/install | PASS | 1 |  |
| POST | /api/downloads/{transferId}/find-another | FAIL | 1 | 404 404: This API route does not exist. |
| POST | /api/downloads/{transferId}/keep | PASS | 1 |  |
| POST | /api/downloads/{transferId}/open | PASS | 1 |  |
| GET | /api/features | PASS | 1 |  |
| GET | /api/library/delete | PASS | 4 | 404 404: $.ok missing; $.plan missing; $.title missing |
| POST | /api/library/delete | PASS | 1 |  |
| POST | /api/library/imports/scan | PASS | 1 |  |
| POST | /api/library/ondemand | PASS | 1 |  |
| GET | /api/library/roots | FAIL | 1 | 200 shape mismatch: $.roots[].lastError type changed: expected ['string'], actual null |
| GET | /api/me | PASS | 1 |  |
| GET | /api/notifications | PASS | 1 |  |
| GET | /api/notifications/push/public-key | PASS | 1 |  |
| DELETE | /api/notifications/push/subscription | PASS | 1 |  |
| POST | /api/notifications/push/subscription | PASS | 1 |  |
| POST | /api/notifications/read-all | PASS | 1 |  |
| POST | /api/notifications/read/{id} | PASS | 1 |  |
| GET | /api/recommendations | PASS | 1 |  |
| GET | /api/requester/calendar | PASS | 1 |  |
| GET | /api/requester/library | PASS | 1 |  |
| GET | /api/requester/requests | PASS | 1 |  |
| POST | /api/requester/requests | PASS | 1 |  |
| POST | /api/requester/requests/{id}/cancel | PASS | 1 |  |
| GET | /api/requester/seasons | PASS | 1 |  |
| GET | /api/requests | PASS | 1 |  |
| GET | /api/requests/auto-approve | PASS | 1 |  |
| PUT | /api/requests/auto-approve | PASS | 1 |  |
| POST | /api/requests/{id}/approve | PASS | 1 |  |
| POST | /api/requests/{id}/decline | PASS | 1 |  |
| POST | /api/requests/{id}/pick | PASS | 1 |  |
| POST | /api/requests/{id}/retry | PASS | 1 |  |
| DELETE | /api/rules | PASS | 1 |  |
| GET | /api/rules | PASS | 1 |  |
| PATCH | /api/rules | PASS | 1 |  |
| POST | /api/rules | PASS | 1 |  |
| POST | /api/rules/run | PASS | 1 |  |
| GET | /api/search/titles | PASS | 1 |  |
| GET | /api/settings/browse-folders | PASS | 1 |  |
| GET | /api/settings/client | PASS | 1 |  |
| PUT | /api/settings/client | PASS | 1 |  |
| GET | /api/settings/download-recovery | PASS | 1 |  |
| POST | /api/settings/download-recovery | PASS | 1 |  |
| GET | /api/settings/download-recovery/sources | PASS | 1 |  |
| POST | /api/settings/download-recovery/sources | PASS | 1 |  |
| POST | /api/settings/open-folder | FAIL | 1 | 200 status mismatch: $.error missing |
| GET | /api/settings/remote-access | PASS | 1 |  |
| PUT | /api/settings/remote-access | PASS | 1 |  |
| GET | /api/settings/remote-access/check | PASS | 1 |  |
| GET | /api/settings/sources | PASS | 1 |  |
| DELETE | /api/settings/sources/{id} | PASS | 1 |  |
| PUT | /api/settings/sources/{id} | PASS | 1 |  |
| POST | /api/settings/sources/{id}/test | PASS | 1 |  |
| DELETE | /api/settings/tmdb | PASS | 1 |  |
| GET | /api/settings/tmdb | PASS | 1 |  |
| PUT | /api/settings/tmdb | PASS | 1 |  |
| POST | /api/settings/tmdb/test | PASS | 1 |  |
| GET | /api/timeline | PASS | 1 |  |
| GET | /api/title/{workKey} | PASS | 4 |  |
| POST | /api/title/{workKey} | PASS | 1 |  |
| GET | /api/title/{workKey}/extras | PASS | 4 |  |
| GET | /api/title/{workKey}/links | PASS | 3 |  |
| DELETE | /api/title/{workKey}/links/{provider}/{externalId} | PASS | 1 |  |
| GET | /api/title/{workKey}/progress | PASS | 3 |  |
| GET | /api/title/{workKey}/releases | PASS | 3 |  |
| POST | /api/title/{workKey}/releases | PASS | 1 |  |
| POST | /api/torrent/send | FAIL | 1 | 404 404: $.ok missing |
| DELETE | /api/wanted | PASS | 1 |  |
| GET | /api/wanted | PASS | 1 |  |
| POST | /api/wanted/try | PASS | 1 |  |
| DELETE | /api/watchlist | PASS | 1 |  |
| GET | /api/watchlist | PASS | 1 |  |
| PATCH | /api/watchlist | PASS | 1 |  |
| POST | /api/watchlist | PASS | 1 |  |

Per-sample requests, expected/actual status, bodies, type changes, and allowed extra fields: `contract/raw.json`. The inherited comparison script is retained under `contract/measure.py`; it includes all 86 registered web routes and has no exclusions.

## Page coverage

| Page / variant | Copied 390 | Copied 1280 | Empty 390 | Empty 1280 | Finding |
|---|---|---|---|---|---|
| home | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| films | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| series | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| anime | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| films-comedy | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| series-drama | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| anime-action | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| search-results | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| search-none | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| film | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| series-title | Captured | Captured | Captured | Captured | Canonical copied ownership mismatch OPS-861; season 2 separately captured |
| anime-title | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| library | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| downloads | Captured | Captured | Captured | Captured | Active/completed additional proof; finished actions OPS-865/866 |
| upcoming | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| requests | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| notifications | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| everything | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| history | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| rules | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| settings | Captured | Captured | Captured | Captured | Audio policy copy OPS-862; five collapsed sections separately expanded |
| settings-library | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| about | Captured | Captured | Captured | Captured | No observed defect in scoped check |
| share | Captured | Captured | Captured | Captured | No observed defect in scoped check |

Browse type categories All/Films/Series/Anime and representative Comedy/Drama/Action genre filters were covered; this is not an all-genres content audit. Search includes populated and impossible-query empty results. Series season switching and episode rows were exercised. Settings covers default Downloads/quality/audio/download-app plus Advanced, Sources, Jellyfin, Remote access, App, and Drives/import.
Requester preview covers Browse, Search, film/series/anime titles, Library, Upcoming, Requests, Alerts, and Settings/Downloads guards at both widths. Preview was entered through the actual More/header button, not storage injection. Actual authenticated remote requester sessions were not exercised.
The legacy `/activity` and `/client` aliases redirect to Notifications and Downloads; their destination pages were covered. Share, About, Everything, History and Rules were also captured.
Full-page screenshots put fixed navigation in its actual captured viewport position. Long-page lazy images were explicitly loaded by scrolling in the supplementary walk; blank off-viewport placeholders in earlier captures were not filed as poster bugs.

## Download / library checks

| Check | Result | Evidence |
|---|---|---|
| Sintel full completion, bytes and SHA match unchanged seed | PASS | gate-completion.json, gate-final.log |
| Final Movies/Sintel (2010) folder; no partial leftovers | PASS | gate-completion.json |
| Active and completed Downloads at both widths | Captured; completed actions FAIL | active-download-*.png, completed-download-*.png |
| New owned Sintel no longer offers Download | PASS | owned-film-*.json and screenshots |
| Existing converted owned Rick episodes through canonical ID | FAIL OPS-861 | rick-canonical.json vs rick-rick-and-morty-2013.json |
| Lower cap from 2 to 1 | PASS: one active/Run, other Queued/Stopped | cap.json |
| Raise cap from 1 to 2 | PASS: both active/Run/Downloading | cap.json |
| Lower cap a second time | PASS | cap.json |
| Remove two partial cap downloads | PASS: physical rows and files empty | cap-leftovers.json, cap.json |
| UI Delete with files on completed Sintel | PASS: torrent list empty; film gone | removal-ui-result.json, removed-download-390.png |
| Open completed Sintel | FAIL 409 no-video, OPS-866 | completed-open-http.json, completed-bindings.json |
| Show/Open finished controls | FAIL OPS-865 | completed-menu.json and screenshots |
| Big Buck Bunny, forced-stall swap, actual Jellyfin scan | NOT EXERCISED | Beyond requested spot checks / no permitted Jellyfin server |

These spot checks do not claim that all Phase 4 or Phase 5 gates pass. No real-title downloads were started.

## Cleanup

See `cleanup.json`: dedicated API/seeder processes stopped by recorded literal PIDs; copied media/data/fixtures, build outputs and detached worktree removed. Live PID 3188 remains alive. Only `tools\.qag-proof\` was staged; the evidence commit uses `Refs: OPS-860` and no Co-Authored-By.
