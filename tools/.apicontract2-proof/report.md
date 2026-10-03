# API contract repair proof (OPS-799)

## Outcome

The gate still fails. All scoped adapter/fixture groups are verified, but cold
Metadata reads and four excluded Targets routes remain.

| Run | Passing routes | Failing routes | Samples |
|---|---:|---:|---:|
| Recorded contract2 baseline, ba32d83 | 56/83 | 27 | 101 |
| Same-lane pre-fix build, 4b7ec4e, corrected fixtures/types | 75/83 | 8 | 101 |
| Final fresh-data cold run, original inventory | **78/83** | **5** | 101 |
| Final cold run, including three newly captured routes | **81/86** | **5** | **104** |

Final samples: **94 pass, 5 missing-route 404, 5 transport timeouts**.
The recorded 56→78 improvement is not attributable solely to this commit:
intervening rebuild work and corrected fixtures account for much of it. Against
the corrected pre-fix run this lane gains four adapter routes and loses one
route-level Browse pass to a cold Metadata timeout, for net +3.

Route pass uses the original harness's best-of-samples definition. Consequently
the Extras route passes through Family Guy/Sintel while its Rick and Morty sample
still times out. This is not a claim that every title or cold read works.

## Per-group decisions and evidence

| Group / tracker | Result |
|---|---|
| Notifications / OPS-838 | Real bug: null posters were omitted; download-linked notices were never mapped to download artwork. Always include nullable `posterUrl`, reusing `DownloadsApi`'s transfer projection. Final isolated feed: 18/74 posters, including 12 download-linked posters; unresolved/deleted downloads correctly retain null. Status failures were fixtures: legacy read-all/unsubscribe and existing-ID read return **204**, absent-ID read **404**, not 200. No status semantics changed. |
| Downloads and releases / OPS-839 | Real missing client `host` added as the legacy built-in empty string. Null season/episode/poster are valid in `web/src/app/downloads/types.ts`; generator selected a homonymous narrower type. Quality null is valid in inherited `ReleaseCardData`; fix resolver inheritance, not quality values. Releases now project typed name-evidence language facts without inventing audio/subtitle tracks. Invalid protected token is **400**, expired valid choice remains **409**. Keep/open's original fake text ID correctly returned 400; corrected well-formed absent hash proves **404**. |
| Settings / OPS-840 | Real bug: missing-source test 404 had no error object; fixed. Sources PUT unknown non-Torznab **400**, DELETE unknown idempotently **200**, test unknown **404** match legacy handlers. TMDB empty/invalid-format key **400**, format-valid synthetic credential save **200**, live rejection test **200** with `ok:false` verified. Auto-approve accepts `{rules:[]}`; invalid top-level `mode` was a fixture. Disabled remote access must not claim its own server port: use unused 3980, not 3965/3966. Open-folder fixture now uses a nonexistent child of the configured copied root, not an unrelated/disallowed path. |
| Rules and links / OPS-841 | Fixture artefacts, no product changes: lowercase `movies` POST gives a real rule ID and PATCH **200**; uppercase `Movies` **400**, missing rule PATCH **404**. Link DELETE adapter already exists; absent link correctly **404**. Harness now names an explicitly absent link rather than pretending its synthetic work key is a successful removal. |
| Coverage and latency / OPS-842 | Add only three new captures and registry entries; existing capture schemas/web types unchanged. Empty owned-folder import scan **202** without confirm, roots **200**, requester calendar **403** owner-local. Registry validation succeeds: 96 total routes, 86 web, 66 captures/schemas. Requester calendar success is not proved by owner refusal. |

Additional **31/31 real HTTP positive/negative adapter checks** passed on the final
compiled code (`adapters.json`). Final release read returned 33 releases with typed
language objects and no invented audio-track claims (`final-release-shape.json`).
Build: **0 warnings, 0 errors** (`build.log`). No unit tests or web changes.

## Browse / Extras root cause

The fresh cold six-worker contract run hit the unchanged 45-second deadline on
all four Browse samples and Rick and Morty Extras. A later explicit 180-second
deadline measurement returned Browse **200 in 34.425s** and Rick and Morty Extras
**200 in 27.253s** (`latency.json`); the cold failures remain in the gate counts.

API Browse performs one `IMetadata.BrowseAsync` call, not a serial rail fanout.
The expensive work is inside `Metadata/Browse.cs`: per-type rail refresh fetches
multiple provider pages, enriches candidate home-release details, then persists
up to 96 candidates per rail in an awaited loop. Extras delegates to
`IMetadata.ExtrasAsync`; that service resolves the work, enriches release data,
awaits recommendations, then awaits TMDB details. The recommendations fallback
can call full Browse; recommendations also persist results serially. Provider
and SQLite work dominate these reads. **Metadata owns the latency repair**; no
API timeout increase, cache workaround, empty-success response, or Metadata edit
was introduced.

## Remaining ownership

- **Targets/Library**: GET/POST client alternatives, POST find-another, POST
  torrent/send remain missing. Five 404 samples represent four route patterns.
- **Metadata**: GET Browse fails the cold gate; one Extras sample times out even
  though that route passes best-of-samples.
- **Targets/Library** library/delete GET passed this build's samples; not changed
  or claimed as repaired by this lane. Any broader deletion gaps remain theirs.
- No edits to ImportEndpoints, Program, Targets, Library, Store or converter.

## Commits, isolation and cleanup

- API implementation: **4953c57**, `Repair notification artwork and release adapters`
  (Refs OPS-838, OPS-839, OPS-840, OPS-799).
- Contract/fixture evidence: `Capture missing web routes and correct contract fixtures`
  (Refs OPS-838 through OPS-842 and OPS-799; see this report's introducing commit).
- Detached worktree `D:\code\memtest\wt-apic2` was created at rebuild 4b7ec4e:
  Git rejected attaching branch rebuild because the main worktree already owns it.
- Built only there, output `D:\code\memtest\bin-apic2`; API proof used **3966 only**.
- Source SQLite opened read-only and copied with `sqlite3.Connection.backup`.
  Converter read the copy with an empty path-map; no live payload paths were mapped.
  Fresh converted data was used for the final full run; later branch checks used
  that same isolated data. No live server 3930/PID 3188 or live files were changed.
- TMDB credential existed only in child process environment, never printed or
  placed in source/proof request payloads. Credential tests used an explicit fake.
- Only four owned API files copied back. Foreign uncommitted changes, including
  `tools/.gitignore`, were untouched. Process cleanup uses literal recorded PIDs.
- Proof server, copied data, isolated build output and temporary worktree removed
  before handoff; compact before/after JSON and HTTP evidence remain here.

## Full per-sample cold-run evidence

Build: isolated wt-apic2. Port 3966.
Stable data copied with SQLite backup, converted from the copy. Scheduler disabled.
No original payload root was mapped: imported transfers are stopped and ownership is not inferred.
All mutating requests use Sintel or harmless/no-op/error-branch fixtures.
Extras are listed but allowed by the baseline README. Empty/unresolved shapes are explicitly unproven.
Owner-local requester refusal is checked; requester success requires a separate authenticated-role run.
Source-only mutations have no recorded old HTTP sample; expected status/schema uses the old handler branch.

Coverage: 86/86 web method/path routes; 104 samples.
Counts: {'pass': 94, '404': 5, 'transport failure': 5}

| Method | Route | Actual request / fixture | Expected / actual status | Result | Missing / type-changed | Extra fields | Unproven / notes |
|---|---|---|---|---|---|---|---|
| GET | /api/activity | /api/activity?limit=100 (captures\activity\all.json) | 200 / 200 | pass |  |  | $.items[].category declared state variant; $.items[].context declared state variant; $.items[].query declared state variant; $.items[].savePath declared state variant; $.items[].sendKind declared state variant; $.items[].source declared state variant |
| GET | /api/activity | /api/activity?filter=sent&limit=20 (captures\activity\sent.json) | 200 / 200 | pass |  |  | $.items[].context declared state variant; $.items[].sendKind declared state variant |
| GET | /api/activity/unread | /api/activity/unread (captures\activity\unread.json) | 200 / 200 | pass |  |  |  |
| POST | /api/artwork | /api/artwork (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| POST | /api/automation/run | /api/automation/run (harmless source-derived branch) | 200 / 200 | pass |  | $.offline extra (allowed by baseline); $.summary extra (allowed by baseline) |  |
| GET | /api/browse | /api/browse (captures\browse\all.json) | 200 / 0 | transport failure | $.generatedAt missing; $.genre missing; $.genres missing; $.rails missing; $.view missing | $.transportError extra (allowed by baseline) |  |
| GET | /api/browse | /api/browse?type=anime (captures\browse\anime.json) | 200 / 0 | transport failure | $.generatedAt missing; $.genre missing; $.genres missing; $.rails missing; $.view missing | $.transportError extra (allowed by baseline) |  |
| GET | /api/browse | /api/browse?type=films (captures\browse\films.json) | 200 / 0 | transport failure | $.generatedAt missing; $.genre missing; $.genres missing; $.rails missing; $.view missing | $.transportError extra (allowed by baseline) |  |
| GET | /api/browse | /api/browse?type=series (captures\browse\series.json) | 200 / 0 | transport failure | $.generatedAt missing; $.genre missing; $.genres missing; $.rails missing; $.view missing | $.transportError extra (allowed by baseline) |  |
| GET | /api/client/torrents | /api/client/torrents (captures\client\torrents.json) | 200 / 200 | pass |  | $.torrents[].packEpisodes extra (allowed by baseline); $.torrents[].waitReason extra (allowed by baseline); $.torrents[].waitingReason extra (allowed by baseline) | $.torrents[].episode declared state variant; $.torrents[].error declared state variant; $.torrents[].posterUrl declared state variant; $.torrents[].savePath declared state variant; $.torrents[].season declared state variant; $.torrents[].workId declared state variant; $.torrents[].workKey declared state variant; $.torrents[].workMediaType declared state variant; $.torrents[].workTitle declared state variant; $.torrents[].workYear declared state variant |
| POST | /api/client/torrents | /api/client/torrents (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| POST | /api/client/torrents/tidy | /api/client/torrents/tidy (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| GET | /api/client/torrents/{hash}/alternatives | /api/client/torrents/9c2b1060984884a46355f817ce621ca622d92ece/alternatives (captures\client\alternatives.json) | 200 / 404 | 404 | $.alternatives missing; $.current missing; $.health missing; $.recommendedToken missing; $.sources missing | $.error extra (allowed by baseline); $.message extra (allowed by baseline) |  |
| POST | /api/client/torrents/{hash}/alternatives | /api/client/torrents/0000000000000000000000000000000000000000/alternatives (harmless source-derived branch) | 404 / 404 | 404 |  |  |  |
| GET | /api/desktop | /api/desktop (captures\desktop\status.json) | 200 / 200 | pass |  |  |  |
| PUT | /api/desktop/settings | /api/desktop/settings (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| POST | /api/desktop/update/check | /api/desktop/update/check (harmless source-derived branch) | 409 / 409 | pass |  |  |  |
| POST | /api/desktop/update/install | /api/desktop/update/install (harmless source-derived branch) | 409 / 409 | pass |  |  |  |
| POST | /api/downloads/{transferId}/find-another | /api/downloads/builtin:0000000000000000000000000000000000000000/find-another (harmless source-derived branch) | 404 / 404 | 404 |  |  |  |
| POST | /api/downloads/{transferId}/keep | /api/downloads/builtin:0000000000000000000000000000000000000000/keep (harmless source-derived branch) | 404 / 404 | pass |  | $.reason extra (allowed by baseline) |  |
| POST | /api/downloads/{transferId}/open | /api/downloads/builtin:0000000000000000000000000000000000000000/open (harmless source-derived branch) | 404 / 404 | pass |  | $.reason extra (allowed by baseline) |  |
| GET | /api/features | /api/features (captures\features\default.json) | 200 / 200 | pass |  |  |  |
| GET | /api/library/delete | /api/library/delete?watchListItemId=cmurpw4f8busyf2ap08vz5313&scope=show (captures\library\family-guy-delete-plan.json) | 200 / 200 | pass |  |  |  |
| GET | /api/library/delete | /api/library/delete?watchListItemId=cmurnijn4burek4bdlif7w2jo&scope=show (captures\library\rick-and-morty-2013-delete-plan.json) | 200 / 200 | pass |  |  |  |
| GET | /api/library/delete | /api/library/delete?watchListItemId=cmurr0f2vgcdsu9p3vv2ylgn7&scope=show (captures\library\sintel-2010-delete-plan.json) | 200 / 404 | 404 | $.ok missing; $.plan missing; $.title missing | $.error extra (allowed by baseline) |  |
| POST | /api/library/delete | /api/library/delete (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| POST | /api/library/imports/scan | /api/library/imports/scan (harmless source-derived branch) | 202 / 202 | pass |  |  |  |
| POST | /api/library/ondemand | /api/library/ondemand (harmless source-derived branch) | 400 / 400 | pass |  | $.error extra (allowed by baseline); $.field extra (allowed by baseline) |  |
| GET | /api/library/roots | /api/library/roots (captures\library\roots.json) | 200 / 200 | pass |  |  |  |
| GET | /api/me | /api/me (captures\me\owner.json) | 200 / 200 | pass |  |  |  |
| GET | /api/notifications | /api/notifications (captures\notifications\inbox.json) | 200 / 200 | pass |  |  | $.items[].posterUrl declared state variant; $.items[].readAt declared state variant |
| GET | /api/notifications/push/public-key | /api/notifications/push/public-key (captures\notifications\push-key.json) | 200 / 200 | pass |  |  |  |
| DELETE | /api/notifications/push/subscription | /api/notifications/push/subscription (harmless source-derived branch) | 204 / 204 | pass |  |  | $ schema unproven |
| POST | /api/notifications/push/subscription | /api/notifications/push/subscription (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| POST | /api/notifications/read-all | /api/notifications/read-all (harmless source-derived branch) | 204 / 204 | pass |  |  | $ schema unproven |
| POST | /api/notifications/read/{id} | /api/notifications/read/contract-harmless-missing (harmless source-derived branch) | 404 / 404 | pass |  |  | $ schema unproven |
| GET | /api/recommendations | /api/recommendations (captures\recommendations\rail.json) | 200 / 200 | pass |  |  | $.rail.items[].format null-only baseline; non-null type unproven |
| GET | /api/requester/calendar | /api/requester/calendar (captures\requester\calendar-owner-denied.json) | 403 / 403 | pass |  |  |  |
| GET | /api/requester/library | /api/requester/library (captures\requester\library-owner-denied.json) | 403 / 403 | pass |  |  |  |
| GET | /api/requester/requests | /api/requester/requests (captures\requester\requests-owner-denied.json) | 403 / 403 | pass |  |  |  |
| POST | /api/requester/requests | /api/requester/requests (harmless source-derived branch) | 403 / 403 | pass |  | $.code extra (allowed by baseline) |  |
| POST | /api/requester/requests/{id}/cancel | /api/requester/requests/contract-harmless-missing/cancel (harmless source-derived branch) | 403 / 403 | pass |  | $.code extra (allowed by baseline) |  |
| GET | /api/requester/seasons | /api/requester/seasons?source=tmdb&sourceId=1399&mediaType=tv (captures\requester\seasons-owner-denied.json) | 403 / 403 | pass |  |  |  |
| GET | /api/requests | /api/requests (captures\requests\owner.json) | 200 / 200 | pass |  |  |  |
| GET | /api/requests/auto-approve | /api/requests/auto-approve (captures\requests\auto-approve.json) | 200 / 200 | pass |  |  |  |
| PUT | /api/requests/auto-approve | /api/requests/auto-approve (harmless source-derived branch) | 200 / 200 | pass |  |  | $.knownEmails empty; element shape unverified; $.rules empty; element shape unverified |
| POST | /api/requests/{id}/approve | /api/requests/contract-harmless-missing/approve (harmless source-derived branch) | 404 / 404 | pass |  | $.code extra (allowed by baseline) |  |
| POST | /api/requests/{id}/decline | /api/requests/contract-harmless-missing/decline (harmless source-derived branch) | 404 / 404 | pass |  | $.code extra (allowed by baseline) |  |
| POST | /api/requests/{id}/pick | /api/requests/contract-harmless-missing/pick (harmless source-derived branch) | 404 / 404 | pass |  | $.code extra (allowed by baseline) |  |
| POST | /api/requests/{id}/retry | /api/requests/contract-harmless-missing/retry (harmless source-derived branch) | 404 / 404 | pass |  | $.code extra (allowed by baseline) |  |
| DELETE | /api/rules | /api/rules?id=358df0b4f4264a01a60484de62b9cce9 (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| GET | /api/rules | /api/rules (captures\rules\all.json) | 200 / 200 | pass |  |  |  |
| PATCH | /api/rules | /api/rules (harmless source-derived branch) | 200 / 200 | pass |  | $.rule.createdAt extra (allowed by baseline); $.rule.lastMatchMagnet extra (allowed by baseline); $.rule.updatedAt extra (allowed by baseline); $.rule.userId extra (allowed by baseline); $.runResult extra (allowed by baseline) |  |
| POST | /api/rules | /api/rules (harmless source-derived branch) | 200 / 200 | pass |  | $.rule.createdAt extra (allowed by baseline); $.rule.lastMatchMagnet extra (allowed by baseline); $.rule.updatedAt extra (allowed by baseline); $.rule.userId extra (allowed by baseline); $.runResult extra (allowed by baseline) |  |
| POST | /api/rules/run | /api/rules/run (harmless source-derived branch) | 200 / 200 | pass |  | $.existing extra (allowed by baseline); $.offline extra (allowed by baseline); $.owned extra (allowed by baseline); $.summary extra (allowed by baseline) |  |
| GET | /api/search/titles | /api/search/titles?q=Sintel (captures\search\titles.json) | 200 / 200 | pass |  | $.results[].externalIds.cinemeta extra (allowed by baseline) | $.results[].releaseDate declared state variant |
| GET | /api/settings/browse-folders | /api/settings/browse-folders?path=D%3A%5Ccode%5Cmemtest%5Crebuild-baseline (captures\settings\folders.json) | 200 / 200 | pass |  |  |  |
| GET | /api/settings/client | /api/settings/client (captures\settings\client.json) | 200 / 200 | pass |  |  | $.settings.pathWarnings empty; element shape unverified; $.settings.storageUsage.items empty; element shape unverified |
| PUT | /api/settings/client | /api/settings/client (harmless source-derived branch) | 200 / 200 | pass |  | $.retentionWarning extra (allowed by baseline); $.testResult extra (allowed by baseline) | $.settings.downloadWindows empty; element shape unverified; $.settings.externalClientType schema unproven |
| GET | /api/settings/download-recovery | /api/settings/download-recovery (captures\settings\recovery.json) | 200 / 200 | pass |  |  |  |
| POST | /api/settings/download-recovery | /api/settings/download-recovery (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| GET | /api/settings/download-recovery/sources | /api/settings/download-recovery/sources (captures\settings\recovery-sources.json) | 200 / 200 | pass |  |  |  |
| POST | /api/settings/download-recovery/sources | /api/settings/download-recovery/sources (harmless source-derived branch) | 200 / 200 | pass |  | $.errors extra (allowed by baseline); $.failed extra (allowed by baseline); $.imported extra (allowed by baseline); $.paused extra (allowed by baseline); $.skipped extra (allowed by baseline) |  |
| POST | /api/settings/open-folder | /api/settings/open-folder (harmless source-derived branch) | 404 / 404 | pass |  | $.path extra (allowed by baseline); $.pathOnly extra (allowed by baseline) |  |
| GET | /api/settings/remote-access | /api/settings/remote-access (captures\settings\remote-access.json) | 200 / 200 | pass |  |  |  |
| PUT | /api/settings/remote-access | /api/settings/remote-access (harmless source-derived branch) | 200 / 200 | pass |  | $.ownerPorts extra (allowed by baseline) | $.ownerEmails empty; element shape unverified; $.warnings empty; element shape unverified |
| GET | /api/settings/remote-access/check | /api/settings/remote-access/check (captures\settings\remote-check.json) | 200 / 200 | pass |  |  |  |
| GET | /api/settings/sources | /api/settings/sources (captures\settings\sources.json) | 200 / 200 | pass |  |  | $.sources[].mirrors empty; element shape unverified |
| DELETE | /api/settings/sources/{id} | /api/settings/sources/contract-missing-source (harmless source-derived branch) | 200 / 200 | pass |  | $.sources[].options extra (allowed by baseline) | $.sources[].mirrors empty; element shape unverified |
| PUT | /api/settings/sources/{id} | /api/settings/sources/contract-missing-source (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| POST | /api/settings/sources/{id}/test | /api/settings/sources/contract-missing-source/test (harmless source-derived branch) | 404 / 404 | pass |  |  |  |
| DELETE | /api/settings/tmdb | /api/settings/tmdb (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| GET | /api/settings/tmdb | /api/settings/tmdb (captures\settings\tmdb.json) | 200 / 200 | pass |  |  |  |
| PUT | /api/settings/tmdb | /api/settings/tmdb (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| POST | /api/settings/tmdb/test | /api/settings/tmdb/test (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| GET | /api/timeline | /api/timeline (captures\timeline\all.json) | 200 / 200 | pass |  | $.entries[].followed extra (allowed by baseline); $.entries[].grabNow extra (allowed by baseline); $.entries[].mediaType extra (allowed by baseline); $.entries[].quality extra (allowed by baseline); $.entries[].release extra (allowed by baseline); $.entries[].state extra (allowed by baseline); $.entries[].targetId extra (allowed by baseline); $.entries[].workKey extra (allowed by baseline) |  |
| GET | /api/title/{workKey} | /api/title/family-guy?t=Family%20Guy&type=tv (captures\title\family-guy-detail.json) | 200 / 200 | pass |  |  | $.availability declared state variant; $.episodes[].availability declared state variant; $.episodes[].infoHash declared state variant; $.episodes[].transfer declared state variant; $.infoHash declared state variant |
| GET | /api/title/{workKey} | /api/title/rick-and-morty-2013?t=Rick%20and%20Morty&type=tv (captures\title\rick-and-morty-2013-detail.json) | 200 / 200 | pass |  |  | $.availability declared state variant; $.infoHash declared state variant; $.originalLanguage declared state variant |
| GET | /api/title/{workKey} | /api/title/sintel-2010?t=Sintel&type=movie (captures\title\sintel-2010-detail.json) | 200 / 200 | pass |  |  | $.availability declared state variant; $.backdropUrl declared state variant; $.library.addPayload.rating declared state variant; $.library.addPayload.synopsis declared state variant; $.library.status declared state variant; $.library.watchListItemId declared state variant; $.overview declared state variant; $.rating declared state variant; $.ratingSource declared state variant; $.ratingSource schema unproven; $.releaseDate declared state variant; $.transfer declared state variant; $.year declared state variant |
| GET | /api/title/{workKey} | /api/title/sintel-2010?t=Sintel&y=2010&type=movie (captures\title\sintel-detail.json) | 200 / 200 | pass |  |  | $.availability declared state variant; $.backdropUrl declared state variant; $.library.addPayload.rating declared state variant; $.library.addPayload.synopsis declared state variant; $.library.status declared state variant; $.library.watchListItemId declared state variant; $.overview declared state variant; $.rating declared state variant; $.ratingSource declared state variant; $.ratingSource schema unproven; $.releaseDate declared state variant; $.transfer declared state variant |
| POST | /api/title/{workKey} | /api/title/tmdb-movie-45745 (harmless source-derived branch) | 200 / 200 | pass |  |  | $ schema unproven |
| GET | /api/title/{workKey}/extras | /api/title/family-guy/extras?t=Family%20Guy&type=tv&s=1 (captures\title\family-guy-extras.json) | 200 / 200 | pass |  | $.episodes[].airStamp extra (allowed by baseline) | $.certification declared state variant |
| GET | /api/title/{workKey}/extras | /api/title/rick-and-morty-2013/extras?t=Rick%20and%20Morty&type=tv&s=1 (captures\title\rick-and-morty-2013-extras.json) | 200 / 0 | transport failure | $.airedEpisodes missing; $.certification missing; $.episodes missing; $.generatedAt missing; $.genres missing; $.inTheatricalWindow missing; $.moreLikeThis missing; $.nextHomeReleaseAt missing; $.originalLanguage missing; $.overview missing; $.rating missing; $.ratingSource missing; $.releaseDate missing; $.resolved missing; $.season missing; $.seasonCount missing; $.seasons missing; $.voteCount missing; $.workKey missing | $.transportError extra (allowed by baseline) |  |
| GET | /api/title/{workKey}/extras | /api/title/sintel-2010/extras?t=Sintel&type=movie&s=1 (captures\title\sintel-2010-extras.json) | 200 / 200 | pass |  |  |  |
| GET | /api/title/{workKey}/extras | /api/title/sintel-2010/extras?t=Sintel&y=2010&type=movie (captures\title\sintel-extras.json) | 200 / 200 | pass |  |  |  |
| GET | /api/title/{workKey}/links | /api/title/family-guy/links (captures\title\family-guy-links.json) | 200 / 200 | pass |  | $.links[].id extra (allowed by baseline) |  |
| GET | /api/title/{workKey}/links | /api/title/rick-and-morty-2013/links (captures\title\rick-and-morty-2013-links.json) | 200 / 200 | pass |  | $.links[].id extra (allowed by baseline) | $.links[].mediaType declared state variant; $.links[].names empty; element shape unverified |
| GET | /api/title/{workKey}/links | /api/title/sintel-2010/links (captures\title\sintel-2010-links.json) | 200 / 200 | pass |  | $.links[].id extra (allowed by baseline) |  |
| DELETE | /api/title/{workKey}/links/{provider}/{externalId} | /api/title/tmdb-movie-45745/links/tmdb/contract-missing (harmless source-derived branch) | 404 / 404 | pass |  | $.ok extra (allowed by baseline) |  |
| GET | /api/title/{workKey}/progress | /api/title/family-guy/progress?session=contract-capture (captures\title\family-guy-progress.json) | 200 / 200 | pass |  |  |  |
| GET | /api/title/{workKey}/progress | /api/title/rick-and-morty-2013/progress?session=contract-capture (captures\title\rick-and-morty-2013-progress.json) | 200 / 200 | pass |  |  |  |
| GET | /api/title/{workKey}/progress | /api/title/sintel-2010/progress?session=contract-capture (captures\title\sintel-2010-progress.json) | 200 / 200 | pass |  |  |  |
| GET | /api/title/{workKey}/releases | /api/title/family-guy/releases?season=1&episode=1 (captures\title\family-guy-releases.json) | 200 / 200 | pass |  |  | $.releases[].languages.audio[] schema unproven; $.releases[].quality declared state variant |
| GET | /api/title/{workKey}/releases | /api/title/rick-and-morty-2013/releases?season=1&episode=1 (captures\title\rick-and-morty-2013-releases.json) | 200 / 200 | pass |  |  | $.releases[].languages.audio empty; element shape unverified; $.releases[].languages.subtitles empty; element shape unverified; $.releases[].quality declared state variant |
| GET | /api/title/{workKey}/releases | /api/title/sintel-2010/releases?season=1&episode=1 (captures\title\sintel-2010-releases.json) | 200 / 200 | pass |  |  | $.releases empty; element shape unverified |
| POST | /api/title/{workKey}/releases | /api/title/tmdb-movie-45745/releases (harmless source-derived branch) | 400 / 400 | pass |  |  |  |
| POST | /api/torrent/send | /api/torrent/send (harmless source-derived branch) | 400 / 404 | 404 | $.ok missing | $.error extra (allowed by baseline) |  |
| DELETE | /api/wanted | /api/wanted?workKey=tmdb-movie-45745 (harmless source-derived branch) | 200 / 200 | pass |  | $.retried extra (allowed by baseline) |  |
| GET | /api/wanted | /api/wanted (captures\wanted\all.json) | 200 / 200 | pass |  |  | $.queue[] schema unproven; $.wanted[] schema unproven |
| POST | /api/wanted/try | /api/wanted/try?workKey=tmdb-movie-45745 (harmless source-derived branch) | 200 / 200 | pass |  | $.removed extra (allowed by baseline); $.retried extra (allowed by baseline) |  |
| DELETE | /api/watchlist | /api/watchlist?id=851f2fd8d0093ca141681ec07decedf12b4d535c5429a6077389b80e07f2f34d (harmless source-derived branch) | 200 / 200 | pass |  |  |  |
| GET | /api/watchlist | /api/watchlist (captures\watchlist\all.json) | 200 / 200 | pass |  |  | $.items[].fromEpisode declared state variant; $.items[].latestReleaseAt declared state variant; $.items[].latestReleaseMagnet declared state variant; $.items[].rating declared state variant; $.items[].synopsis declared state variant |
| PATCH | /api/watchlist | /api/watchlist (harmless source-derived branch) | 200 / 200 | pass |  | $.existed extra (allowed by baseline); $.item.createdAt extra (allowed by baseline); $.item.cursorMisses extra (allowed by baseline); $.item.lastChecked extra (allowed by baseline); $.item.newEpisodesSince extra (allowed by baseline); $.item.preferredResolution extra (allowed by baseline); $.item.provider extra (allowed by baseline); $.item.seederWaitSince extra (allowed by baseline); $.item.userId extra (allowed by baseline); $.item.workId extra (allowed by baseline) |  |
| POST | /api/watchlist | /api/watchlist (harmless source-derived branch) | 200 / 200 | pass |  | $.existed extra (allowed by baseline); $.item.createdAt extra (allowed by baseline); $.item.cursorMisses extra (allowed by baseline); $.item.lastChecked extra (allowed by baseline); $.item.newEpisodesSince extra (allowed by baseline); $.item.preferredResolution extra (allowed by baseline); $.item.provider extra (allowed by baseline); $.item.seederWaitSince extra (allowed by baseline); $.item.userId extra (allowed by baseline); $.item.workId extra (allowed by baseline) |  |
