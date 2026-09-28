# Test audit — drop mock/unit tests

Owner rule: unit tests full of shit; mock-heavy suites passed while real flows broke.
Branch: `chore/drop-unit-tests` (from `dd308d0`).

**KEEP** = real host (`WebApplicationFactory`/Kestrel) + real HTTP + real temp SQLite, or real E2E (MonoTorrent loopback, real disk layout). Also `TF_NETWORK_TESTS` opt-in network.
**DROP** = single-class unit tests, mocks/fakes/stub HTTP, pure string/format, internal snapshots, implementation details.
**REVIEW** = unsure — left in place.

Before: ~1763 Fact/Theory/it markers across 174 files (server + web).
After drop: 66 server test source files, ~507 Fact/Theory markers; web unit tests removed.
Executed after: **878 passed, 7 skipped, 0 failed** in ~66s (`dotnet test -c Release --no-build -p:SkipWebBuild=true`).

---

## TorrentFlow.Api.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| ContainerHostingTests.cs | 2 | KEEP | HostFactory real HTTP |
| DataAdoptionTests.cs | 10 | KEEP | Real temp dirs + SQLite adoption on disk |
| DataDirectoryTests.cs | 10 | KEEP | HostFactory + real SQLite data dir |
| DesktopTests.cs | 21 | REVIEW | Real FS/installer; some fake HTTP handlers |
| DevJwksPathTests.cs | 3 | REVIEW | Real temp JWKS files; hand-built host, thin HTTP |
| FlowQaRequestSettingsTests.cs | 8 | REVIEW | Mix of pure RequestRules + HostFactory routes |
| HostRouteTests.cs | 6 | KEEP | WebApplicationFactory real HTTP |
| KeylessTitleRouteTests.cs | 1 | KEEP | HostFactory real route |
| NotificationTests.cs | 10 | KEEP | TestHost real HTTP + DB |
| RemoteAccessTests.cs | 41 | KEEP | WebApplicationFactory + defines shared factories |
| RequestAutoApproveTests.cs | 6 | KEEP | DecisionHostFactory + EF + HTTP |
| RequestDecisionTests.cs | 13 | KEEP | TestHost real HTTP |
| RequesterTests.cs | 29 | KEEP | TestHost real HTTP auth |
| SourcesRouteTests.cs | 3 | KEEP | HostFactory route |
| TimelineTests.cs | 2 | KEEP | RemoteHostFactory real HTTP |
| TmdbSettingsRouteTests.cs | 3 | KEEP | HostFactory route |

---

## TorrentFlow.Core.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| BoundedHttpContentTests.cs | 5 | REVIEW | Stream bound behaviour; no full host |
| EngineAddMessagesTests.cs | 3 | DROP | Pure message formatting |
| PublicTrackersTests.cs | 10 | DROP | Pure list/URL parsing |
| UnitTest1.cs | 1 | DROP | Template placeholder |

Project kept for REVIEW only.

---

## TorrentFlow.Engine.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| CandidateMetadataTests.cs | 5 | DROP | FakeBackend metadata unit |
| DownloadDirectoryTests.cs | 3 | DROP | Harness/fake path behaviour |
| DownloadQueueTests.cs | 12 | DROP | Pure DownloadQueue sorting/keys |
| DownloadRecoveryTests.cs | 8 | REVIEW | Mostly fake; one real MonoTorrent resume path |
| DownloadWithoutWrapperTests.cs | 1 | KEEP | Real MonoTorrentBackend + disk layout |
| EngineLifecycleTests.cs | 22 | DROP | FakeBackend lifecycle |
| EngineMonitorTickTests.cs | 4 | DROP | Fake monitor ticks |
| EngineQueueTests.cs | 27 | DROP | FakeBackend queue/cap |
| EngineRouteTests.cs | 12 | KEEP | WebApplicationFactory real HTTP + SQLite |
| ExternalClientTests.cs | 16 | DROP | Stubbed HttpMessageHandler clients |
| ExternalDownloadImportTests.cs | 6 | KEEP | Real MonoTorrent seed+import on disk |
| ExternalDownloadScannerTests.cs | 6 | REVIEW | Real .torrent fixtures; no swarm/host |
| ExternalRouteTests.cs | 13 | KEEP | WebApplicationFactory HTTP |
| FlowQaServerFixTests.cs | 7 | DROP | Fake categorizer / string folder regressions |
| LayoutFfprobeTests.cs | 4 | REVIEW | Real ffprobe opt-in (FFPROBE_PATH) |
| LayoutFinalizerTests.cs | 17 | REVIEW | Real disk layout helpers; harness/fake heavy |
| LayoutManifestStoreTests.cs | 2 | DROP | Manifest JSON unit |
| LayoutPolicyTests.cs | 19 | DROP | Pure planner + log strings |
| LayoutTidyTests.cs | 4 | DROP | Harness tidy only |
| LoopbackSwarmTests.cs | 4 | KEEP | Real ClientEngine loopback swarm |
| PublicTrackerTests.cs | 6 | DROP | Stubbed tracker-list HTTP |
| ReaddLayoutTests.cs | 2 | KEEP | RealEngineHarness MonoTorrent + SQLite + disk |
| ReleaseFileRemovalTests.cs | 7 | DROP | Fake-backend removal |
| ReleaseSwapTests.cs | 6 | DROP | Fake-backend swap |
| RequestDownloadIdentityTests.cs | 1 | DROP | Identity/dedup unit |
| ScheduleAndLaneTests.cs | 18 | DROP | Manual clock + rate math |
| SeasonLayoutReproTests.cs | 7 | REVIEW | Real on-disk season trees; fake-driven |
| SettingsParityTests.cs | 15 | KEEP | ApiFactory real HTTP + DB |
| SitePrefixedWrapperTests.cs | 3 | DROP | Wrapper-name strings |
| StorageBudgetTests.cs | 5 | DROP | Injected free-bytes budget unit |
| TorrentHttpLimitsTests.cs | 5 | DROP | Stubbed HTTP limits |
| TorrentUrlFailureTests.cs | 2 | DROP | Synthetic HTTP failures |
| TrackerTierTests.cs | 2 | REVIEW | Real backend construct; tier config only |
| EngineHarness.cs | — | KEEP | Shared harness (trimmed later if needed) |

---

## TorrentFlow.Library.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| AnimePremiereIdentityTests.cs | 3 | KEEP | LibraryHost real HTTP + SQLite |
| AnimeRequestGrabTests.cs | 1 | REVIEW | LibraryHost HTTP with stub search handler |
| AnimeWatchlistIdentityTests.cs | 2 | KEEP | Real host routes |
| AutomationTests.cs | 7 | KEEP | LibraryHost |
| CheckScheduleTests.cs | 17 | KEEP | LibraryHost |
| ConcurrentTitleTests.cs | 1 | KEEP | Real host concurrency |
| EpisodeDiagnosticsTests.cs | 5 | KEEP | LibraryHost |
| EpisodeMappingTests.cs | 15 | KEEP | LibraryHost |
| LadderParityTests.cs | 6 | DROP | Pure parity vs TS oracle snapshot |
| LadderRouteTests.cs | 8 | KEEP | LibraryHost routes |
| OnePipelineTests.cs | 7 | KEEP | LibraryHost pipeline |
| ReleaseGrammarTests.cs | 6 | DROP | Pure release-name grammar |
| ReleaseSwapTests.cs | 11 | KEEP | LibraryHost swap flow |
| RequestGrabIdentityTests.cs | 1 | KEEP | LibraryHost |
| RequestQualityTests.cs | 3 | KEEP | LibraryHost |
| ReviewFixTests.cs | 12 | KEEP | LibraryHost regressions |
| RouteTests.cs | 17 | KEEP | Real HTTP routes |
| SeasonAndCursorTests.cs | 12 | DROP | Pure cursor/queue-key unit |
| SeasonFailureTests.cs | 6 | KEEP | LibraryHost |
| TitleProviderIdentityTests.cs | 3 | KEEP | Real host |
| WaitReasonTests.cs | 7 | DROP | Pure WaitReasonService unit |
| TestHost.cs | — | KEEP | LibraryHost infra |

---

## TorrentFlow.Media.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| DecideCapabilitiesProbeTests.cs | 39 | DROP | Pure capability decision logic |
| HlsLifecycleAndHelpersTests.cs | 22 | DROP | Helper lifecycle unit |
| MediaLogicTests.cs | 65 | DROP | Large pure logic/format suite |
| PrewarmEvictionTests.cs | 10 | DROP | Harness stubs, no HTTP |
| PrewarmForegroundTests.cs | 9 | DROP | Harness-only |
| PrewarmPlaybackObserverTests.cs | 1 | REVIEW | PrewarmApiFactory single observer |
| PrewarmPreProbeTests.cs | 14 | DROP | Scheduler internals |
| PrewarmRouteTests.cs | 16 | KEEP | WebApplicationFactory HTTP + SQLite |
| PrewarmServiceTests.cs | 25 | DROP | Service implementation details |
| StreamRouteTests.cs | 18 | KEEP | Real HTTP stream routes |
| SubtitlesExtractionTests.cs | 7 | REVIEW | Extraction/ffmpeg internals |
| SubtitlesRouteTests.cs | 11 | KEEP | WebApplicationFactory HTTP + SQLite |
| SubtitlesRulesTests.cs | 12 | DROP | Pure subtitle rules |
| SwarmProbeEngineTests.cs | 2 | REVIEW | Small engine probe |
| TestSupport.cs | — | KEEP | Media host infra |
| PrewarmTestSupport.cs | — | KEEP | Still needed by route/REVIEW prewarm tests |

---

## TorrentFlow.Metadata.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| AirDateTests.cs | 3 | DROP | Pure date logic |
| AnimeEpisodeMappingTests.cs | 10 | DROP | Fake HTTP mapping |
| AnimeIdentityCacheTests.cs | 3 | DROP | Fake handler cache |
| BrowseIntegrationTests.cs | 7 | KEEP | Real temp SQLite BuildAsync E2E |
| BrowseOrganizationTests.cs | 27 | DROP | Pure organization/sorting |
| BrowseRailsTests.cs | 17 | DROP | Pure rail building |
| CollapseTests.cs | 13 | DROP | Pure collapse rules |
| MetadataTests.cs | 49 | DROP | Fake-http / pure parsing |
| NormalizationParityTests.cs | 1 | DROP | Pure string normalization |
| ResourceSafetyTests.cs | 8 | REVIEW | Disposal with fakes |
| SearchResultEnricherTests.cs | 10 | DROP | Fake enrichment |
| SourcesTests.cs | 11 | DROP | FakeHandler clients |
| TheatricalWindowTests.cs | 13 | DROP | Pure window math |
| TmdbSettingsTests.cs | 7 | REVIEW | Fakes + temp-file settings |
| TestSupport.cs | — | KEEP | SQLite helpers for BrowseIntegration |

---

## TorrentFlow.Search.Tests

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| AcquisitionRecoveryTests.cs | 8 | DROP | In-memory pure logic |
| AdapterTests.cs | 16 | DROP | FakeHttp handlers |
| DirectPlayParityTests.cs | 2 | DROP | Pure parity strings |
| PureParityTests.cs | 1 | DROP | Pure function parity |
| RegisteredSourcesTests.cs | 2 | DROP | Fake registry |
| ResourceSafetyTests.cs | 5 | REVIEW | Disposal assertions |
| SearchServiceTests.cs | 13 | KEEP | Real SQLite + EF |
| SourceAdaptersArchiveTorznabTests.cs | 7 | KEEP | Includes TF_NETWORK_TESTS live |
| SwarmHealthTests.cs | 5 | DROP | Pure ranking math |
| SwarmRankingTests.cs | 10 | DROP | Pure/mocked ranking |
| TmdbCredentialTests.cs | 1 | DROP | Mocked credentials |
| TrackerScraperTests.cs | 15 | KEEP | TF_NETWORK_TESTS live scrape |
| UnitTest1.cs | 1 | DROP | Template placeholder |

---

## Web

All web `*.test.mjs` / `*.test.ts` are pure unit, source-text regex, or stubbed fetch — no real browser/app host.

| File | Count | Verdict | Reason |
|------|------:|---------|--------|
| web/tests/*.test.mjs (26 files) | ~ | DROP | Pure unit / source-text / stub fetch |
| web/src/**/*.test.ts (5) | ~ | DROP | Pure helpers/state |
| web/src/**/*.test.mjs (1) | ~ | DROP | Source-text layout assert |
| web/src/lib/library/storage-override.test.ts | ~ | DROP | Pure dialog-copy unit |

Owner verification for UI is Playwright MCP against the live app, not node unit tests.

---

## Summary (planned)

| Project | KEEP | DROP | REVIEW |
|---------|-----:|-----:|-------:|
| Api | 13 | 0 | 3 |
| Core | 0 | 3 | 1 |
| Engine | 6 | 20 | 7 |
| Library | 16 | 4 | 1 |
| Media | 3 | 8 | 3 |
| Metadata | 1 | 11 | 2 |
| Search | 3 | 9 | 1 |
| web | 0 | 32 | 0 |
