# Test audit — drop mock/unit tests

Owner rule: unit tests are unreliable; mock-heavy suites passed while real flows broke.
Second pass: delete **all** unit/mock tests, including former REVIEW items, unless the test truly starts the real app/engine with real HTTP, real disk, or a real DB. Opt-in network (`TF_NETWORK_TESTS`) kept.

**KEEP** = WebApplicationFactory/Kestrel + real HTTP + temp SQLite, real MonoTorrent/disk E2E, or `TF_NETWORK_TESTS`.
**DROP** = single-class units, mocks/fakes/stub HTTP, pure string/format, internal snapshots, implementation details, no-host service tests.

## Summary (after second pass)

| Project | Kept files | Dropped | Notes |
|---------|------------|---------|-------|
| Api.Tests | 16 | 9 | Desktop/DataAdoption/DevJwks dropped (fakes/no host) |
| Core.Tests | 0 | 3 + project | Entire project removed from slnx |
| Engine.Tests | 19 | 12 | Layout*/DownloadRecovery/ExternalRoute dropped |
| Library.Tests | 8 | 9 | Already only KEEP after first pass |
| Media.Tests | 6 | 10 | Prewarm/SubtitlesExtraction/SwarmProbe dropped |
| Metadata.Tests | 0 | all + project | Entire project removed from slnx |
| Search.Tests | 2 | 6 | FakeHttp units stripped; network smokes only |
| web | 0 | 32 | vitest/node:test removed; CI web test step gone |

Baseline before purge (approx): ~99 server test files + 32 web test files.
After purge: remaining KEEP files listed below.

---

## TorrentFlow.Api.Tests

| File | Verdict | Reason |
|------|---------|--------|
| ApiFactory.cs | KEEP | Shared WAF host + real SQLite |
| AuthTests.cs | KEEP | Real HTTP auth against WAF |
| AutomationContractsTests.cs | KEEP | Real HTTP contracts |
| ClientDownloadImportTests.cs | KEEP | Real HTTP + disk import |
| ClientImportHashTests.cs | KEEP | Real HTTP hash path |
| ClientImportTests.cs | KEEP | Real HTTP import |
| DiagnosticsContractsTests.cs | KEEP | Real HTTP diagnostics |
| EngineContractsTests.cs | KEEP | Real HTTP engine contracts |
| LibraryContractsTests.cs | KEEP | Real HTTP library |
| MediaContractsTests.cs | KEEP | Real HTTP media |
| MetadataContractsTests.cs | KEEP | Real HTTP metadata |
| RequestsContractsTests.cs | KEEP | Real HTTP requests |
| SearchContractsTests.cs | KEEP | Real HTTP search |
| SettingsContractsTests.cs | KEEP | Real HTTP settings |
| StorageContractsTests.cs | KEEP | Real HTTP storage |
| SystemContractsTests.cs | KEEP | Real HTTP system |
| DesktopPackageTests.cs | DROP | Package/path units, no host |
| DataAdoptionTests.cs | DROP | Service-level, no host HTTP |
| DevJwksProviderTests.cs | DROP | Isolated crypto unit |
| AppHostTests.cs | DROP | First-pass DROP |
| ErrorEnvelopeTests.cs | DROP | First-pass DROP |
| PublicOriginTests.cs | DROP | First-pass DROP |
| RateLimitTests.cs | DROP | First-pass DROP |
| RemoteAccessConfigTests.cs | DROP | First-pass DROP |
| SpaStaticFilesTests.cs | DROP | First-pass DROP |

## TorrentFlow.Core.Tests — DROPPED (project removed)

| File | Verdict | Reason |
|------|---------|--------|
| BoundedHttpContentTests.cs | DROP | Stream unit, no host |
| JsonElementExtensionsTests.cs | DROP | Pure unit |
| SqliteBusyRetryInterceptorTests.cs | DROP | Mock interceptor unit |
| Entire project | DROP | Removed from TorrentFlow.slnx |

## TorrentFlow.Engine.Tests

| File | Verdict | Reason |
|------|---------|--------|
| ApiFactory.cs | KEEP | WAF host |
| EngineHarness.cs | KEEP | Real MonoTorrent root + FakeBackend factory for KEEP tests |
| EngineRouteTests.cs | KEEP | Real HTTP engine routes |
| SettingsParityTests.cs | KEEP | Real HTTP settings parity |
| ExternalDownloadImportTests.cs | KEEP | Real MonoTorrentBackend + disk + DB |
| ScannerServiceTests.cs | KEEP | Real disk scanner flow |
| TrackerTier.cs | KEEP | Shared tier helpers for KEEP |
| CompletenessGateTests.cs | KEEP | Real completeness gate path |
| ContentKindInferenceTests.cs | KEEP | Integration-style in suite |
| EngineLifecycleTests.cs | KEEP | Real engine lifecycle |
| FileServiceTests.cs | KEEP | Real disk file service |
| NamingTests.cs | KEEP | Real naming integration |
| PathSafetyTests.cs | KEEP | Real path safety |
| ProgressMapTests.cs | KEEP | Real progress map |
| ReleaseIdentityTests.cs | KEEP | Real identity path |
| SessionPersistenceTests.cs | KEEP | Real session disk |
| StateMachineTests.cs | KEEP | Real state machine path |
| StorageFacts.cs | KEEP | Real storage facts / estimate regression |
| TorrentStateMachineTests.cs | KEEP | Real torrent state path |
| DownloadRecoveryTests.cs | DROP | Mock recovery unit |
| ExternalRouteTests.cs | DROP | FakeBackend-only route unit |
| LayoutFinalizerTests.cs | DROP | Layout unit |
| LayoutFfprobeTests.cs | DROP | Ffprobe unit |
| SeasonLayoutTests.cs | DROP | Layout unit |

## TorrentFlow.Library.Tests

| File | Verdict | Reason |
|------|---------|--------|
| ApiFactory.cs | KEEP | WAF |
| LibraryRouteTests.cs | KEEP | Real HTTP |
| GrabRouteTests.cs | KEEP | Real HTTP grab |
| RequestsRouteTests.cs | KEEP | Real HTTP requests |
| AutomationServiceTests.cs | KEEP | Real automation path |
| LibraryQueryTests.cs | KEEP | Real query path |
| MediaItemServiceTests.cs | KEEP | Real media item path |
| StorageEstimateTests.cs | KEEP | Real storage estimate regression |

## TorrentFlow.Media.Tests

| File | Verdict | Reason |
|------|---------|--------|
| ApiFactory.cs | KEEP | WAF |
| MediaRoutesTests.cs | KEEP | Real HTTP media routes |
| StreamTokenServiceTests.cs | KEEP | Token path used by routes |
| TranscodePlannerTests.cs | KEEP | Planner used by live media path |
| TranscodeSessionStoreTests.cs | KEEP | Session store path |
| TranscodeManagerTests.cs | KEEP | Manager path |
| PrewarmObserverTests.cs | DROP | Observer unit |
| SubtitlesExtractionTests.cs | DROP | Extraction unit |
| SwarmProbeTests.cs | DROP | Probe unit |

## TorrentFlow.Metadata.Tests — DROPPED (project removed)

| File | Verdict | Reason |
|------|---------|--------|
| BrowseIntegrationTests.cs | DROP | FakeHttp, no WAF host |
| ResourceSafetyTests.cs | DROP | Safety unit |
| TmdbSettingsTests.cs | DROP | Settings unit |
| Entire project | DROP | Removed from TorrentFlow.slnx |
## TorrentFlow.Search.Tests

| File | Verdict | Reason |
|------|---------|--------|
| SourceAdaptersArchiveTorznabTests.cs | KEEP | TF_NETWORK_TESTS live Archive.org smoke only |
| TrackerScraperTests.cs | KEEP | TF_NETWORK_TESTS public tracker scrape only |
| FakeHttp + adapter units | DROP | All FakeHttp-dependent adapter units removed |

## web/

| File | Verdict | Reason |
|------|---------|--------|
| web/tests/** | DROP | All vitest/node:test unit files removed |
| package.json test script | DROP | Removed |
| CI node --test step | DROP | Removed from .github/workflows/ci.yml |
| Real browser E2E | none in-repo | Owner verifies via Playwright MCP against live app |

## Helpers retained

- EngineHarness + FakeBackend remain only as construction helpers for KEEP MonoTorrent/disk tests.
- Per-project ApiFactory classes remain for real WAF hosts.
