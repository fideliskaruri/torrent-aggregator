# Test audit — drop mock/unit tests (final pass)

Owner rule: no mock or fake-based tests of our own code. Keep only real app host (WAF OK) + real temp SQLite + real disk, or real MonoTorrent + disk. Third-party HTTP boundary fakes (TMDB/AniList/indexers/OpenSubtitles) only.

## Counts

| Stage | Server test .cs files | Fact/Theory | Passed run |
|-------|----------------------|-------------|------------|
| Before any purge (approx) | ~99 + 32 web | ~878 | ~878 |
| After first+second pass (0d597ef) | 48 | 348 | 648 |
| After final fake purge | 17 | ~56 | 56 (1 skipped network) |

## Projects removed entirely

| Project | Reason |
|---------|--------|
| Core.Tests | Pure units |
| Metadata.Tests | FakeHttp / no real third-party-only host suite left |
| Library.Tests | LibraryHost faked FakeEngine, FakeSearch, FakeMetadata, FakeCatalog, FakeArtwork, FakeAnimeLookup, FakeAirDates |
| Media.Tests | FakeEngine, StreamFakeEngine, FakeSearch, FakeProcessRunner, NoSwarm |

## What each deleted Fake* file faked (final pass)

| File | Faked |
|------|-------|
| Api NotificationTests | FakePushSender (IPushSender), FakeGrabber, FakeTransfers |
| Api RemoteAccessTests | FakeKeySource (IAccessKeySource), StubHandler (tunnel HTTP) |
| Api RequestDecisionTests | FakeGrabber (IRequestGrabber), FakeTransfers |
| Api RequestAutoApproveTests | DecisionHostFactory → FakeGrabber/Transfers |
| Api RequesterTests | FakeCatalog (IRequesterCatalog); inherits RemoteHostFactory FakeKeySource |
| Api TimelineTests | Pure TimelineService.Order unit + RemoteHostFactory |
| Api FlowQaRequestSettingsTests | RequesterHostFactory fakes |
| Api DataDirectoryTests | Pure DataDirectoryResolver units (no host for main cases) |
| Engine EngineRouteTests | FakeBackend (ITorrentBackend) in WAF |
| Engine SettingsParityTests | FakeBackend + ThrowingHandler on our external client types |
| Engine ExternalDownloadImport (4 FakeBackend cases) | h.Backend FakeBackend / h.Engine over FakeBackend |
| Engine EngineHarness FakeBackend | In-memory ITorrentBackend stand-in |
| Library TestHost + all *Tests | FakeEngine, FakeSearch, FakeMetadata, FakeCatalog, FakeArtwork, FakeAnimeLookup, FakeAirDates |
| Media * | FakeEngine / StreamFakeEngine / FakeProcessRunner / FakeSearch |

## Kept files (one-line reason each)

| File | Reason |
|------|--------|
| Api HostRouteTests.cs + HostFactory | Real WAF + temp SQLite; no own-code fakes |
| Api ContainerHostingTests.cs | Real WAF host contracts |
| Api SourcesRouteTests.cs | Real WAF sources routes |
| Api TmdbSettingsRouteTests.cs | Real WAF TMDB settings routes |
| Api KeylessTitleRouteTests.cs | Real WAF + SQLite; only third-party metadata HTTP handler |
| Engine EngineHarness.cs (EngineRoot) | Real temp dir + migrated SQLite helpers; no FakeBackend |
| Engine ExternalDownloadScannerTests.cs | Real disk fixtures + real scanner |
| Engine ExternalDownloadImportTests.cs | Real MonoTorrentBackend + real disk + SQLite |
| Engine DownloadWithoutWrapperTests.cs | RealEngineHarness + MonoTorrent + disk |
| Engine ReaddLayoutTests.cs | Real MonoTorrent layout on disk |
| Engine LoopbackSwarmTests.cs | Real MonoTorrent loopback swarm |
| Engine TrackerTierTests.cs | Real MonoTorrent tracker tier behaviour |
| Search SourceAdaptersArchiveTorznabTests.cs | TF_NETWORK_TESTS live Archive.org |
| Search TrackerScraperTests.cs | TF_NETWORK_TESTS public trackers |
| Search GlobalUsings.cs | usings only |

## CI / docs

- Web unit tests and `node --test` CI steps already removed.
- Library.Tests / Media.Tests removed from TorrentFlow.slnx; InternalsVisibleTo cleaned.
