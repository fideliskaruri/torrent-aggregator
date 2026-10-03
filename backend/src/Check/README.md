# Swarm Check

`ICheck.ProbeAsync` submits a fixed batch; `ProbeStreamAsync` accepts arriving candidates
and emits measured results in completion order without waiting for discovery to finish.
One singleton publishes hash flights before starting them. Owner work precedes queued
background work (maximum two background checks); one waiter's cancellation detaches only
that waiter, and the last waiter cancels measurement without persisting it.

Check depends only on Domain and Engine. It reads the Domain `ICheckRepository` port.
Targets' composition wrapper commits returned persistable evidence through that port;
Check itself never commits Verdict or alters Target state. Store keeps file lists on
Release and delivery/sender measurements on Verdict in one transaction. Cached reads
bulk-load file lists, correct expired/version-invalid measurements to Unknown, and never
reuse a live transfer snapshot.

The existing engine settings configure `CheckWindowSeconds` (20), `GoodBytes` (256 KiB)
and `GoodBytesPerSecond` (64 KiB/s). Additional host settings under `TorrentFlow:Check`:
`Slots` (10, physically capped at 10), `BackgroundSlots` (2, capped at 2),
`QueueWaitSeconds` (60), `MinimumGoodSeconds` (4), `VerdictHours` (6),
`UnknownMinutes` (45 for wanted work; speculative Unknown uses VerdictHours),
`ProbeVersion` (1). Every new probe reads current engine settings.
Healthy/Dead cache versions fingerprint those thresholds and the algorithm version:
changing thresholds invalidates old classifications immediately without discarding
permanent file metadata. Unknown caches retain their algorithm version; wanted callers
never reuse a speculative Unknown beyond the wanted 45-minute lifetime.

Attachment and observation share the window; queue/capacity wait is reported separately.
When Engine supports `IProgressiveProbeEngine`, Check supplies the stopping predicate
for each physical sample. Good stops as soon as files are known, no hash failures are
present, a byte-sending peer has delivered at least the configured bytes/rate, and at
least four seconds (or a configured longer minimum) have been observed. Weak, Dead and
Unknown retain the full observation budget. Other engine implementations use the
existing full-window path. Completion logs report hash, band, end-to-end time to verdict
including queue wait, and queue wait separately. Publication follows cleanup unless admission
retention was explicitly requested; cache fingerprints and expiry are unchanged.
Good requires a hash-bound file list, validated bytes, and a byte-sending peer. Dead
requires metadata, the full observation and connected peers in **every** sampled interval,
at least four seconds long, with no byte sender or valid payload. Missing metadata, transient peers, ownership,
capacity or transport failures are Unknown, never a guessed Dead. No tracker scrape is
required to start measurement; listed/scraped seed counts never establish viability.
Rejected or malformed torrent metadata returns Unknown rather than failing the batch.

Probes are released with drained engine cleanup by default. Pipeline admission can
explicitly set `ProbeRequest.RetainAdmission` to keep the engine's 30-second capability;
the consumer must admit or release it, and it cannot be reused by duplicate waiters.
Long metadata waits are the existing `IEngine.AttachMetadataWaitAsync` capability:
three hashes per target, shared physical hash manager, ten global attachment slots,
45-minute maximum, metadata only, outside the payload cap. The future Targets worker
chooses the top Unknowns after all eligible alternatives are exhausted and owns durable
WaitingForSeeders/T39 transitions; Check does not autonomously create durable intent.

Development-only owner/loopback routes:
- `POST /api/dev/check`: `{ candidates: [{ hash?, magnet?, name?, listedSeeders?, torrentUri? }],
  forceFresh?: boolean, background?: boolean, stream?: boolean }`.
- `GET /api/dev/check?hashes=<comma-separated hashes>` or `?limit=100`: persisted evidence.
- `GET /api/dev/check/status`: queue, shared-flight and physical-probe counters.
- `POST /api/dev/check/metadata-wait`: `{ targetId, hash?, magnet? }` and
  `GET`/`DELETE /api/dev/check/metadata-wait/{token}` expose the existing engine wait
  capabilities for isolated diagnostics only; they do not create Target or Download rows.

`python tools\bench\check-proof.py` checks the real sources and swarms on isolated port
3948. Evidence is gitignored under `tools\.check-proof`; no unit tests or full downloads.
# Cached file evidence and admission (OPS-806)

Cached evidence carrying a file list is reused only while Engine can still supply
the corresponding complete, hash-validated torrent information. File names and
lengths are not a substitute for the torrent's piece hashes. Both bulk cache reads
and individual probe requests apply this check; missing information sends the
candidate through the existing bounded check rather than repeatedly admitting an
unbound magnet. Engine retains this information when releasing a successful probe.

## Uncovered warm plans (OPS-751)

A completed, persisted verdict is reused by hash before Check queues a flight,
including Unknown within its configured lifetime. The isolated HTTP controls in
`tools\.enghealth-proof\report.md` measure this independently of discovery:
repeat checks must retain `checkedAt`/`expiresAt`, report `fromCache`, and add
no physical probes. Good/Weak/Dead use the six-hour lifetime; wanted Unknown uses
45 minutes. These are verdict lifetimes, not a completed-plan cache.

Targets' planning deadline can cancel unfinished flights. Cancellation deliberately
does not persist an unmeasured verdict, so those hashes remain eligible next time.
Reusing an uncovered scope's prior bounded decision and retry/stopping budget is
Targets' responsibility. Check must not turn a canceled partial observation into
Good, Dead or a six-hour refusal to measure. A warm planning-window timeout alone
is not evidence that Check bypassed a valid cached verdict.
