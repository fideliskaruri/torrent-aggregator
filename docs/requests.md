# Requests

Friends you let in through Cloudflare Access (see [remote-access.md](remote-access.md#requesters)) can
search titles, ask for them, follow their own requests and see what is already in the library. The owner
approves or declines in the **Requests** inbox; an approval downloads the title on the request lane.

## What a requester sees

The SPA reads `role` from `GET /api/me`. A requester gets a trimmed shell with three views:

- **Search** (`/`): title search (movies, series, anime) with a **Request** button per result. Series open
  a picker: the whole series, or specific seasons from the catalog's season list, plus an optional note.
  Results already in the library show "In the library"; titles the requester already asked for show the
  request status (a series can still take a request for other seasons).
- **My requests** (`/requests`): every request with its status, scope, the owner's reason when there is
  one, and **Cancel** while it is still pending.
- **Library** (`/library`; the owner's `/watchlist` link lands here too): posters, titles and years of what
  has finished downloading. Read-only: no playback, no folders, no file paths. Any other path shows Search.

No owner navigation, page, search palette, download dialog or player is mounted for a requester, and the
server refuses every owner API for this role anyway.

## Data

`MediaRequest` (migration `AddMediaRequests`):

| Column | Notes |
| --- | --- |
| `id` | GUID string |
| `requestedByUserId` | FK to `User.id` (the requester's row, created on first sign-in; cascade delete) |
| `provider`, `providerId` | catalog reference: `tmdb`, `anilist`, `tvmaze` or `itunes`, and its numeric id |
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

## Requester API

All under `/api/requester`, JSON, `Cache-Control: no-store`. Only a requester may call these; the owner gets
403 `requester_only`. Errors are `{ error, code }`.

- `GET /titles?q=&category=` — title search through the same catalog search as the owner's title search
  (`WorkSearchService`). `q` is required, at most 200 characters. Returns `{ results, partial }`; each
  result has `key`, `title`, `year`, `mediaType`, `isSeries`, `format`, `category`, `provider`,
  `providerId`, `posterUrl`, `overview`, `releaseDate`, `inLibrary`, and the caller's own open
  `requestStatus`/`requestId` for that title. No file paths, magnets, torrents, indexer data or playback
  progress. A catalog failure is 502 `search_failed` without the cause.
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
  - 429 `rate_limited` beyond `CreatesPerMinute` creates per minute, keyed by the signed-in email (never by
    IP or `X-Forwarded-For`).
  - 201 `{ request }` on success, status `pending`.
- `GET /library` — `{ titles }`: `key`, `title`, `year`, `mediaType`, `posterUrl` for works with a downloaded
  target plus fulfilled requests (at most 500 of each). Nothing else.
- `POST /requests/{id}/cancel` — only the caller's own request; 404 `not_found` otherwise. 409
  `not_pending` unless it is still pending. Returns `{ request }` with status `cancelled`.

Title and season lookups share a `SearchesPerMinute` budget per email (429 `rate_limited`).

## Owner API

- `GET /api/requests?status=` — owner only (requesters get 403). `{ requests, pendingCount }`, newest first
  (at most 500), optionally filtered by status (400 for an unknown status). Each row adds `requestedBy`
  (the email), `workKey` and the link ids.
- `POST /api/requests/{id}/approve` — pending only (409 `not_pending`, 404 `not_found`). Marks it `approved`,
  then grabs in the background through the owner's own grab path (`GrabService`) on the `request` queue lane:
  one release for a film; one exact release per aired episode of the chosen seasons (the whole series is
  every catalog season, at most 30). The hashes are stored; if nothing starts, the request becomes `failed`
  with a generic reason (the indexer detail stays in the owner's log).
- `POST /api/requests/{id}/decline` — optional body `{ reason }` (at most 500 characters, shown to the
  requester). Pending only.
- Fulfilment: on the engine's `TorrentCompleted` event (and once at startup), an approved request whose
  grabbed transfers have all completed becomes `fulfilled`.
- `GET /api/me` includes `pendingRequests` for the owner. The SPA shows it as a badge on the **Requests**
  nav entry (desktop header after the divider; mobile More sheet and the More tab), and the `/requests`
  inbox lists pending, approved and declined requests with **Approve** and **Decline** (toasts on each).

## Configuration

`TorrentFlow:Requests`:

| Setting | Default |
| --- | --- |
| `MaxOpenPerUser` | `10` |
| `CreatesPerMinute` | `5` |
| `SearchesPerMinute` | `30` |

`TorrentFlow:RemoteAccess:AllowRequesters` (default `true`, also in Settings → Remote access) turns the
requester role on or off.

## Tests

`server/tests/TorrentFlow.Api.Tests/RequesterTests.cs` (allow-list table from `EndpointDataSource`, path
tricks, requester JWT flows, search flags and leak checks, duplicate/overlap, in-library, cap, per-email
rate limit, cancel, validation), `RequestDecisionTests.cs` (approve/decline, request-lane grab seam, fulfilment
for films and multi-transfer series, safe failure reason, requester library leak checks) and
`web/tests/requester.test.mjs` (role-aware shell, requester views and library, inbox ordering, badge count).
