# 0.4.5 download lifecycle and season switching

## Scope and acceptance

Windows download lifecycle correction on the 0.4.4 release baseline. Preserve acquisition, English-audio policy, quality floors, storage settings, existing ownership and the installed application's data. The owner authorized publication and installation after disposable verification. Unrelated UI integration work is not included.

## Changes and critique

- Read APIs consume immutable engine observations; polling cannot stop/flush a transfer or wait for the engine's disk-work gate.
- Transfer ticks capture engine/binding collections once, use grouped lookups and refresh only affected target rows after state changes.
- Finishing persists Pending operations/path claims before drain. It verifies authenticated torrent pieces and SHA-256 under file-object guards, then rechecks current intent/bindings before publication. Video and sidecars commit inventory together. Healthy targets finish independently of locked siblings.
- Interrupted rename recovery requires the persisted digest and Windows file identity. Equal-size/header or even byte-identical foreign destinations are never adopted. File and parent-directory handles prevent substitution through rename/delete.
- Deletion cancels/waits for its own finishing task, holds an automatically retired per-download lock and releases shared transfer/state gates during physical I/O. Legacy completed files are read once instead of twice; ownership checks remain. Interrupted rename deletion reconciles its verified receipt.
- Plain torrents use the same journal/identity principles, bounded background finishing, persisted retry delay and atomic completion. Completion work is joined during bounded shutdown.
- Resume/priority retry retains the finishing stage instead of sending completed data back to acquisition.
- Verification handles v1, padded v1, hybrid and pure-v2 physical/piece layouts. Bare v2 identities and action/Open selectors accept 64-character hashes.
- Season-specific requests retain the same title identity and show scoped episode errors/retry; other title identities still clear old data.

Rejected shortcuts: trusting a stale Complete bit, treating a missing manager as verification, adopting an existing final by size/header, deleting without ownership validation, suppressing errors to leave Finishing apparently successful, and rewriting unrelated acquisition/UI functionality.

## Evidence

All payload and database mutation tests use generated disposable roots and private loopback torrents. Local detailed logs/screenshots are intentionally not release assets.

| Check | Evidence |
|---|---|
| Actual target filing | 14 targets Done; 14 readable final files; independent source SHA-256 matches |
| Active pause/resume | Actual target commands plus transfer tick resume the same partial payload, then all episodes finish |
| Pause/remove during verification | Intent survives; no inventory for a removed target; paused finishing resumes as Filing |
| Failed drain | Pending receipts retained, no final media published; detached retry verifies and completes |
| Locked sibling | Unrelated episodes finish; detached locked retry remains transient; unlock permits completion |
| Video + sidecar interruption | Mixed partial/final paths recover as one target without partial inventory |
| Real process restart | Audit process exits between rename and inventory; new process completes 14 episodes without a seeder |
| Raw restart | Fresh process recovers a constructed mixed-rename boundary using genuine authenticated receipts; independently checked payloads |
| Raw completion/deletion | Background publication commits Done; actual raw removal clears files, claims and reservations |
| Foreign destination | Unowned identical destination neither adopted nor deleted |
| Native identity | Writers/ancestor replacement denied; identity survives rename/reopen; exact guarded file deleted |
| Formats | v1, padded v1, hybrid and pure v2; zero, short and multi-piece files; independent SHA-256 |
| Read purity | Five actual reads do not stop/flush; read returns while engine gate deliberately held |
| Deletion cases | Full/subset pack, locked retry, partial independent batch, keep-files preservation and stale-preview rejection |
| Shared-lock responsiveness | Unrelated command completes in 29–32 ms with deletion's drain held |
| Legacy deletion I/O | 2 MiB payload: one SHA call / 2 MiB, previously two SHA calls / 4 MiB |
| Many small files | 256 files / 65,792 payload bytes: reads reduced from 16,777,472 to 131,071; piece passes 257 to 2; measured 232 ms to 35 ms |
| Cache-disabled loopback | 12 files / 12,593,598 bytes verified; first bytes 302 ms, transfer 441 ms, drain 14 ms, zero open payload handles |
| Actual isolated UI | 14 Ready episodes; Open endpoint succeeds for playable media; Cancel preserves all; Delete returns to empty list and removes payloads |
| UI deletion timing | Disposable 58 MiB pack: request 1.52 s; drain + verified physical removal 477 ms. Not a comparison against a larger real download |
| Season switch | Real release-worktree components retain the same hero/picker during delayed reads; stale season episodes excluded; error/retry tested |
| Static | Backend build, TypeScript, web build, season identity assertions and diff whitespace checks |

One private-loopback raw fixture attempt timed out before acquisition completed; a fresh run completed and passed separate-process recovery. It was not counted as a passing case. A stack capture attempted after the bounded test exited found no running process. Public-swarm reliability, physical-phone testing and other operating systems are not established by these Windows loopback checks.

Playable fixture source: Blender Foundation's [Sintel trailer](https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4). The downloaded sample is local test data, not committed or included in the application.

## Delivery gate

Source regression verification precedes packaging. The exact packaged executable must be smoke-tested with separate application data/port before publication. Release assets must be checksummed, then the installed updater must report the new version and healthy runtime. These delivery checks are recorded locally after execution; this document does not predeclare installation complete.
