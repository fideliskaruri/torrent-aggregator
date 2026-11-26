# 0.4.6 — finishing, latency and Requests removal

## Cause and correction

- A completed selected file could share a torrent piece with an unselected sparse neighbour. The verifier incorrectly required the neighbour's entire final length. It now requires every byte actually touched by the authenticated piece, retains selected-file exact length and every piece hash, and refuses corrupt/missing boundaries and linked paths. This is not permission to trust incomplete selected data.
- Queue construction performed download × target × link scans. Indexed joins retain ordering, eligibility and Now flags while removing that repeated work. Transfer projections omit diagnostic attempt payloads; swap recovery queries its relevant persisted attempts explicitly. Downloads limits release reads to referenced hashes. Wanted uses one snapshot.
- Notification badges previously built and serialized all Downloads. They now use an authenticated SQL count, one shared visible-tab poll, and immediate invalidation after inbox actions. The inbox projects only its visible user page and required poster associations; removed/stale links and raw inventory have explicit tests.
- Payload digest I/O uses bounded large sequential reads instead of tiny unbuffered reads. Full guarded content verification remains before deletion. An attempted identity/timestamp-only shortcut was rejected during independent review and removed; edited files with restored timestamps must still be refused.
- Storage probes consume fast initial results immediately, poll every2s, retain root-version/marker protections and one pending probe per root. Storage UI polls faster while a location is offline and pauses polling while hidden. It still validates returned storage before resuming.
- Requests submission/inbox/review/reconciliation and UI implementations are removed. Legacy command routes return410 and old page URLs redirect to Browse. Accepted targets, automation, notifications, schema rows and read-only shared access remain; guests receive no new permissions.

## Measured generated workload

601 downloads /614 episode rows,5601 releases,10000 diagnostic attempts. Same local Windows machine and generated database. Sequential HTTP warm medians; cold startup is separate. Exact Downloads and queue JSON parity asserted before fixture mutation.

| Operation | Before | Candidate |
|---|---:|---:|
| Downloads HTTP |5480ms|261ms|
| Wanted HTTP |10080ms|27ms|
| Notification list limit1 |5585ms|5ms|
| New unread count |n/a|3–4ms|
| Queue construction |4147–4547ms|1–2ms warm,14ms first|
|512MiB guarded digest |949–1107ms|404–419ms|
|512MiB safe physical deletion incl digest |not separately measured|582–637ms, one full digest|
|Disposable folder offline detection |12433ms|5907ms|
|Disposable folder return detection |10190ms|4219ms|

The first candidate Downloads request was2035ms; warm performance is not a cold-start guarantee. Real headless browser requests were176–338ms during polling; a sampled route transition recorded one53ms long task. Both shell consumers shared one badge request per15s. This is not a full React Profiler attribution. The generated600 rows are grouped as one series in that screen check; do not claim600 distinct rendered groups or phone performance. Captures at390/768/1280 inspected. Folder rename simulates disconnect on the same volume, not physical USB mounting or a permanently hung OS call. No differently-sized real-media deletion is presented as an A/B speedup.

## Behavior and negative cases

- Sparse-boundary reproduction failed on the old verifier; correction passes independent SHA256 and torrent-piece proof. Real private-loopback selective download reaches Done. Corrupt/missing boundary and selected directory-junction refused. v1/padded-v1/hybrid/v2 and small-file cases pass.
- Real full target publication, sidecar interrupted rename, failed drain retry, pause/remove during verification, completed-source replacement, raw completion/removal, native handle guards and foreign identical destination refusal pass.
- New process recovers after controlled exit between rename and inventory:14 files Done and independent hashes match without a seeder.
- Modified same-object payload with restored last-write time refused before deleting siblings. No timestamp-based verification bypass remains.
- Persisted maximum-swap and recent-backoff guards hold with an empty transfer-history projection.
- Owner/guest notification count isolation, read-all badge event, title/hash poster association and raw inventory fallback tested. Browser sees no Requests controls; retired APIs refuse without acquisition. Cloudflare JWT integration was not re-tested; its role/origin guards were preserved.
- Backend/web builds and whitespace checks precede packaging. Exact package smoke and installed confirmation are separate delivery gates and are recorded locally after execution.

## Independent review resolutions

Terra reviewed source/evidence and identified the unsafe deletion shortcut, missing optional selected-path link check, and poster/recovery test gaps. Shortcut removed; restored-timestamp refusal added; selected link guard and actual junction negative added; poster and persisted-backoff cases added. Review was not represented as a runtime test or blanket approval. No unrelated UI integration was merged from the dirty main checkout.

## Release boundary

Owner explicitly authorized publication/installation after isolated verification. All destructive tests used generated paths. Do not automatically repeat previously failed destructive operations against original media; pending failed deletions remain explicit retries. The package must be checked in a separate data directory/port before publishing, then installed through the existing verified updater and checked for exact version/health. Public swarm, actual phone and physical-drive performance are not established by synthetic results.

## Executed delivery

Exact0.4.6+a9da544 package passed14 Ready episodes, native Open launched VLC, Cancel retained14, and Delete removed14 generated files and closed dialogs. Full delete HTTP1502ms; drain+verified payload removal276ms. Published assets match recorded SHA256 values. The installed updater completed; exact build health ready and installed web-index hash matched. Read-only installed Downloads warm reads improved from roughly5.5–5.9s to0.9–1.4s; wanted6.9–7.4s to0.33–0.39s. This observational production comparison includes changing background load and is not a controlled A/B experiment. No new finishing errors were observed in the checked new-process startup logs; that short observation is not a long-running reliability guarantee.
