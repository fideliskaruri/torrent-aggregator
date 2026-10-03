# Api action fixes: OPS-843, OPS-837, OPS-844

Started 2026-10-03 21:57 +03. Three code commits on `rebuild`; no push.
Only Api and the OPS-843 Library web controls/copy were changed.

## Isolation and validation

The requested ordinary worktree command refused because `rebuild` was already
checked out. A detached snapshot at `b6cfb66` was used in
`D:\code\memtest\wt-apiact`. Only HTTP **3967** was used. Development endpoints,
disabled scheduler, private output folders and fresh private databases were used.
The TMDB key was supplied only to each server child environment.

Final Api build: **0 warnings, 0 errors** (`build-final.log`). Web strict
typecheck and Vite build passed (`web-build.log`). No unit tests.
Existing fresh-database migration warnings were not changed or concealed.

## OPS-843

**Root cause:** `LibraryEndpoints.Delete` looked up only persisted WatchItems.
An owned-only `library:<workId>` identifier is a read projection, not a WatchItem,
so the adapter returned 404. The old confirmation incorrectly promised to keep
files. Whole-title scoped deletion also left persisted WatchItem/follow intent.

**Fix:** resolve identifiers through the same `LibraryRead.ItemsAsync` union as
the Library page. Compose existing `LibraryRemoval.Preview`,
`TargetPipeline.DeleteLibraryAsync`, scoped intent cancellation and
`CatalogState.RemoveAsync`. No deletion algorithm, duplicate ownership record or
WatchItem synchronization was added. A failed intent removal is not reported as
success. Owned Library rows open the existing scoped preview/confirmation dialog.
The title and Library controls share one truthful removal-copy helper. Explicit
confirmation is sent to the existing watchlist action; no em dashes were added.

**Commit:** `20d6862` (Refs: OPS-843).

**Evidence:** final `verify.ps1` repeatedly passed real HTTP assertions:
licensed Sintel copied from the original fixture, imported TrackInPlace,
visible exactly once and ready in `/api/watchlist`; scoped GET previews exactly
one 129,241,752-byte file; unconfirmed POST refuses and preserves bytes;
confirmed POST removes bytes and ownership. Owned-plus-explicit-intent removal
also removes the item. A deliberately changed copied file is refused by the
existing digest check and remains untouched; restored original bytes can be
deleted. Final restart leaves Library empty, with no WatchItem, MediaFile,
Download or DownloadTarget rows.

Headless **Edge through Playwright MCP**, at **390 and 1280 only**, exercised real
controls without mocks. Screenshots: `library-delete-{390,1280}.png`,
`title-remove-{390,1280}.png`, `library-empty-390.png`. The actual Library
confirmation removed the copied file and rendered **0 titles**; the actual
title confirmation rendered **Add to library** afterward. No page errors or
horizontal overflow in the final fresh browser context (`visual-summary.json`).
An early shared-browser page contained another proof's route interception; its
results were discarded. Final screenshots use an explicitly launched headless
Edge process and a fresh context, not that shared page.

**Unproven:** season/episode pack deletion, offline roots, requester visual
flows and injected persistence-transaction failure were not rerun. Their module
implementations and access filter were unchanged. Independent coordinator critic
is pending.

## OPS-837

**Root cause:** DevFiling trusted caller target IDs and wrote new TargetRows,
instead of asking Targets to accept/reuse the work's intent. Store's valid
one-film-target constraint was mislabeled as a changed download.

**Fix:** call the same `AcquireAsync` entry as real Download, with the actual
HTTP actor; read the returned canonical targets and remap placement assignments
to them. Use canonical Metadata for placement and persist the existing
DownloadTarget association shape, not another Target. Existing hash downloads
are duplicates regardless of their caller namespace. Invalid duplicate item
input is refused at the HTTP adapter. A filing persistence refusal no longer
claims the download changed. The real Download/Try adapters were read: Download
uses `AcquireAsync`; Try uses `ActionAsync`/`ScopeActionAsync`. Neither contains
the DevFiling error translation.

**Commit:** `8143670` (Refs: OPS-837).

**Evidence:** `verify-filing.ps1` passed on the final build and a fresh database:
real title Download creates the intent; filing with a different caller ID and
no root returns the actual **NoDriveSpace / No drive has space**; direct Try
accepts that same target; adding a root lets filing succeed. Repeated and renamed
submissions return accepted/duplicate, with exactly one unchanged canonical
target ID and one Download. Real Download repeat returns **Already queued**.
The licensed transfer completes all **129,241,752** bytes and its SHA-256 is
`1DC6F2CA9762DFCC7D1B1843129A3E4F351D1FE935DEA2241C7B359C11EBC1D8`,
equal to the original fixture. The existing scoped flow also deletes this
downloaded-origin file (`downloaded-scoped-delete.json`).

The current local Seeder source in `tools\.jelly-proof\Seeder` was built
separately. The older prebuilt Seeder did not implement its current HTTP peer
injection; its initial timeout is discarded. The final seeder hash-checked
**494/494** pieces, injected a real loopback peer and delivered the bytes.

**Unproven:** scheduler-enabled discovery and full public Try-to-discovery
transfer were deliberately not run. `/api/wanted/try` returns retried=0 for an
already-Wanted item; it is not counted as a resumed transfer. Direct target Try
acceptance and corrected-root transfer are proven separately. Store's
CommitResult does not expose the original SQLite exception; this lane did not
change that contract or claim a new database error taxonomy.

## OPS-844

**Root cause:** the picker replaced the empty-target acquisition answer with
hardcoded episode-list advice; it also ignored refusal from the subsequent Pick.

**Fix:** return the actual `TargetActionReply.Message` for refused or empty
acquisition and for a refused Pick. No second owner-hold rule in Api.

**Commit:** `dd62454` (Refs: OPS-844).

**Evidence:** a real scoped picker search produced a valid signed token for
licensed Sintel. A proof-only durable adoption-review fixture was populated
from the same real HTTP import scan in the isolated database. Picker POST
returns **409**, `ok=false`, exactly:
**A file on disk may already be this. Review it in Import first.**
Direct Targets acquisition returns the identical refusal. No Download or
engine admission was created. Captures: `picker-owner-hold.json`,
`direct-owner-hold.json`, `picker-refused-targets.json`, `owner-hold-fixture.json`.
The subsequent real import confirmation resolves that review; after restart
acquisition is correctly allowed (`owner-hold-after-restart.json`). Its accepted
proof intent was then explicitly ended (`final-intent-ended.json`).

**Unproven:** a full converted-host adoption rehearsal was not repeated. The
review fixture is disclosed, not presented as a conversion run. Refusal arriving
between Acquire and Pick is compile-reviewed, not race-injected.

## Cleanup

Cleanup and final source/fixture integrity checks are recorded in `cleanup.json`.
No Library, Store, Targets, Metadata or Engine source was changed. No secrets,
Co-Authored-By trailers, whole-repo staging, push or branch deletion. The foreign
`tools/.gitignore` change was left alone. Live PID 3188, port 3930 and
`D:\code\memtest\stable` were never accessed or modified.
