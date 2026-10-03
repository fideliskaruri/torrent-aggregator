# OPS-853: provider episode ownership and reconciliation

Date: 2026-10-04 EAT. Implementation on rebuild: `211ba6d434fb63e92bef14efa7b61422de31062d`.
Baseline: `d8990e39ceaa237167b45f8399149b5105330ecd`. Targets and Converter code were not edited.

## Confirmed root cause

The real legacy snapshot has two separate Rick and Morty works:

- `rick-and-morty-2013` (`cmurncg9qbuom9jsyhu3rn32g`), anchored to verified
  TVmaze 216. Its TMDB 60625 link is **unverified** in the legacy database.
  Eleven converted coordinate-only Episode rows retain eleven Target and eleven MediaFile references.
- `series:rick and morty`, a converted CatalogEntry anchored to **verified** TMDB 60625.

TVmaze refresh found TMDB 60625 through its IMDb external ID and unconditionally replaced
the TVmaze episode listing with TMDB episodes. Persistence correctly demoted the conflicting
TMDB WorkLink to suggested, but still copied the other work's TMDB Episode identities into
the eleven referenced legacy rows. The global provider-episode unique index then rejected
those **UPDATEs**, because the TMDB work already owned the same identities.

This is not evidence that TMDB renumbered these real episodes. It is a Metadata ownership
violation: suggested enrichment was used as an authoritative listing. Blindly merging
the two saved works in Converter would override an unverified link and saved public keys.
The fix keeps the verified anchor and existing reference ownership instead.

Fresh isolated baseline startup reproduced **104 logged occurrences** of
`UNIQUE constraint failed: Episode.provider, Episode.providerEpisodeId`; these are log
occurrences, not 104 distinct episodes (`before.log`, `baseline-episodes.json`,
`legacy-Work.json`, `legacy-WorkLink.json`, `legacy-CatalogEntry.json`).

## Owning-module changes

1. Metadata checks existing verified ownership **before** replacing an anchor's listing
   with TMDB enrichment, in all three enrichment branches. Conflicting links remain
   suggested; the anchor's fresh native listing remains authoritative.
   Persistence also validates listing ownership under its existing commit lock.
   No new exception catcher or exception suppression was added.
2. Refresh reserves every provider-identity match before legacy coordinate/absolute
   matching. Each previous row is matched once. A known identity is not rewritten to
   another episode from the same provider.
3. Store vacates moving season/episode coordinate slots inside the existing transaction
   before EF applies the final permutation. Stable episode IDs and foreign keys survive
   swaps and season moves; temporary numbers are never committed as catalog facts.
4. The `EpisodeAvailableCoordinates` migration limits season/number uniqueness to
   mappings other than unavailable. An obsolete **referenced** identity remains
   unavailable at its old coordinate; its replacement can occupy the active slot without
   reassigning the old file/target. Provider identity uniqueness still covers **all** rows.

Store had no module README; its existing documentation is in `backend/README.md`, updated
alongside Metadata's README. There is no Targets code change and no duplicate truth store.

## Isolation and real-data proof

The requested `git worktree add D:\code\memtest\wt-epid rebuild` refused because rebuild
was already checked out. Used `git worktree add --detach D:\code\memtest\wt-epid rebuild`.
API output: `D:\code\memtest\bin-epid`; separate Converter output:
`D:\code\memtest\bin-epid-convert`.

`prepare.py` opened stable's database with SQLite **mode=ro**, then used SQLite backup
to include committed WAL data and copied its side files to `epid-data\source`.
All actual media bytes were copied from `D:\Torrents` into `epid-data\media`,
without links/junctions. Converter used the reh3 path-map procedure. All **57 operative
absolute paths** are confined to the isolated copy. The source snapshot database SHA-256
is unchanged after all conversion/proof operations. All **76 payload SHA-256 pairs match**;
original lengths/mtimes remained unchanged during hashing.

Only application HTTP port **3967** was used, plus the authorized issue tracker on 3960.
No live HTTP call, stop, restart or reconfiguration occurred. Live PID **3188** retains
its original start time. TMDB's key was injected only through child ProcessStartInfo
environment; neither arguments nor proof files contain its value.

Baseline process: 59904. Preliminary fixed process: 43680.
Final fixed processes: 63364, 63324, 49896, 37000, 58972.
All stops used these literal PIDs. The two fixture restarts were followed by restoring
the exact pre-fixture database, then **two clean real-data restarts** (37000, 58972).

| Check | Result |
|---|---|
| API and Converter final builds | PASS: **0 warnings, 0 errors** |
| EF model/migration consistency | PASS: no pending model changes |
| Fresh converted fixed startup and all five final starts | PASS: **0 UNIQUE errors, 0 logged errors** |
| Two clean real-data restarts after fixture restoration | PASS: all file/intent/review/follow rows byte-logically unchanged |
| Legacy videos exclusively owned or pending review | PASS: **25 = 14 owned + 11 reviews**, exact same states as reh3 |
| Ownership composition | PASS: **12 retained downloads + 2 imported** |
| Legacy downloads / targets / file bindings | PASS: **30 / 90 / 12**, all IDs and download hashes retained |
| Existing watch items / follows | PASS: **2 / 2**, unchanged |
| SQLite integrity and foreign keys | PASS: `ok`, zero FK failures |
| Global provider episode identities | PASS: zero duplicate identities |
| Real-provider renumber/season-move fixture over real referenced rows | PASS: two episodes swapped and a third moved between seasons, then refreshed back; **11 Target + 11 MediaFile pointers unchanged** |
| Real-provider replacement fixture | PASS: old referenced identity unavailable, distinct current identity occupies its coordinate; all pointers unchanged |
| Converter repeat | PASS: “Already converted. No changes made.” |

Fixture SQL changes exist only in `fixture.py`, never in production. Both fixtures use
real HTTP title reads and the real Store/database/provider refresh, not unit tests or mocked
catalog answers. Their database changes were restored before final real-data checks.

## Episode lists against actual TMDB answers

`tmdb-native-60625.json` and `tmdb-native-1434.json` record raw identity, coordinate,
name and date fields from successful season responses in the production metadata cache,
without credential-bearing keys or unrelated cast/crew data.
`compare.py` checks every regular season over HTTP, not just stored row counts.

| Work | Regular episode coordinates | HTTP seasons | Specials |
|---|---:|---:|---|
| `rick-and-morty-2013` (verified TVmaze anchor) | **91/91 match TMDB**, no missing/extra | 9 | TVmaze supplies 0; TMDB supplies 37 |
| `series:rick and morty` (verified TMDB anchor) | **91/91 match TMDB**, no missing/extra | 9 | **37/37 match** |
| `family-guy` (verified TMDB anchor) | **456/456 match TMDB**, no missing/extra | 24 | **28/28 match** |

TVmaze's regular Rick list has three provider-native punctuation/capitalization differences,
recorded explicitly in `tmdb-comparison.json`; these are not coordinate differences.
It does not claim TMDB's specials as its own. The TMDB work retains the full TMDB special list.
Both downloaded and imported media retain their saved identities.

## Limits and cleanup

No live cutover, playback, Jellyfin scan, new acquisition or UI was exercised.
Nonempty requests/rules and active acquisition deferral were not exercised (the snapshot
has zero requests/rules and no active acquisitions). Distinct legacy work keys were not
automatically consolidated. The primary TMDB path is verified; AniList/Cinemeta enrichment
ownership branches share the check but were not independently forced into a conflict.
Rollback of the new filtered index with overlapping unavailable rows is not certified.

Cleanup removes all copied data, API/Converter outputs, supplemental build output, fixture
database and isolated worktree. `cleanup.json` records the final actual checks.
Only source changes and `tools\.epid-proof\` evidence are committed, with `Refs: OPS-853`.
`tools/.gitignore` is untouched.
