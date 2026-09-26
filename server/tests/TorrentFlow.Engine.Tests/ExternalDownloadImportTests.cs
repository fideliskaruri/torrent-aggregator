using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Tests;

public sealed class ExternalDownloadImportTests
{
    [Fact]
    public async Task MagnetImportHashesExistingPayloadAfterReceivingMetadataFromLocalPeer()
    {
        await using var h = await EngineHarness.CreateAsync();
        ExternalDownloadScannerTests.WriteFixture(h.Root, "qBittorrent");
        var candidate = Assert.Single((await ExternalDownloadScannerTests.Scanner(h.Root).ScanAsync()).Candidates);
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        var seedOptions = new EngineOptions { DataDirectory = Path.Combine(h.Root, "seed"), Dht = false, PublicTrackers = [],
            Streaming = false, ListenPort = port, LocalPeerDiscovery = false };
        await using var seed = new MonoTorrentBackend(Options.Create(seedOptions), NullLogger<MonoTorrentBackend>.Instance);
        await seed.AddAsync(new BackendAddSpec(candidate.Hash, null, candidate.TorrentBytes, candidate.SavePath, "keep", null, false, ForceHashCheck: true), default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (seed.Get(candidate.Hash)?.State != "complete") await Task.Delay(100, timeout.Token);
        h.Options.Dht = false;
        h.Options.PublicTrackers = [];
        h.Options.Streaming = false;
        h.Options.LocalPeerDiscovery = false;
        h.Options.ListenPort = 0;
        await using var backend = new MonoTorrentBackend(Options.Create(h.Options), NullLogger<MonoTorrentBackend>.Instance);
        var engine = new TorrentEngineService(h.Db, backend, new StaticOptionsMonitor<EngineOptions>(h.Options),
            new ClientSettingsStore(h.Db), h.Storage, new NoHttpFactory(), TimeProvider.System, NullLogger<TorrentEngineService>.Instance);
        var magnet = $"magnet:?xt=urn:btih:{candidate.Hash}&dn={Uri.EscapeDataString(candidate.Name)}";
        await engine.ImportExternalAsync(candidate with { TorrentBytes = null, Magnet = magnet }, default);
        var manager = backend.Engine.Torrents.Single();
        Assert.False(manager.HashChecked);
        await manager.AddPeerAsync(new MonoTorrent.PeerInfo(new Uri($"ipv4://127.0.0.1:{port}")));
        while (backend.Get(candidate.Hash)?.State != "complete") await Task.Delay(100, timeout.Token);
        Assert.True(manager.HashChecked);
        Assert.Equal(0, backend.Get(candidate.Hash)!.BytesReceived);
        await engine.TickAsync();
        Assert.Equal("seeding", (await h.RowsAsync()).Single().Status);
    }

    [Theory]
    [InlineData("")]
    [InlineData(".!qB")]
    [InlineData(".part")]
    public async Task RealBackendHashChecksOriginalPayloadAndKeepsRenamedPathAcrossRestart(string suffix)
    {
        await using var h = await EngineHarness.CreateAsync();
        ExternalDownloadScannerTests.WriteFixture(h.Root, "qBittorrent");
        var original = Path.Combine(h.Root, "original-data", "qBittorrent", "qBittorrent fixture.mkv");
        var payload = await File.ReadAllBytesAsync(original);
        if (suffix.Length > 0) File.Move(original, original + suffix);
        var candidate = Assert.Single((await ExternalDownloadScannerTests.Scanner(h.Root).ScanAsync()).Candidates);
        h.Options.Dht = false;
        h.Options.PublicTrackers = [];
        h.Options.Streaming = false;
        h.Options.ListenPort = 0;
        await using var backend = new MonoTorrentBackend(Options.Create(h.Options), NullLogger<MonoTorrentBackend>.Instance);
        var engine = new TorrentEngineService(h.Db, backend, new StaticOptionsMonitor<EngineOptions>(h.Options),
            new ClientSettingsStore(h.Db), h.Storage, new NoHttpFactory(), TimeProvider.System, NullLogger<TorrentEngineService>.Instance);
        Assert.True((await engine.ImportExternalAsync(candidate, default)).Imported);
        async Task Completed()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (backend.Get(candidate.Hash)?.State != "complete") await Task.Delay(100, timeout.Token);
            await engine.TickAsync();
        }
        await Completed();
        Assert.Equal(0, backend.Get(candidate.Hash)!.BytesReceived);
        Assert.Equal(payload, await File.ReadAllBytesAsync(original + suffix));
        Assert.Equal("seeding", (await h.RowsAsync()).Single().Status);
        await backend.RemoveAsync(candidate.Hash);
        await engine.RehydrateAsync();
        await Completed();
        Assert.Equal(original + suffix, backend.Get(candidate.Hash)!.Files.Single().FullPath);
        if (suffix.Length > 0) Assert.False(File.Exists(original));
    }

    [Fact]
    public async Task ImportsSelectedHashOnceAcrossSourcesAndConcurrentCallsWithoutMovingPayload()
    {
        await using var h = await EngineHarness.CreateAsync();
        ExternalDownloadScannerTests.WriteFixture(h.Root, "qBittorrent", partial: true);
        var scanner = ExternalDownloadScannerTests.Scanner(h.Root);
        var candidate = Assert.Single((await scanner.ScanAsync()).Candidates);
        h.Backend.AddOverride = spec =>
        {
            Assert.Equal(candidate.SavePath, spec.SavePath);
            Assert.True(spec.ForceHashCheck);
            Assert.False(spec.CreateContainingDirectory);
            Assert.NotNull(spec.TorrentBytes);
            return null;
        };
        var results = await Task.WhenAll(h.Engine.ImportExternalAsync(candidate, default),
            h.Engine.ImportExternalAsync(candidate with { Id = "other", Source = "Other client" }, default));
        Assert.Single(results, r => r.Imported);
        Assert.Single(await h.RowsAsync());
        Assert.Equal("downloading", (await h.RowsAsync()).Single().Status);
        Assert.Equal(5, new FileInfo(Path.Combine(candidate.SavePath, candidate.Name)).Length);
        await h.Backend.RemoveAsync(candidate.Hash);
        await h.Engine.RehydrateAsync();
        Assert.True(h.Backend.Contains(candidate.Hash));
    }

    [Fact]
    public async Task MissingDataRemainsPausedAcrossRestartAndKeepsOriginalPath()
    {
        await using var h = await EngineHarness.CreateAsync();
        ExternalDownloadScannerTests.WriteFixture(h.Root, "Transmission", missing: true);
        var candidate = Assert.Single((await ExternalDownloadScannerTests.Scanner(h.Root).ScanAsync()).Candidates);
        Assert.True((await h.Engine.ImportExternalAsync(candidate, default)).Paused);
        await h.Engine.RehydrateAsync();
        Assert.Empty(h.Backend.AddLog);
        var row = Assert.Single(await h.RowsAsync());
        Assert.Equal("paused", row.Status);
        Assert.Equal(candidate.SavePath, row.SavePath);
        Assert.Contains("missing", row.Error);
        Assert.True((await h.Engine.ResumeAsync(candidate.Hash)).Ok);
        Assert.Single(h.Backend.AddLog);
    }

    [Fact]
    public async Task ServerRequiresAcknowledgmentAndRejectsInventedIds()
    {
        await using var h = await EngineHarness.CreateAsync();
        var service = new ExternalDownloadImportService(ExternalDownloadScannerTests.Scanner(h.Root), h.Engine, h.Db,
            NullLogger<ExternalDownloadImportService>.Instance);
        await Assert.ThrowsAsync<ArgumentException>(() => service.ImportAsync(new(["invented"], false), default));
        var result = await service.ImportAsync(new(["invented"], true), default);
        Assert.Equal(1, result.Failed);
        Assert.Equal(0, result.Imported);
        Assert.Empty(await h.RowsAsync());
    }

    [Fact]
    public async Task SelectionImportsOnlyChosenTorrentAndRepeatIsSkipped()
    {
        await using var h = await EngineHarness.CreateAsync();
        ExternalDownloadScannerTests.WriteFixture(h.Root, "qBittorrent", missing: true);
        ExternalDownloadScannerTests.WriteFixture(h.Root, "Deluge", missing: true);
        var scanner = ExternalDownloadScannerTests.Scanner(h.Root);
        var chosen = (await scanner.ScanAsync()).Candidates.Single(c => c.Source == "Deluge");
        var service = new ExternalDownloadImportService(scanner, h.Engine, h.Db, NullLogger<ExternalDownloadImportService>.Instance);
        var first = await service.ImportAsync(new([chosen.Id], true), default);
        Assert.Equal(1, first.Imported);
        Assert.Equal(1, first.Paused);
        Assert.Equal(chosen.Hash, (await h.RowsAsync()).Single().Hash);
        var repeat = await service.ImportAsync(new([chosen.Id], true), default);
        Assert.Equal(0, repeat.Imported);
        Assert.Equal(1, repeat.Skipped);
    }
}
