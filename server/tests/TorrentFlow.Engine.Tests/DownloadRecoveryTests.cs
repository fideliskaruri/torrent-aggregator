using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using TorrentFlow.Engine.Controllers;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

public sealed class DownloadRecoveryTests
{
    private static DownloadRecoveryService Service(EngineHarness h) => new(h.Db, new ClientSettingsStore(h.Db),
        Options.Create(h.Options), h.Engine, NullLogger<DownloadRecoveryService>.Instance);

    [Fact]
    public async Task ImportIsIdempotentSkipsNonMediaAndSurvivesRehydration()
    {
        await using var h = await EngineHarness.CreateAsync();
        var root = Path.Combine(h.Root, "downloads");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "Example Movie 2025.mkv"), "media");
        await File.WriteAllTextAsync(Path.Combine(root, "Example Show S01E01.mp4"), "media");
        await File.WriteAllTextAsync(Path.Combine(root, "readme.txt"), "not media");
        await File.WriteAllTextAsync(Path.Combine(root, "unfinished.mkv.part"), "not completed");
        var service = Service(h);
        Assert.Equal(2, (await service.ImportAsync(default)).Imported);
        Assert.Equal(0, (await service.ImportAsync(default)).Imported);
        await h.Engine.RehydrateAsync();
        var list = await h.Engine.ListAsync();
        Assert.Equal(2, list.Count);
        Assert.All(list, row => { Assert.Equal("downloaded", row.State); Assert.True(row.Imported); Assert.Null(row.Magnet); Assert.Equal("kept", row.RetentionState); });
        Assert.Empty(h.Backend.AddLog);
        using var stream = await h.Engine.OpenFileStreamAsync(list[0].Hash, "0");
        Assert.Equal(5, stream.Length);
        Assert.True((await h.Engine.RemoveAsync(list[0].Hash, true)).Ok);
        Assert.Single(await h.Engine.ListAsync());
        Assert.Single(SettingsDiskInventory.MediaFiles(root, default));
    }

    [Fact]
    public async Task ConcurrentImportsDoNotDuplicate()
    {
        await using var h = await EngineHarness.CreateAsync();
        var root = Path.Combine(h.Root, "downloads");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "film.mkv"), "media");
        var service = Service(h);
        var results = await Task.WhenAll(service.ImportAsync(default), service.ImportAsync(default));
        Assert.Equal(1, results.Sum(r => r.Imported));
        Assert.Single(await h.RowsAsync());
    }

    [Fact]
    public async Task KnownIncompleteReleaseIsNotImportedAsComplete()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.SeedAsync(1, "downloading");
        var folder = Path.Combine(h.Root, "downloads", "n1");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(Path.Combine(folder, "file.mkv"), "partial");
        Assert.Equal(0, (await Service(h).ImportAsync(default)).Imported);
        Assert.Equal(0, (await h.RowsAsync()).Single().Progress);
    }

    [Fact]
    public async Task MatchingSavedTorrentIsRestoredAndKeptSeedingAcrossRehydrate()
    {
        await using var h = await EngineHarness.CreateAsync();
        var folder = Path.Combine(h.Root, "downloads");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "film.mkv");
        await File.WriteAllBytesAsync(file, new byte[1000]);
        var creator = new TorrentCreator { PieceLength = 32 * 1024 };
        var bytes = (await creator.CreateAsync(new TorrentFileSource(file))).Encode();
        h.Backend.AddOverride = spec =>
        {
            Assert.False(spec.CreateContainingDirectory);
            var snapshot = new BackendSnapshot(spec.Hash, "film.mkv", 0, 1000, 0, 0, 0, "checkingDL", true, folder,
                [new BackendFile(0, "film.mkv", file, 1000, true, 0)], null);
            h.Backend.Live[spec.Hash] = snapshot;
            return new BackendAddOutcome(true, "", snapshot);
        };
        Directory.CreateDirectory(Path.Combine(h.Options.EngineDirectory, "torrents"));
        await File.WriteAllBytesAsync(Path.Combine(h.Options.EngineDirectory, "torrents", "saved.torrent"), bytes);
        var result = await Service(h).ImportAsync(default);
        Assert.Equal(0, result.Imported);
        Assert.Equal(1, result.RestoredTorrents);
        var hash = (await h.RowsAsync()).Single().Hash;
        h.Backend.Complete(hash);
        await h.Engine.TickAsync();
        Assert.True(h.Backend.Contains(hash));
        Assert.Equal("seeding", (await h.RowsAsync()).Single().Status);
        await h.Backend.RemoveAsync(hash);
        await h.Engine.RehydrateAsync();
        Assert.True(h.Backend.Contains(hash));
        Assert.Equal(0, (await Service(h).ImportAsync(default)).Imported);
    }

    [Fact]
    public async Task FailedTorrentRestoreIsNotReportedAsSuccessfulImport()
    {
        await using var h = await EngineHarness.CreateAsync();
        var folder = Path.Combine(h.Root, "downloads");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "film.mkv");
        await File.WriteAllBytesAsync(file, new byte[1000]);
        var bytes = (await new TorrentCreator { PieceLength = 32 * 1024 }.CreateAsync(new TorrentFileSource(file))).Encode();
        Directory.CreateDirectory(Path.Combine(h.Options.EngineDirectory, "torrents"));
        await File.WriteAllBytesAsync(Path.Combine(h.Options.EngineDirectory, "torrents", "saved.torrent"), bytes);
        h.Backend.AddOverride = _ => new BackendAddOutcome(false, "Backend unavailable");

        var result = await Service(h).ImportAsync(default);

        Assert.Equal(0, result.Imported);
        Assert.Equal(0, result.RestoredTorrents);
        Assert.Equal(1, result.FailedTorrents);
        Assert.Equal("error", (await h.RowsAsync()).Single().Status);
        Assert.Equal(0, (await Service(h).ImportAsync(default)).Imported);
        Assert.True(File.Exists(file));
    }

    [Theory]
    [InlineData("127.0.0.1", false, true)]
    [InlineData("::1", false, true)]
    [InlineData("192.0.2.5", false, false)]
    [InlineData("127.0.0.1", true, false)]
    public void PathsAndImportAreOwnerOnly(string address, bool forwarded, bool allowed)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(address);
        if (forwarded) context.Request.Headers["X-Forwarded-For"] = "192.0.2.5";
        Assert.Equal(allowed, DownloadRecoveryController.IsOwner(context));
    }

    [Fact]
    public void DedicatedTunnelListenerIsDeniedEvenWithoutForwardedHeaders()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Connection.LocalPort = 4929;
        Assert.False(DownloadRecoveryController.IsOwner(context, "http://127.0.0.1:3929"));
        context.Connection.LocalPort = 3929;
        Assert.True(DownloadRecoveryController.IsOwner(context, "http://127.0.0.1:3929"));
    }

    [Fact]
    public async Task RealBackendHashChecksExistingFileAndSeedsWithoutDownloading()
    {
        await using var h = await EngineHarness.CreateAsync();
        var folder = Path.Combine(h.Root, "downloads");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "Recovered Film.mkv");
        var payload = new byte[128 * 1024];
        new Random(17).NextBytes(payload);
        await File.WriteAllBytesAsync(file, payload);
        var bytes = (await new TorrentCreator { PieceLength = 32 * 1024 }.CreateAsync(new TorrentFileSource(file))).Encode();
        Directory.CreateDirectory(Path.Combine(h.Options.EngineDirectory, "metadata"));
        await File.WriteAllBytesAsync(Path.Combine(h.Options.EngineDirectory, "metadata", "cached.torrent"), bytes);
        h.Options.Dht = false;
        h.Options.PublicTrackers = [];
        h.Options.Streaming = false;
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        h.Options.ListenPort = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        await using var backend = new MonoTorrentBackend(Options.Create(h.Options), NullLogger<MonoTorrentBackend>.Instance);
        var engine = new TorrentEngineService(h.Db, backend, new StaticOptionsMonitor<EngineOptions>(h.Options),
            new ClientSettingsStore(h.Db), h.Storage, new NoHttpFactory(), TimeProvider.System, NullLogger<TorrentEngineService>.Instance);
        var service = new DownloadRecoveryService(h.Db, new ClientSettingsStore(h.Db), Options.Create(h.Options), engine,
            NullLogger<DownloadRecoveryService>.Instance);
        Assert.Equal(1, (await service.ImportAsync(default)).RestoredTorrents);
        var hash = (await h.RowsAsync()).Single().Hash;
        async Task WaitComplete()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            while (backend.Get(hash)?.State != "complete") await Task.Delay(100, timeout.Token);
            await engine.TickAsync();
        }
        await WaitComplete();
        Assert.Equal(0, backend.Get(hash)!.BytesReceived);
        Assert.Equal(payload, await File.ReadAllBytesAsync(file));
        Assert.Equal("seeding", (await h.RowsAsync()).Single().Status);
        await backend.RemoveAsync(hash);
        await engine.RehydrateAsync();
        await WaitComplete();
        Assert.Equal(0, (await service.ImportAsync(default)).Imported);
        Assert.Equal(1, (await engine.ListAsync()).Single().Progress);
    }
}
