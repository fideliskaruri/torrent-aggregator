# OPS-861: one canonical work for converted ownership

Date: 2026-10-04. Base: `a7e683fa4b1db39c83474109777af9f1ec249116`.
Isolated branch/worktree: `canon-ops861`, `D:\code\memtest\wt-canon`.
Integrated fix commit on `rebuild`: `1d92777b7241ba12cce5c3c801295a078db1a5aa`
(isolated original `f409ccf2ba6bf5139321b891f024b2017f50b693`).
Backend only. No web, DownloadEndpoints, settings, LocalFiles or Library filing changes.

## Root cause

This was a real duplicate Work, not string-keyed MediaFile ownership.
Conversion imported legacy Work `cmurncg9qbuom9jsyhu3rn32g` / `rick-and-morty-2013`
with the eleven S1 files, primary TVmaze 216, verified IMDb `tt2861424` and TVDB
275274, and a **suggested** TMDB 60625 link. It separately imported a browse
CatalogEntry as Work `legacy-cdae52bba2bf6dbf7d4b482c873ded3d` /
`series:rick and morty`, with **verified** TMDB 60625 and no file/intent ownership.

Provider-key resolution correctly followed that verified TMDB link, but therefore
read the disconnected shell. Metadata's prior conflict policy demoted enrichment
links claimed by the other work instead of reconciling this catalog-only duplicate.
The existing Library ownership query correctly returned nothing for the wrong Work ID.
The original HTTP symptom is also recorded in `tools\.qag-proof\report.md` and OPS-861.

## Owning-module changes

- Converter imports canonical links before browse listings and reads those links
  to avoid manufacturing another Work for an existing provider identity. Suggested
  links remain suggested; browse-only facts remain in the conversion archive.
- Metadata uses its existing provider-identity comparator. Provider-confirmed,
  whole-work cross-links reconcile compatible unreferenced shells into the work
  owning inventory/intent. That work's ID, public key, episode IDs and references
  remain unchanged. Obsolete catalog rows are deleted in the same CAS commit.
- Cached provider-reported link conflicts cannot bypass reconciliation. Partial
  process-local answers and remembered query IDs are invalidated after reconciliation;
  a racing refresh re-reads the surviving identity if its original anchor was deleted.
- The Store metadata transaction vacates deleted verified-link and provider-episode
  unique slots before EF orders the surviving writes. This is an atomic storage
  ordering fix, not a second ownership map, service, schema, or download-file change.
- Different kinds/years, contradictory provider IDs, and two works carrying durable
  references fail closed. Fribb/name-only suggestions do not establish equivalence.

An intermediate refreshed-shell proof caught EF promoting the surviving verified
link before deleting the old one. The atomic slot handling fixed it; the final run
has no SQLite errors or server exceptions. The failed trial log is retained explicitly
as `intermediate-unique-slot-failure.log`, not counted as passing evidence.

## Isolation

Two fresh read-only SQLite backups of `D:\code\memtest\stable\data`, including WAL,
plus side-file copies were used. All 76 payload/supporting files were actual copies,
not sparse fixtures, junctions or symlinks. The final copy's **76 SHA-256 pairs match**
and original file sizes/mtimes were unchanged during hashing.

- Existing-conversion repair: `D:\code\memtest\canon-data`.
- Final corrected conversion: `D:\code\memtest\canon-fresh`.
- API output: `D:\code\memtest\bin-canon`; Converter: `bin-canon-convert`.
- HTTP proof server: **3961 only**, Development, scheduler explicitly disabled.
  The Engine's normal ephemeral transport listener had zero physical torrents.
- TMDB credential was supplied only to the child process environment. Evidence
  scan found zero credential leaks.
- All 61 operative absolute paths audited point into `canon-fresh`, never original media.
- Stable was never written. Live PID **3188** was never stopped, restarted or called.

## Verified outcomes

| Check | Result | Evidence |
|---|---|---|
| Both Rick keys, S1 | PASS: identical episode ownership; 11 owned at 1080p | provider-title.json, legacy-title.json |
| POST S01E08 using TMDB key | PASS: owned=1, queued=0, “Already in your library” | admission-tmdb-tv-60625.json |
| POST S01E08 using legacy key | PASS: owned=1, queued=0, same message | admission-rick-and-morty-2013.json |
| Search result opened through its actual href | PASS: same owned title state | search.json, search-opened.json |
| Library | PASS: exactly one ready Rick entry with the surviving work ID | library.json |
| Final fresh conversion, before startup | PASS: only the original Rick Work exists | fresh-converter-identity.json |
| Repair of the old converter's existing duplicate | PASS | existing-conversion-summary.json |
| Already-refreshed shell, including provider episode IDs | PASS: obsolete shell removed; reference row hashes unchanged | reconciled/refreshed-fixture.json, reconciled/reference-after.json |
| Concurrent alias GET/POST | PASS: 16 requests; Work/Target/MediaFile/Download/DownloadFile counts unchanged | concurrent.json |
| Restart, both title reads and admissions, search and library | PASS | fresh-before-restart/, summary.json and final HTTP files |
| Family Guy second real owned series, both keys | PASS: S01E01 owned 1080p; owned=1 queued=0 | family-guy-regression.json |
| Physical acquisition | PASS: zero torrents/diagnostics; 90 Targets and 30 legacy Downloads retained | engine.json, final-database.json |
| Converter repeated | PASS: “Already converted. No changes made.” | fresh-convert-repeat.txt |
| Integrity/FKs | PASS: integrity ok, zero FK violations | final-database.json |
| API and Converter final builds | PASS: 0 warnings, 0 errors | build.txt, converter-build.txt |

The prior-refresh scenario is explicitly a proof-only fixture cloned from real
copied metadata, not a claim that those artificial duplicate rows existed in stable.
It transfers the real provider episode identities to the unreferenced shell to test
global uniqueness, while keeping MediaFile, Target, WatchItem, Follow, WorkFolder,
Download and DownloadFile facts unchanged.
The first existing-copy startup was interrupted by its own literal PID before
readiness; it is not counted as a successful HTTP run. Subsequent runs waited for
readiness. Final proof PIDs are recorded in the logs/process evidence.

## Unproven / deliberately not changed

No UI or browser changes were made; search navigation was verified through the
HTTP href, not claimed as browser coverage. No new real-title download, live cutover,
Jellyfin or full catalog benchmark was attempted. Two conflicting works both carrying
durable ownership/intent are refused rather than destructively remapped across modules;
that case was not present in the real Rick conversion and is not claimed repaired.
No unit tests were written.

## Cleanup

Dedicated proof servers are stopped by their recorded literal PIDs. Both data/media
copies and build directories are removed. The isolated worktree is removed after
the commit is integrated; `cleanup.json` records the actual final checks.
The branch is retained. `tools\.gitignore` and other agents' changes are untouched.
