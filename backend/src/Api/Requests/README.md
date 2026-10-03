# Requests

The existing web request routes live here. Create accepts the provider identity,
title, year, movie/seasons/series scope, seasons and optional note. Metadata owns
identity resolution; requests do not create a second catalog or acquisition queue.

`TargetPipeline.AcquireAsync` is the only acquisition entry. Equal title/scope
requests share targets, and owner decisions update the matching pending asks
together. Retry also uses `ActionAsync(TryNow)` for existing waiting targets.
Owner-removed targets and settled request items are not resurrected.

## Compatibility adapter

The public acquisition API has no request-origin parameter. `RequestTargetAdapter`
sets request priority/origin with CAS and joins request items to the returned target
IDs. `Target.createdBy` is a foreign key to `User`, so each request has a non-login
attribution actor with its request ID and no email. The actual requester stays in
`Request.userId`. Existing owner-created targets retain their creator and origin.

The public API has no token-bound manual picker/admission command. `/pick` returns
an explicit 409, rather than claiming to pick or starting a different release.
This remaining integration is tracked as OPS-776.

## Read model and settlement

Requester queries always filter by authenticated user ID. Owner list rows group
equal asks; requester list rows remain individual. Requesters can create requests,
but cannot cancel, decide, retry or pick. The legacy cancel route returns 403.

Both roles get the web's existing request fields plus quality, size, release name,
seeders, percentage progress, speed (bytes/second), ETA (seconds), pick reasons and
expected date. No magnets or filesystem paths are projected. The requester calendar
is `GET /api/requester/calendar` and contains only that requester's open requests.
Null values are included explicitly rather than pretending unknown values are known.

Owned-on-disk items fulfill immediately. A 30-second settlement sweep records filed
items and owner removals, and materializes newly known episodes through the same
public target API. It does not independently search, rank, probe or admit torrents.

## HTTP proof

Build `backend\src\Api\Api.csproj` to `D:\code\memtest\bin-requests`, then run
`tools\Test-RequestsContract.ps1` against fresh `D:\code\memtest\rebuild-requests`.
The script owns ports 3952/48952, uses signed development JWKS for separate requester
identities, and passes the TMDB key only in its child process environment.
Run again with `-Continue` to add a library root and prove actual Sintel transfer,
filing and an immediately fulfilled repeat request. Captures are gitignored under
`tools\.requests-proof`. No unit tests or changes to the legacy server are involved.
