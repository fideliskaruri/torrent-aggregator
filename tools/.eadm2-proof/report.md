# OPS-808: finish external torrents in place

## Root cause and fix

`LibraryRepository.BeginFilingAsync` reserved the source and destination
independently. External original-path bindings have identical partial/final paths,
so their second `FilePathClaim` violated the unique physical-key index. Bytes
finished, but the Library proposal and atomic Targets/inventory commit never did.

Store now deduplicates canonical physical reservations. Library recognizes
pending identical-path operations during restart and verifies the stored full
digest before recovering them as published. Engine's existing publication port
already skips `MoveFileAsync` when the path is unchanged. The usual opaque
filing proposal commits MediaFile, binding, operation and version-fenced Targets
completion together, releasing the one claim.

The reviewed public Targets external-admission port uses full hash-bound torrent
metadata, exact indexed original paths and confirmed catalog identities. Engine
atomically caches metadata before admission and explicitly rechecks existing
pieces. Store issues a narrow placement proposal: original bindings, Download,
Current associations, Targets and existing Import decisions commit together.
This also closes the admission/binding crash window and the review-release crash
window. No new schema, copied progress, WatchItems, journals or background services
were introduced. Existing removed intent is revived under version CAS.
Reservation failure leaves no new admission rows or payload changes. An Engine
open failure after acceptance retains durable Waiting/Paused intent for existing
recovery, rather than losing the confirmed handover.

Api only composes the scanner, Library review and public Targets port. Optional
`selections` and `paused` retain the previous count/error HTTP response shape.
Existing complete-file adoption remains intact. The experimental `blocked-src`
files were removed; none of their obsolete Engine metadata-readiness code was
copied over the shipping implementation.

## Real HTTP evidence

Only receiver HTTP **3963** was used, with fresh isolated data directories and
`TorrentFlow:Scheduler:Disabled=true`. The worktree was detached at `rebuild`:
Git refused checking out the already-used branch at the requested second path.
The direct-folder Seeder is an isolated copy of `tools\.jelly-proof\Seeder`,
with `CreateContainingDirectory=false`. Both torrents verified **494/494 pieces**.
Every payload is a copy of the licensed Blender Sintel seed; the seed was never
modified.

Full SHA-256:
`1dc6f2ca9762dfcc7d1b1843129a3e4f351d1fe935dea2241c7b359c11ebc1d8`.
Expected size: **129,241,752 bytes**.

| Case | Result and evidence |
|---|---|
| Fake qBittorrent native backup | Half-length original copy; `fixtures.json`, `sources-before.json` |
| Missing catalog pick | Failed with Import guidance, no speculative ownership; `explicit-pick-required.json`, `review.json` |
| Explicit paused admission | One Download; original paths retained; `request.json`, `admitted-paused.json` |
| Actual piece recheck | **64,487,424 verified existing bytes** retained; `recheck.json` |
| Repeat unfinished selection | Skipped, no second Download; `repeat.json` |
| Restart while unfinished, then finish | Real recovery/resume and transfer tick; `recovered.json`, `resume.json`, `completed.json` |
| Original-path integrity | Unmoved original filename exists and full SHA-256 matches; `integrity.json` |
| Ownership without copied watch intent | Watchlist owns Sintel and title reads owned; `watchlist.json`, `title.json`, `shipping-database.json` |
| Completed process restart | Same single Download, Done target, inventory and ownership; `restart-targets.json`, `restart-watchlist.json`, `restart-title.json` |
| Prior removed intent | Real acquire/delete HTTP followed by explicit handover; `removed-intent-before-handover.json`, `crash-admitted.json` |
| Atomic admission failure | SQLite fault before binding insertion leaves zero Downloads/bindings/associations, the prior Removed target unchanged, and unchanged original bytes; `admission-atomic-rollback.json` |
| Interrupted in-place filing | Fault before inventory insertion leaves one Pending operation, **one physical claim**, no MediaFile and the complete original untouched; `crash-pending.json` |
| Restart pending filing | Stored-digest recovery commits one MediaFile, Done operation/target and zero remaining claims, with matching SHA-256; `crash-recovered.json`, `crash-atomic-result.json`, `crash-title-owned.json` |
| Shipping restart, no proof hooks | Ownership remains and `/api/proof/tick` is **404**; `shipping-no-hooks.json`, `shipping-watchlist.json`, `shipping-title.json` |
| Reimport after completion | Skipped; still one Download and one MediaFile, zero WatchItems; `shipping-repeat.json`, `shipping-database.json` |
| Ordinary non-in-place Sintel | Actual `.partial` publication to `Movies\Sintel (2010)\Sintel.mp4`, matching full digest; `normal-admitted.json`, `normal-completed.json`, `normal-integrity.json` |
| Ordinary shipping image | No proof route in the image used for the final normal download; `normal-shipping-no-hooks.json` |
| Seed unchanged | Final original seed digest and size match; `seed-final-unchanged.json` |
| Backend and Converter | **0 warnings, 0 errors**; `build-shipping.log`, `converter-build.log`; no schema/migration changes |

The scheduler-disabled host used a proof-only HTTP adapter to invoke the existing
Targets transfer recovery/tick methods, without fabricating rows, file completion
or a second pipeline. Its source is retained as `ExternalProof.cs` here only.
It was removed from the isolated Api project before the shipping build and
shipping restart/normal-file verification. SQLite triggers are proof-only fault
injection, not shipping hooks.

## Review, scope and unproven

Self-review checked canonical claim identity, digest recovery, atomic target and
inventory CAS, atomic admission/review decisions, unchanged legacy commit-receipt
hashing, metadata readiness preservation, rollback without unlinking foreign
files, removed-target revival, and exact staged scope. No web or Metadata source,
Store schema, real client installation, 3930, stable directory, or forbidden
service port was changed. `tools/.gitignore` was left alone.

Not independently rerun: Transmission unfinished admission, multi-file/sidecar
handover, native temporary-suffix filenames, every concurrency interleaving,
and Engine-open failure after a successful reservation. Continued seeding and
metadata-less handover are not implemented. Web finishing controls are outside
the permitted scope. Independent coordinator QA remains.

Existing fresh-database/missing-web-build runtime warnings remain; the compiler
and Converter builds have zero warnings. No unit tests were added.

## Persistence and cleanup

The source/report commit has `Refs: OPS-808` and no Co-Authored-By trailer.
Its SHA is recorded in the adjacent `commit.txt` and the task handoff.
`cleanup.json` records stopped literal PIDs and removal of the isolated worktree,
build/seeder output, fresh databases and copied payloads. Only proof scripts,
JSON, logs and this report remain here. Nothing was pushed.
