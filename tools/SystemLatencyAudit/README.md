# System latency audit (Windows)

Disposable tests only. Never point these tools at installed data or media.

1. Run `dotnet run --project tools/FilingAudit -- --pipeline` to create the generated, authenticated loopback fixture. It records its root in `artifacts/lifecycle-hardening/last-filing-root.txt`.
2. Run `python tools/SystemLatencyAudit/seed.py`. This expands that fixture into 601 downloads / 614 episode rows, 5,601 releases and 10,000 large diagnostic attempts. Run only with the isolated host stopped; it resets its generated read-fixture database.
3. Run the API with separate `--TorrentFlow:DataDirectory <absolute artifacts/system-latency/read-fixture>` and `--urls http://127.0.0.1:3988 --no-browser --TorrentFlow:Scheduler:Disabled true`.
4. Measure actual HTTP requests for `/api/client/torrents`, `/api/wanted`, `/api/notifications?limit=1`, `/api/notifications/unread-count` and `/api/health`. Record cold/warm times separately, payload sizes, sequential versus concurrent load, and assert response parity. Do not substitute source review for those measurements.

Additional modes in FilingAudit: `--queue-cost` (same seeded DB), `--sparse-boundary` (selected/skipped boundary + corruption/missing/junction negatives), `--digest-speed` (generated512MiB), `--delete-cost` (same generated data, full digest on both legacy and identity-backed paths), `--swap-backoff`, `--notification-read` (after seeded owner/guest notifications), `--pipeline --selective`, `--pipeline --changed-delete --restore-mtime`.

For raw/target restart, native guards, subset deletion and failure injection, see the existing FilingAudit/DeletionAudit modes. These are executable regression harnesses, not claims of physical-phone, public-swarm or real-USB acceptance. Do not compare differently-sized payload deletion times as a speedup. Mutable timestamps are not sufficient proof to skip content verification; the candidate retains one full digest before deletion.
