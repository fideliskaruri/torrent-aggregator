# Phase 6 read-model and title contracts

OPS-801, OPS-802, OPS-803, OPS-804 and the title subset of OPS-799.
The web declarations are authoritative; capture-required keys describe samples,
not unconditional requirements (see `backend/contract/README.md`).

## Nullable values

| Route / field | Web declaration / decision |
|---|---|
| Activity `rung` | Not consumed by `ActivityItem` in `web/src/app/notifications/page.tsx`, but captured as a string. Describe the work and kind when known, otherwise the attempt kind. |
| Activity `language` | Not consumed by `ActivityItem`, but captured as a string. Report Parser's explicit markers, otherwise “Language not stated”. Do not claim a language check passed. |
| Activity `infoHash` | `InboxCandidate` in `web/src/app/notifications/inbox.ts` permits `string \| null`. An acquisition attempt before any release exists honestly has no hash. |
| Client response `host` | `web/src/app/downloads/page.tsx` declares `host?: string`. Built-in Engine has no external host: omit it, never invent a host or send null. |
| Client `eta`, `queuePosition` | `web/src/app/downloads/types.ts` declares optional numbers, not nullable numbers. Omit unknown ETA and queue position outside the queued state. |
| Client `episode`, `season` | The Downloads row explicitly permits `number \| null`. Retain null for a film or unknown coordinate. Populate from the target's episode/season, or a linked library file. |
| Client `workId`, `workKey`, `workTitle`, `workMediaType` | The Downloads row explicitly permits `string \| null`. Fill from the catalog work attached to a target or library file. Unidentified raw transfers retain null; do not guess identity from a release name. |
| Client `workYear` | The Downloads row explicitly permits `number \| null`. Use catalog year; retain null when unknown. |
| Client `posterUrl` | The Downloads row explicitly permits `string \| null`. Use the same linked Work's poster; unknown/unidentified rows retain null. |
| Notification `posterUrl` | `NotificationItem` in `web/src/components/notifications/notification-feed.tsx` does not declare/consume this extra field. Retain a real linked Work poster; omit the extra when no poster exists. No nullable contract is invented. |
| Extras episode `airStamp` | `web/src/components/title/types.ts` does not declare/consume this extra field. Retain the actual air timestamp when known; omit it when unknown. `airDate` retains its separately declared nullable behavior. |
| Manual-release `quality`, `sizeBytes`, `languages` | `ReleaseCardData` explicitly allows null. Quality/size come from Release; language-track evidence is null when unavailable, not fabricated from title language. Parser markers are also supplied as the legacy `language` string. |

## Routes

- `/api/wanted.queue` is the array from Targets' public snapshot, not an empty object.
- Every requester-only owner denial returns 403 with the old `error` and
  `code: requester_only` JSON object.
- Requester season parameters accept `source`/`sourceId`, with
  `provider`/`providerId` retained as aliases. Parameters are read after the
  requester filter, so the old owner query cannot fail binding with 400 first.
- GET title releases calls Find only, never Check, Acquire or Engine. It uses
  confirmed catalog coordinates; missing numbering yields an honest empty
  list rather than a fabricated scope. Explicit search text uses Find's public
  raw-search operation.
- POST title releases requires a server-protected, work/scope-bound choice with
  a 15-minute expiry. Choices expire on restart. Find revalidates identity and
  coverage; Targets owns acceptance, safety/quality enforcement and manual picks.
  A season choice must cover its entire requested scope; choose an individual
  episode for a release covering only that episode. Missing choice returns 400;
  invalid/stale/mismatched choice returns 409; an accepted pick returns 200.
- DELETE title links delegates to Metadata's versioned `ChangeLinkAsync`.
  Missing links return 404. Primary-link/conflict refusals return 409, rather
  than bypassing Metadata's safety rules. Success returns 200 with `ok` and
  the refreshed links.
- POST title returns 200. A legacy public key without a saved record may resolve
  the supplied catalog identity; the response carries the canonical `workKey`.

## Evidence and limits

Isolated build: zero warnings/errors. HTTP proof uses port 3966 on a SQLite
backup of stable data, converted without mapping original payload roots.
Scheduler disabled; no original payload is downloaded or modified.
Evidence: gitignored `tools/.contract-proof/reads/`, including raw capture
comparisons, web-type adjudications, picker/unlink success bodies and browser
screenshots at 1280 and 390.

The original capture comparator reports some legitimate state variants as
failures because its extracted TS registry does not include all page-local
declarations. Proof retains those raw failures separately and documents each
web-type correction; the captures themselves are not changed.
Authenticated requester success, a downloading swarm after a manual pick,
and untested mutation/restart variants are not claimed by this lane.
The browser walk additionally proves Season 2 displays its 21 provider episodes
and survives revisiting the title. Download-log messages exposing serialized
legacy JSON are tracked separately as OPS-817. The proof console records a
missing service-worker script/MIME error from the supplied web build and brief
connection refusals during the intentional sandbox restart; it is not a claim
of a warning-free browser.
