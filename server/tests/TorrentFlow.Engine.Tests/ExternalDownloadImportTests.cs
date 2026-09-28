using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Tests;

/// <summary>Real MonoTorrent backend + real disk fixtures + temp SQLite via EngineRoot.</summary>
public sealed class ExternalDownloadImportTests
{
    [Fact]
    public async Task MagnetImportHashesExistingPayloadAfterReceivingMetadataFromLocalPeer()
    {
        await using var h = await EngineRoot.CreateAsync();
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
        h.Options.PublicTrackers = ["https://must-not-contact.invalid/announce"];
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
        Assert.Empty(manager.TrackerManager.Tiers);
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
        await using var h = await EngineRoot.CreateAsync();
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
}
