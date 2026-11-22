# Download lifecycle hardening — 21 November 2026

22 November renewed authority: owner requests finishing these fixes plus the season-switch patch, isolated full-flow verification, then publication and installed update. Installed text logs/health may be read for the current slow-deletion diagnosis. Destructive regression work remains restricted to generated isolated data. Publish/install only after acceptance, not as a test substitute.

Scope: resolve all findings from finishing-astra-review-20261121.md and verify the resulting end-to-end downloader. Preserve source selection, audio/quality policy, shared packs, queues, Settings, existing data and file ownership. Work in this isolated checkout. Latest owner instruction requires disposable tests; installed app is not a test fixture for this work. No season redownload. A rewrite is permitted only when it reduces proven defects; existing admission/queue contracts remain useful.

## Acceptance checklist
- [x] Reads only observe state: Downloads polling must not stop/flush/reconcile transfers. Worker owns transitions.
- [x] One coherent engine/binding snapshot per transfer tick, refreshed only after a mutation that invalidates it. Avoid full scans per download.
- [x] Deleting one torrent waits only for that torrent's filing and never holds the global transfer gate while awaiting another task.
- [x] Bound expensive checksum work; preserve cancellation and command responsiveness.
- [x] Reuse FileOperation/FilePathClaim journal for completion. Persist Pending before stop; Verified only after actual hash-completion proof, successful drain and source digest. Missing snapshot is not proof.
- [x] Restart/failed-drain recovery must obtain real verification or use an authenticated durable receipt. No fabricated all-pieces-complete snapshot.
- [x] Rename retry validates recorded digest and file identity, never accepts an arbitrary matching-length/header final file. Conflicts do not overwrite/delete foreign content.
- [x] Finish healthy targets independently; video+sidecars for one target commit together. A locked sibling remains actionable and retries without repeating successful work.
- [x] Raw torrent publication uses the same durable handoff and identity contract, including interrupted rename and failed drain.
- [x] Pause/remove/replace during checksum cannot resurrect a removed target or publish under stale ownership.
- [x] Completion/deletion checks read a file once where one guarded verification can serve all required checks; do not cache unchecked path results across mutations.
- [x] Error diagnostics retain actual operation, file index, exception/HRESULT and scoped recovery. No generic claim that another app owns every failure.
- [ ] Existing released-schema fixtures upgrade/replay without losing bindings, files, quality preferences or removal holds.
- [ ] Entire real HTTP/headless journey: download, status, pause/resume, completion/Open, source replacement, single/subset/whole delete, partial failure/cancel/restart. Films, episodes, packs and raw torrents.
- [x] Counter/latency evidence for poll reads, scan counts, digest bytes, unrelated delete, bounded concurrency and cache-disabled throughput. Record limits honestly.

## Source ownership and contracts
Targets owns acquisition/target intent and lifecycle. Engine owns payload bytes and verified pieces. Library owns reserved paths, identity, file operations and inventory. Store owns atomic compare-and-save. Read APIs project facts; they do not drive the engine. No second status database or staging filesystem.

Existing journals: Domain/Records.cs FileOperationRow (Pending/Verified/InventoryCommitted/Done), FilePathClaimRow; Store/LibraryDownloadRepository.cs compare-and-save and ProposeFiledAsync. Existing deletion holds and retiring pack bindings remain authoritative. A verified operation must record download, binding/source/destination identity and digest before rename; final inventory and operation completion are committed atomically. Legacy in-progress bindings without receipts require verification, not silent trust.

## Delivery sequence
1. Regression fixtures and measured read/lock work removal.
2. Durable completion protocol plus per-target publication, recovery and state races.
3. Raw publication and guarded deletion verification reuse.
4. Complete regression/device/HTTP matrix, independent critique and final report. Track remaining boxes honestly; do not equate generated tests with actual source/swarm proof.

## Owner clarification — isolated installation and value gate

The owner now permits installing candidate builds into a dedicated isolated instance. This does not authorize updating, restarting, or testing against the installed personal application. Use separate executable output, application data, SQLite database, settings, cache, logs, port and generated/disposable media. Never attach original download roots or copy live credentials into the fixture.

For each retained change record: reproduced defect or measured baseline; specific hypothesis; regression that fails without the change; fresh passing result with the change; relevant negative/race cases; measurable cost or performance benefit. Source review and a successful build alone do not establish effectiveness. Reject unnecessary rewrites and record unresolved review blockers before expanding the implementation.

Historical pre-verification checkpoint: the prototype was unaccepted. The independent review identified file-substitution, stale intent, interrupted rename/deletion, raw publication and metadata verification issues. Partial passing harness cases do not clear these blockers.

## 22 November verification checkpoint

See docs/release-0.4.5-verification.md for executed cases and measurement limits. Source-level and isolated behavioral checks passed. The broad all-media/all-device HTTP matrix remains incomplete: actual headless HTTP exercised generated series episodes, Open, Cancel and bulk deletion; raw/film-equivalent and race cases use actual backend service harnesses. No physical phone or public-swarm result is asserted. Packaging, publication and installed-version confirmation are separate pending delivery gates.
