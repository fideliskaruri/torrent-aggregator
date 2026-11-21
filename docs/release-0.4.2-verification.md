# Audio and deletion release verification — 21 November 2026

Release candidate 0.4.2 combines the independently reviewed anime audio repair with the bounded deletion performance correction, based on published 0.4.1. Original app/UI development checkout remains untouched. Owner authorized publishing and then installing through the app updater; no installed changes have happened during testing.

## Reviewed behavior

- Audio: exact-hash Nyaa uploader audio evidence, complete eligible English search before genuine Japanese fallback, conservative handling of unknown/failed detail requests, subtitles, commentary, negation and per-episode pack claims. Public listing claims are not actual stream proof. Exact T3KASHi French/Japanese is excluded and YURASUKA English/Japanese is selected by real pipeline fixtures. APiBay English Dub identity/query case fixed without weakening episode/quality/seed checks.
- Deletion: validate full selection before mutation, normalize/deduplicate hashes, preserve case-sensitive targets, capture/recheck bindings/links/target/download versions, one selected index union per torrent. Keep earlier kept files and alternate copies. Known removed selectors are idempotent without engine work.
- Selected rows remain visible on interrupted removal. Hash-scoped durable holds guard normal actions, admission, startup and tick recovery, including zero-binding interrupted cleanup. The existing check-constraint migration is generated together with the designer/static model. No new history or payload timestamp bypass.
- Stop failures are truthful. Surviving files recover once when needed. Per-hash checkpoints remain durable; only the redundant final whole-torrent save was removed. Historical final-path checksum re-verification remains deliberately intact rather than caching a path result across the batch.
- Partial responses retain submitted bare/suffixed IDs and only confirmed earlier groups count as resolved. UI refreshes on every outcome and removes only confirmed successes from retry. No new results modal, report or forced acknowledgement.

## Evidence

96 audio assertions passed independently in both audio and combined checkouts. Real Sources/Find/Plan/DiscoveryPlan with HTTP provider fixtures, disposable SQLite and fixture metadata engine. Backend and web builds passed. Corpus accuracy/mismatch output matched the baseline; 17 pre-existing parser gate mismatches remain outside this change.

Deletion harness uses actual MonoTorrent, generated allocated files and private loopback peers. It first migrates a populated released schema, checks target/binding preservation, then invokes the real DownloadsApi command via HTTP. This is not a media-content or installed-drive test.

| Profile | Runs | Median request | Maximum | Drain / recover / global-save counts |
|---|---:|---:|---:|---|
| Entire active 14-file pack | 5 | 441.43 ms | 475.43 ms | 1 / 0 / 2 (baseline 14 / 13 / 29) |
| Delete14 of16 active pack | 5 | 649.58 ms | 721.76 ms | 1 / 1 / 2 (baseline 14 / 14 / 28) |
|14 independent torrents | 5 | 1375.49 ms | 1406.12 ms |14 / 0 /28 (baseline14 /0 /42) |

The active subset's remaining cross-piece files finished and their SHA256 matched. Deleted public paths were not recreated. Kept-file and uppercase/duplicate/whole+episode overlap fixtures passed. Invalid last selector and unsupported current-file override produced zero mutation. Locked-file partial deletion kept selected rows, rejected unrelated actions, suppressed stale cached restart and allowed one-item retry without reviving other held work. Cross-hash failure returned the exact resolved bare ID, retained the failed file and accepted an idempotent retry.

Actual app3997 used generated disposable data. Headless Playwright MCP drove selection→confirmation→Cancel and Escape, then15-item delete with second file exclusively locked: first succeeded, confirmation shrank to14, releasing lock and retrying ended on an empty list. Screenshots390/768/1280 inspected; no console errors. Fixtures had an unavailable storage-root marker, so no live source/peer acquisition was claimed through that UI. The actual engine tests separately establish active deletion behavior.

The final error-copy correction shortens lock/permission errors. Packaged binary/installer, embedded revision, checksum, updater discovery and installation results are recorded below when executed.

## Scope limits

Measured fixtures are approximately1MiB per file. Results do not establish the installed180.5-second request's exact stage split, arbitrary drive throughput or constant-time deletion of large finalized files. The original full architectural proposal's native verified-handle rewrite, per-manager tracked piece-writer barrier and broad global-lock redesign are not claimed delivered. This release targets demonstrated repeated work while retaining existing file-verification semantics. Physical phone/screen-reader verification and real anime payload/swarm checks were not performed.

## Release checks

Pending: final candidate build/tests, packaged smoke, installer/hash/assets, publish, then authorized in-app update.

### Published and installed result

- Full Release backend build: zero warnings/errors. Web TypeScript/Vite production build passed. EF reports no pending model changes.
- Product commit:38b4a480a91bad81304150a400fd83643207def1; release branch fix/deletion-performance pushed. Audio source commit in combined history:d99f7da.
- Windows packaged binary reports0.4.2+38b4a480a91bad81304150a400fd83643207def1. Disposable3996 health, served SPA, desktop version and empty downloads API passed; updater recognized published0.4.2 with installer and no error. Test process stopped.
- Installer compiled with Inno Setup. The initial manual invocation used slash-formatted SourceExe, which Inno's path extractor did not accept; recompiling with the resolved native Windows path succeeded. This was a packaging invocation correction, not a product change.
- Published https://github.com/fideliskaruri/torrent-aggregator/releases/tag/v0.4.2 with installer38,897,763bytes and portableZIP52,603,658bytes. Local and GitHub digests match:
  - TorrentFlow-Setup-0.4.2.exe SHA25665931ee52cc8e5cba10fe9cfcb4fd511ec19c87552a25d8c41cf09a6bd365e49
  - TorrentFlow-0.4.2-win-x64.zip SHA256aa424d85f7d35a632333293e16b9d243b4cdfd2763ed4d696215283237cec646
- The tag triggered redundant Windows/Docker remote workflows. Both were cancelled after checking their exact product SHA, to retain the locally tested assets and avoid unnecessary duplicate builds. This does not represent failed product validation.
- Owner explicitly authorized the normal installed-app update after publication. In an isolated headless browser, opened installed Settings→App→Check now→Update to0.4.2. The updater downloaded/verified the installer, restarted, and the UI now reports0.4.2/You're up to date. Original feedback tabs and source checkout were not operated on.
- Installed GET/api/health is live. Installed/api/desktop reports0.4.2, idle update state, no update error. Installed ProductVersion matches the product SHA and the installed executable SHA256 equals the locally tested executable exactly. No installed download/delete/source-selection command or manual original-DB/media operation was used for verification.
- Browser console was clean during generated-data deletion tests. After intentionally stopping the preview and during the normal installed-app restart, polling generated expected connection errors; these are not reported as clean-console intervals.
- Real anime payload/audio and real-drive bulk deletion still require the owner's acceptance test. No existing download was automatically replaced by this repair.

Final scope status: requested audio/deletion release and normal updater installation complete. The earlier broad deletion architecture proposal remains historical design work, not a claim that all of its separate native-adapter/global-lock experiments shipped.
