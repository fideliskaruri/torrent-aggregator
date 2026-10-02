# Requests

Friends you let in through Cloudflare Access (see [remote-access.md](remote-access.md#requesters)) can
search titles, ask for them, follow their own requests and see what is already in the library. The owner
approves or declines in the **Requests** inbox; an approval downloads the title on the request lane.

## What a requester sees

Everyone uses the **same app**: one shell, one set of pages and components. A role only decides which
actions and pages you see. The SPA reads `role` from `GET /api/me` and turns it into capabilities with
`useCapabilities()` (`web/src/lib/capabilities.ts`); screens ask for a capability, never for a role.
Copy follows the same rule: a line that names an action shows only to someone who can take it. The title
page's "Not in your library yet" hint is the owner's alone, and leaves out "Download it" while a title is
unreleased or still in cinemas.

| Capability | Owner | Requester |
| --- | --- | --- |
| `canDownload` (Download, Download season, quality) | yes | no |
| `canManage` (Settings, Rules, automation, delete, Add to library) | yes | no |
| `canSeePaths` (file paths, Open, Show in folder, raw release names) | yes | no |
| `canSeeTransfers` (speed, peers, per-episode progress) | yes | no |
| `canReviewRequests` (approve, decline, auto-approve) | yes | no |
| `canSeeUpcoming` | yes | no |
| `canRequest` (Request button) | no | yes |

- **Navigation** (`web/src/lib/navigation.ts`): each entry names the capability it needs. Requesters see
  Browse, Library, Notifications (Alerts on mobile), Requests and the search box. Downloads, Upcoming,
  Settings and the share target are hidden, and opening one of those routes directly shows
  "Not available" with a way back to Browse (one guard in the router).
- **Browse, Search and title pages** are the owner's pages. Where the owner has Download / Download season,
  a requester has **Request** in the same place. Series open the request dialog (whole series or
  specific seasons, plus an optional note). After sending, the button reads **Requested**; later states
  are "Approved", "Downloading, 3 of 10" (counts only), "Available" or "Declined" with a way to ask again.
  The state follows what was asked for, not the approval: a film is "Available" only once its file is in the
  library, and a season request only marks the seasons it asked for ("Season 2 available", with
  **Request more seasons**). A series is never "Available" as a whole. Request
  sends the catalog id the title payload names (`provider`, `providerId`; see
  [sources.md](sources.md#browse-cards-and-catalog-ids)). When no catalog id is known, the page says
  "Couldn't match this title to a catalog entry. Search for it to request it." instead of showing a
  Request button.
- **Library** (`/watchlist`) is the owner's Library page, read-only: it is fed from
  `GET /api/requester/library` and has no delete, paths, folders or automation. Browse cards carry no
  file quality, episode counts or availability badges for a requester.
- **Requests** (`/requests`) is one page. The owner sees the inbox of everyone's requests; a requester
  sees their own, with **Cancel request** while it is pending.

The server still enforces the boundary: requesters only reach the catalog reads listed in
[remote-access.md](remote-access.md#requesters), and those answers are stripped of magnets, hashes,
releases, file paths and transfer state and carry the caller's own `inLibrary`, `requestStatus`,
`requestId`, `availableSeasons`, `requestDone` and `requestTotal` instead.

### Request state

One derivation (`LibraryOnDisk` in `Requests/RequestState.cs`) answers "what has arrived" for the title
page, the Requests page (both roles), notifications and the requester Library. Its source of truth is the
owner's Downloaded rail: finished transfers whose files are still on disk, mapped to their works and
episodes. An approved film is `downloading` until its file is there, then `available`; a season request
counts the aired episodes of the requested seasons (`done` of `total`, from the season shape every
acquisition path reads, else the episodes the queue wants) and is `available` only when every one of them
is there; a season with one episode on disk is not in the library. Ready episodes are placed by their
queue key, their name's season and episode, or an absolute number ("Frieren - 29") mapped through the
season shape. Anime series count as series (the work's stored format, else the request scope). Pending, declined and cancelled requests pass through unchanged.

### Shared requests

Requests are one per title and scope across requesters (same work key, scope and seasons). When a second
requester asks for something already requested, their row joins it: if the first is still pending it stays
pending and the owner is not notified again; if it is already approved the joiner's row is approved too and
they get the "Request approved" notification. A failed ask is never joined: the new request is pending
and the owner is notified. The owner's inbox shows one card naming everyone who asked
(`requesters`); approving or declining it decides every pending row of that ask in one transaction (decisions
and joins are serialized), so racing decisions leave one outcome. A requester's cancel takes the same lock.
Each requester is notified, one row (the
oldest) is elected to grab and the others take its outcome: its transfers, or its failure.

### Previewing as a requester

The owner can check what friends see without a second account: **View as requester** in the desktop
header (eye icon) or at the bottom of the mobile **More** sheet. It stores `tf_preview_role=requester` in
`sessionStorage` (this tab only) and shows a slim "Previewing as a requester · Exit preview" banner.
It changes rendering only: a real requester never sees the toggle (the stored value is ignored unless the
real role is owner), and the server grants nothing extra. While previewing, the owner's own data is shown
read-only and Request/Cancel are not sent.
## Data

`MediaRequest` (migration `AddMediaRequests`):

| Column | Notes |
| --- | --- |
| `id` | GUID string |
| `requestedByUserId` | FK to `User.id` (the requester's row, created on first sign-in; cascade delete) |
| `provider`, `providerId` | catalog reference: `tmdb`, `anilist`, `tvmaze` or `itunes` with its numeric id, or `cinemeta` with an IMDb `tt` id |
| `workKey` | the same work key the library uses, recomputed on the server from the title (and year for films) |
| `mediaType`, `title`, `year`, `posterUrl` | display fields; the poster must be an https URL on a known catalog image host or it is dropped |
| `scope` | `movie`, `seasons` or `series` |
| `seasons` | comma-separated season numbers for `seasons` scope |
| `note` | up to 500 characters from the requester |
| `status` | `pending`, `approved`, `declined`, `fulfilled`, `failed` or `cancelled` |
| `decisionReason`, `decidedAt` | set when the owner decides; the requester sees the reason |
| `watchListItemId`, `acquisitionTargetId` | nullable links (set null if the target goes) |
| `grabbedHashes` | info hashes the approval started (migration `AddRequestGrabbedHashes`); never sent to a requester |
| `createdAt`, `updatedAt` | UTC |

`pending` and `approved` are **open**.

`RequestAutoApproveRule` (migration `AddRequestAutoApproveRules`):

| Column | Notes |
| --- | --- |
| `id` | GUID string |
| `email` | requester email, stored lowercased; unique |
| `mode` | `none` (not stored — rows with none are dropped), `moviesOnly` or `everything` |
| `createdAt`, `updatedAt` | UTC |

## Requester API

All under `/api/requester`, JSON, `Cache-Control: no-store`. Only a requester may call these; the owner gets
403 `requester_only`. Errors are `{ error, code }`.

- `GET /titles?q=&category=` — title search through the same catalog search as the owner's title search
  (`WorkSearchService`). `q` is required, at most 200 characters. Returns `{ results, partial }`; each
  result has `key`, `title`, `year`, `mediaType`, `isSeries`, `format`, `category`, `provider`,
  `providerId`, `posterUrl`, `overview`, `releaseDate`, `inLibrary`, and the caller's own open
  `requestStatus`/`requestId` for that title. No file paths, magnets, torrents or indexer data. A catalog
  failure is 502 `search_failed` without the cause.
- `GET /seasons?provider=&providerId=&mediaType=&title=&year=` — `{ seasons }`, the catalog's season numbers
  (1–500, sorted, distinct, at most 100). A catalog failure is 502 `seasons_failed` without the cause.
- `GET /requests` — `{ requests }`, the caller's own requests, newest first (at most 200). `status` is the
  derived state (`downloading` and `available` replace `approved`/`fulfilled` once something has started or
  arrived) with `done`/`total` episode counts for series.
- `POST /requests` — body `{ provider, providerId, mediaType, title, year, posterUrl, scope, seasons, note }`.
  JSON only (415), at most 16 KB (413), unknown fields and wrong types are 400. Rules:
  - A film is `movie` scope; a `tv` title is `seasons` (1–100 seasons, numbers 1–500) or `series`.
  - 409 `in_library` when what is asked for is already on disk: the film's file, or every requested season.
    Watch-list items and download targets that have not finished do not count.
  - 409 `duplicate` when the caller already has an open request for the same work with an overlapping
    scope: two movie requests, anything against `series`, or season lists sharing a season.
  - 409 `too_many_open` when the caller already has `MaxOpenPerUser` open requests.
  - 201 `{ request }` on success. Status is normally `pending`. When the owner has an auto-approve rule
    for the requester's email that matches the request (`moviesOnly` for films, `everything` for any
    scope), the create path runs the same approve + request-lane grab as a manual approval before the
    response. The returned request then has status `approved`, `decisionReason` `"Auto-approved"`, and
    `decidedAt` set.
- `GET /library` — `{ titles }`: `key`, `title`, `year`, `mediaType`, `posterUrl` for the titles on the owner's
  Downloaded rail (finished, files on disk; at most 500). Nothing else.
- `POST /requests/{id}/cancel` — only the caller's own request; 404 `not_found` otherwise. 409
  `not_pending` unless it is still pending, saying what happened first (already approved, declined or
  cancelled). Returns `{ request }` with status `cancelled`.

Title and season lookups are not rate-limited at the app level (trusted friends only). The owner's
title-search box still has its own 60/minute per-client guard against keystroke spam.

## Owner API

- `GET /api/requests?status=` — owner only (requesters get 403). `{ requests, pendingCount }`, newest first
  (at most 500), optionally filtered by status (400 for an unknown status). Rows for the same ask and status
  are folded into one: `requestedBy` (the first requester's email), `requesters` (every email), `phase`
  (the derived state above), `done`/`total`, `workKey` and the link ids. `pendingCount` counts asks.
- `POST /api/requests/{id}/approve` — pending only (409 `not_pending`, 404 `not_found`). Marks it `approved`,
  then grabs in the background through the owner's own grab path (`GrabService`) on the `request` queue lane:
  one release for a film; one exact release per aired episode of the chosen seasons (the whole series is
  every catalog season, at most 30). The hashes are stored; if nothing starts, the request becomes `failed`
  with a generic reason (the indexer detail stays in the owner's log); if the asked seasons have not started
  airing it stays `approved` with "Downloads when it airs.". Auto-approve reuses this same path
  with reason `"Auto-approved"`. Approval, decline and cancellation atomically claim the pending state:
  concurrent retries cannot start a second grab or overwrite a winning decision. Request grabs persist one
  canonical work identity before sending any releases; they do not add a monitored watch-list item.
  Downloads uses that identity across release-name variations. Older request downloads are also grouped
  using the request's stored hashes, without moving or downloading their files again.
- `POST /api/requests/{id}/decline` — optional body `{ reason }` (at most 500 characters, shown to the
  requester). Pending only.
- `GET /api/requests/auto-approve` — owner only. `{ rules, knownEmails }`. Each rule is
  `{ email, mode }` where `mode` is `moviesOnly` or `everything` (rows with `none` are not stored).
  `knownEmails` is the lowercased union of emails seen on past requests and current rules, for the inbox UI.
- `PUT /api/requests/auto-approve` — owner only. Body `{ rules: [{ email, mode }] }` (at most 200 rules).
  Replaces the full set. Valid modes: `none`, `moviesOnly`, `everything`. `none` (or empty mode) drops that
  email. Emails are normalized lowercased; invalid email/mode or unknown fields are 400. Returns the same
  shape as GET.
- One episode is grabbed once whichever path gets there first (request approval, the hunter, a season
  download or an on-demand grab): `GrabService` keys in-flight grabs by work and episode (not resolution)
  and skips an episode that already has a healthy transfer or is covered by a season pack. A transfer that
  errored, was removed or lost its files does not count, so the episode can be grabbed again. Transfers
  from before episode keys are matched by their name's season and episode.
- Fulfilment: on the engine's `TorrentCompleted` event (and once at startup), an approved request becomes
  `fulfilled` when nothing in its scope is still being looked for, no wanted row names a live transfer the request
  has not joined yet, none of its tracked transfers has stopped, the film or every episode in scope is here or
  coming, and its live transfers have all completed. A season request then stores its high-water mark
  (`fulfilledThrough`: per season, the last episode it covered). Replaced or removed transfers never hold a
  request open; a dead release the queue or a pick replaced leaves `grabbedHashes`.
- A season request is the whole season as it airs. Every 30 minutes (and at startup) open season requests queue
  any aired episode the wanted queue has no target for. Fulfilled ones from the last year queue only aired
  episodes above their mark that have no target; a named season that had not aired when the request was fulfilled
  has mark 0 and is queued whole once it starts. Every row of the ask is approved again together, before anything
  is queued (so a find the queue reports at once joins every requester), and then judged only above its mark, for
  health, partial and fulfilment alike: an episode the owner deleted, or whose files went missing, is history, is
  never looked for again (Retry included), and the request returns to `fulfilled` ("New episodes ready") once the
  new ones are here, or quietly if the owner removed the new one too. The requester's count is what the request
  still owes plus what is still on disk. While a requested season is still airing the requester sees it as
  available once every aired episode is here, with the note "New episodes download as they air".
- A season that has not started airing is not a failure: when an asked season's episodes are dated in the future
  and none has aired, approval (or Retry) leaves the request `approved` with "Downloads when it airs.", and the
  airing check queues it when the first episode airs. A season that has aired but whose episode list could not be
  read fails as before, with Retry and Pick a release.
- Stopped transfers: a transfer the request tracks is stopped when the engine reports it in error or with missing
  files and nothing has replaced it on its film or episode. Every minute (sooner when the engine reports a
  failure) an approved request the queue is not looking for anymore with a stopped transfer becomes `partial`
  ("Part of the download stopped. ...") when something in it is still here or coming, else `failed` ("The
  download stopped. The owner can retry it or pick another release."). The stopped transfers the requester and
  the owner (once per ask) were told about are stored, sorted (`stoppedKey`): only a transfer that stops later is
  news, and a set that only shrinks (one resumed, replaced or removed) is stored without telling anyone. A later
  find for another episode keeps the request partial without announcing anything; once nothing is stopped it is
  approved again quietly. Rows approved into an ask that is already partial, and new requesters who join it, take
  its stored set too, so nobody is told about an old stop.
- Removals: a transfer the owner removed is not a stop and notifies nobody. A request fulfilled before is judged
  on the rest (it is fulfilled again quietly if the owner removed the new episode). A request never fulfilled
  whose film or episodes are gone (removed, or their files went) with nothing looking for them stops waiting
  quietly: `partial` ("Some episodes were removed. The owner can retry them or pick another release.") when
  something in it is here or coming, else `failed` ("The download was removed. ..."), so it never sits approved
  with nothing happening.
- Retry, for every row of the ask, forgets stopped, replaced and removed hashes. After a stop it looks again only
  for the stopped episodes (and anything the queue was still looking for); what the owner removed stays removed.
  After a removal it looks again for what was removed. Retry never adds a wanted row back, so an episode the owner
  stopped looking for never returns; only a request that never wanted anything is grabbed as on approval. A
  hand-picked release (`POST /api/requests/{id}/pick`) fills the film's or episode's acquisition target, so it
  follows the same path, and every row of the ask shares it. A new requester never joins an ask whose transfers
  all died.
- Covered mark: every row of an ask records, per season, the last episode it has ever wanted (`coveredThrough`):
  what approval queues, and on every airing check each aired episode in scope that already has a wanted row,
  whoever made the row (another ask, the owner's own season download). An episode at or below it whose wanted row
  is gone was removed by the owner or stopped (Remove on a looking row, see Downloads), so neither the airing check,
  nor a recheck, nor a restart re-grab, nor Retry brings it back; only episodes above it are new. When the owner
  stops an episode or a season, every decided request covering it, of any ask, raises its mark to that episode (a
  season: through its last aired episode) before any of them is rechecked. A pending ask has queued nothing, so it
  takes no mark; approving it later is the owner's call. Such episodes are not owed: they never count as
  removed, the requester's count leaves them out (a fulfilled season whose last episodes the owner stopped reads
  available), and the fulfilled mark is raised to at least the covered mark. The owner's stop marker on a request
  ("The owner stopped looking for some episodes.") only keeps the restart sweep from re-grabbing a request with no
  transfers; it is kept through later finds, and a request with transfers that later loses some is judged like
  any other (partial or fulfilled, never left approved).
- Upgrade: season requests decided before covered marks existed get one at startup, before the restart sweep:
  per season, the last episode that had aired when the request was decided. Until a row has it (its lookup failed;
  it is tried again before every airing check), nothing reconciles or re-grabs it. A request fulfilled before the
  upgrade takes at least its covered mark as its fulfilled mark.
- A transfer the engine hands back to the queue itself (a dead magnet that never gave its file list, a refused
  file list or English check, a refused promotion) leaves its wanted row `queued` with no hash: the queue is
  replacing it, so the request is still looking. Nobody is told it stopped, and the replacement joins quietly.
- `GET /api/me` includes `pendingRequests` for the owner. The SPA shows it as a badge on the **Requests**
  nav entry (desktop header after the divider; mobile More sheet and the More tab), and the `/requests`
  inbox lists pending, approved and declined requests with **Approve** and **Decline** (toasts on each).
  An **Auto-approve** section on the same page lists known requester emails, lets the owner set each to
  Off / Movies only / Everything, and add emails that have not requested yet.
- Remove on a "Looking for a release" row (`DELETE /api/wanted`, a film, a season or one episode) settles every
  request covering it, each on its own, by what is still being looked for in its scope. Transfers the Remove undid
  leave every request that named them. A request that names no transfer and has nothing left to look for becomes
  `cancelled` ("The owner stopped looking for this."). One still being looked for stays open; an approved one that
  names no transfer yet keeps the reason "The owner stopped looking for some episodes.", and the startup sweep never
  grabs such a request again, so a removed episode stays removed after a restart. One that names transfers and has
  nothing left to look for is approved again if it was `partial` or `failed` (its reason cleared), and becomes
  `fulfilled` at once if its transfers have finished, or when the last one finishes.

## Configuration

### Duplicate-looking download groups

A whole-series request is one release per aired episode, not one torrent for the entire show. In the
September 28, 2026 simulator reproduction, TVmaze's Frieren catalog contained 28 season-one and 10
season-two episodes. One approval produced 38 distinct episode hashes, no season packs, and no watch-list
item. The old Downloads fallback classified some cleaned release titles as films and others as series,
splitting the same show into two groups; it did not download the episodes twice.

Update and refresh Downloads to regroup existing request transfers using their stored request identity.
Do **not** delete one whole group as a cleanup step: it may contain different episodes. If individual
episodes really have multiple releases, inspect their season/episode and remove only the unwanted
transfers (choose file deletion only when those files are no longer wanted).

`TorrentFlow:Requests`:

| Setting | Default |
| --- | --- |
| `MaxOpenPerUser` | `10` |

`TorrentFlow:RemoteAccess:AllowRequesters` (default `true`, also in Settings → Remote access) turns the
requester role on or off.

## Tests

`server/tests/TorrentFlow.Api.Tests/RequesterTests.cs` (allow-list table from `EndpointDataSource`, path
tricks, requester JWT flows, search flags and leak checks, duplicate/overlap, in-library, cap, cancel,
validation), `RequestDecisionTests.cs` (approve/decline, request-lane grab seam, fulfilment
for films and multi-transfer series, safe failure reason, requester library leak checks),
`RequestAutoApproveTests.cs` (rule matching, owner-only CRUD, movies-only vs everything on create, none leaves
pending) and `(removed; see docs/test-audit.md) (role-aware shell, requester views and library, inbox ordering,
badge count, auto-approve parse/rows/labels).
