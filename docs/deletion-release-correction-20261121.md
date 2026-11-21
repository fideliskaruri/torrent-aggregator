# Deletion release correction record — 21 November 2026

Bounded correction track of flow-first-ui. Owner authorizes finishing audio/deletion fixes, publishing a release and then using the installed app updater. Original data stays outside testing; feedback tabs remain untouched.

G0/G1: Downloads selection → existing confirmation → Delete with files. Preserve current appearance, labels, scopes, cancellation, and button-specific busy/finally behavior. R23,R52,R53,R80–85,R94,R96,R100–105 apply. Supplied stuck-dialog screenshot and released source establish the failure; generated engine fixtures establish repeated per-episode work.

G2/G3: Confirm → submitting → full success: close and refresh. Confirm → partial/server failure: refresh facts, remove only resolved IDs from selection and confirmation, keep failed IDs retryable, show existing concise error. Transport unknown: refresh without replaying the destructive command; repeat confirmed removal is idempotent. Cancel/Close/Escape retain their existing pre-submit semantics and source ownership. No extra results screen or acknowledgement.

G4/G5 source bridge: use-download-management-actions.confirmDelete → use-download-row-actions.actionMany → POST /api/client/torrents → DownloadsApi.DeleteFilesBatchAsync → TargetPipeline.DeleteCapturedFilesAsync → existing gated physical deletion. Reuse current hook, toast and confirmation; no new component. Current graph index app/docs/graphs/README.md inspected; direct source tracing supersedes unrelated historical graph references for this slice.

G6/G7: Research and new visual foundations N/A: no new visual choice. Reuse existing accepted confirmation/toast/system at all widths. Existing source and owner contract specify expected partial feedback; no style or navigation change.

G8 critique: do not clear all selection on partial success, leave known-success IDs in retry, blindly retry unknown commands, or hide failed files. Do not show a successful-deletion report. Retain the submitting control geometry and finally reset.

G9 in progress: smallest hook correction and backend result contract. G10/G11 pending: actual generated-data success/error/retry/cancel at390/768/1280, settled screenshots and console. G12 pending: release evidence and limits.

Performance scope is intentionally narrower than the earlier full subsystem proposal: per-hash exact batching, guarded failure/restart and reduced redundant checkpoints. Historical final-path SHA re-verification is retained; a path-only cache would weaken replacement protection. Native verified-handle rewriting and broad global-lock redesign are not claimed complete. No timestamp-based verification bypass, current-file override, or new deletion ceremony.

G10/G11 passed for bounded correction: actual app3997, generated15 downloads, Cancel/Escape, locked second-file partial→14-item retry, unlock→empty list.390/768/1280 screenshots personally inspected and console0errors. No system redesign. Full evidence: release-0.4.2-verification.md.

G9–G12 complete for this bounded correction: actual generated-data confirmation/Cancel/Escape/partial failure/retry exercised via headless MCP,390/768/1280 screenshots inspected, zero console errors during the flow. Published/installed0.4.2 verification in release-0.4.2-verification.md. Physical-device/screen-reader and owner real-payload acceptance remain not tested.
