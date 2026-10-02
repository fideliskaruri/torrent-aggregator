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
  are "Approved", "Available" (already in the library) or "Declined" with a way to ask again. Request
  sends the catalog id the title payload names (`provider`, `providerId`; see
  [sources.md](sources.md#browse-cards-and-catalog-ids)). When no catalog id is known, the page says
  "Couldn't match this title to a catalog entry. Search for it to request it." instead of showing a
  Request button.
- **Library** (`/watchlist`) is the owner's Library page, read-only: it is fed from
  `GET /api/requester/library` and has no delete, paths, folders or automation.
- **Requests** (`/requests`) is one page. The owner sees the inbox of everyone's requests; a requester
  sees their own, with **Cancel request** while it is pending.

The server still enforces the boundary: requesters only reach the catalog reads listed in
[remote-access.md](remote-access.md#requesters), and those answers are stripped of magnets, hashes,
releases, file paths and transfer state and carry the caller's own `inLibrary`, `requestStatus` and
`requestId` instead.

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
- `GET /requests` — `{ requests }`, the caller's own requests, newest first (at most 200).
- `POST /requests` — body `{ provider, providerId, mediaType, title, year, posterUrl, scope, seasons, note }`.
  JSON only (415), at most 16 KB (413), unknown fields and wrong types are 400. Rules:
  - A film is `movie` scope; a `tv` title is `seasons` (1–100 seasons, numbers 1–500) or `series`.
  - 409 `in_library` when the title is already in the owner's library (watch list or a download target).
    Library knowledge is per title, not per season, so any scope of a title in the library is refused.
  - 409 `duplicate` when the caller already has an open request for the same work with an overlapping
    scope: two movie requests, anything against `series`, or season lists sharing a season.
  - 409 `too_many_open` when the caller already has `MaxOpenPerUser` open requests.
  - 201 `{ request }` on success. Status is normally `pending`. When the owner has an auto-approve rule
    for the requester's email that matches the request (`moviesOnly` for films, `everything` for any
    scope), the create path runs the same approve + request-lane grab as a manual approval before the
    response. The returned request then has status `approved`, `decisionReason` `"Auto-approved"`, and
    `decidedAt` set.
- `GET /library` — `{ titles }`: `key`, `title`, `year`, `mediaType`, `posterUrl` for works with a downloaded
  target plus fulfilled requests (at most 500 of each). Nothing else.
- `POST /requests/{id}/cancel` — only the caller's own request; 404 `not_found` otherwise. 409
  `not_pending` unless it is still pending. Returns `{ request }` with status `cancelled`.

Title and season lookups are not rate-limited at the app level (trusted friends only). The owner's
title-search box still has its own 60/minute per-client guard against keystroke spam.

## Owner API

- `GET /api/requests?status=` — owner only (requesters get 403). `{ requests, pendingCount }`, newest first
  (at most 500), optionally filtered by status (400 for an unknown status). Each row adds `requestedBy`
  (the email), `workKey` and the link ids.
- `POST /api/requests/{id}/approve` — pending only (409 `not_pending`, 404 `not_found`). Marks it `approved`,
  then grabs in the background through the owner's own grab path (`GrabService`) on the `request` queue lane:
  one release for a film; one exact release per aired episode of the chosen seasons (the whole series is
  every catalog season, at most 30). The hashes are stored; if nothing starts, the request becomes `failed`
  with a generic reason (the indexer detail stays in the owner's log). Auto-approve reuses this same path
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
- Fulfilment: on the engine's `TorrentCompleted` event (and once at startup), an approved request whose
  grabbed transfers have all completed becomes `fulfilled`.
- `GET /api/me` includes `pendingRequests` for the owner. The SPA shows it as a badge on the **Requests**
  nav entry (desktop header after the divider; mobile More sheet and the More tab), and the `/requests`
  inbox lists pending, approved and declined requests with **Approve** and **Decline** (toasts on each).
  An **Auto-approve** section on the same page lists known requester emails, lets the owner set each to
  Off / Movies only / Everything, and add emails that have not requested yet.
- Remove on a "Looking for a release" row (`DELETE /api/wanted`, a film, a season or one episode) settles every
  request covering it, each on its own. Transfers the Remove undid leave every request that named them. A request
  with no transfer left and nothing left in its scope (no wanted row, no download) becomes `cancelled` ("The owner
  stopped looking for this."). Any other stays open and is checked for fulfilment at once; an approved one with no
  transfer yet keeps the reason "The owner stopped looking for some episodes.", and the startup sweep never grabs
  such a request again, so a removed episode stays removed after a restart.

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
