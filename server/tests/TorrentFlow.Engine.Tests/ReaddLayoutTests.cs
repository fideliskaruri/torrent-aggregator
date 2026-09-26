using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.Client;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Tests;

internal sealed class RealEngineHarness : IAsyncDisposable
{
    public string Root { get; }
    public IDbContextFactory<TorrentFlowDbContext> Db { get; }
    public MonoTorrentBackend Backend { get; }
    public TorrentEngineService Engine { get; }

    private readonly ServiceProvider _services;

    private RealEngineHarness(string root, ServiceProvider services, MonoTorrentBackend backend, TorrentEngineService engine)
    {
        Root = root;
        _services = services;
        Db = services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        Backend = backend;
        Engine = engine;
    }

    public static async Task<RealEngineHarness> CreateAsync(string root)
    {
        var services = new ServiceCollection()
            .AddLogging(b => b.SetMinimumLevel(LogLevel.Warning))
            .AddTorrentFlowData($"Data Source={Path.Combine(root, "test.db")};Pooling=False")
            .BuildServiceProvider();

        await services.GetRequiredService<DatabaseInitializer>().InitializeAsync();
        var dbFactory = services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        await using var db = await dbFactory.CreateDbContextAsync();
        var settings = await new ClientSettingsStore(dbFactory).EnsureAsync(db);
        settings.BaseDownloadPath = Path.Combine(root, "downloads");
        settings.MaxStorageBytes = 1L << 40;
        settings.StorageCapConfigured = true;
        db.Works.Add(new Work
        {
            Id = "show",
            WorkKey = "show",
            CanonicalTitle = "show",
            MediaType = "tv",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();

        var options = new EngineOptions
        {
            DataDirectory = root,
            ListenPort = 0,
            Dht = false,
            PublicTrackers = [],
            MetadataTimeoutSeconds = 5,
            MaxActiveDownloads = 1,
        };
        var backend = new MonoTorrentBackend(Options.Create(options), NullLogger<MonoTorrentBackend>.Instance);
        var storage = new StorageBudget(TimeProvider.System) { FreeBytesProvider = _ => 10L << 40 };
        var layout = new CompletedLayoutFinalizer(
            new CompletedMediaValidator(new FfprobeLocator(null), NullLogger<CompletedMediaValidator>.Instance),
            TimeProvider.System,
            NullLogger<CompletedLayoutFinalizer>.Instance);
        var engine = new TorrentEngineService(
            dbFactory,
            backend,
            new StaticOptionsMonitor<EngineOptions>(options),
            new ClientSettingsStore(dbFactory),
            storage,
            new NoHttpFactory(),
            TimeProvider.System,
            NullLogger<TorrentEngineService>.Instance,
            layout);

        return new RealEngineHarness(root, services, backend, engine);
    }

    public async ValueTask DisposeAsync()
    {
        await Backend.DisposeAsync();
        await _services.DisposeAsync();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed class ReaddLayoutTests
{
    private static async Task WaitUntil(Func<Task<bool>> condition, TimeSpan timeout, string message)
    {
        var end = DateTime.UtcNow + timeout;
        while (!await condition())
        {
            if (DateTime.UtcNow > end) throw new TimeoutException(message);
            await Task.Delay(100);
        }
    }

    private static string? MediaFixture()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var f = Path.Combine(dir.FullName, "scripts", "probes", "player-screenshots", "media", "Demo Show S01E01 1080p WEB-DL H.264.mp4");
            if (File.Exists(f)) return f;
        }
        return null;
    }

    [Fact]
    public async Task ReaddingALaidOutTransferSeedsTheExistingFlatFiles()
    {
        var fixture = MediaFixture();
        Assert.NotNull(fixture);

        var root = EngineHarness.NewRoot();
        var sourceRoot = Path.Combine(root, "source");
        var sourceRelease = Path.Combine(sourceRoot, "Sintel");
        var downloadRoot = Path.Combine(root, "downloads");
        Directory.CreateDirectory(sourceRelease);
        File.Copy(fixture, Path.Combine(sourceRelease, "Sintel.mp4"), overwrite: true);
        await File.WriteAllTextAsync(Path.Combine(sourceRelease, "readme.txt"), "keep me");

        var creator = new TorrentCreator { PieceLength = 64 * 1024 };
        var torrentBytes = (await creator.CreateAsync(new TorrentFileSource(sourceRelease))).Encode();
        var torrent = Torrent.Load(torrentBytes);
        var releaseName = torrent.Name;
        var releaseRoot = Path.Combine(downloadRoot, releaseName);
        var initialFile = Path.Combine(releaseRoot, torrent.Files[0].Path.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(initialFile)!);
        File.Copy(fixture, initialFile, overwrite: true);
        await File.WriteAllTextAsync(Path.Combine(releaseRoot, "readme.txt"), "keep me");

        await using var harness = await RealEngineHarness.CreateAsync(root);
        var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        var magnet = $"magnet:?xt=urn:btih:{hash}&dn={Uri.EscapeDataString(releaseName)}";
        var add = await harness.Engine.AddAsync(new EngineAddRequest
        {
            Name = releaseName,
            Magnet = magnet,
            TorrentBytes = torrentBytes,
            Purpose = "keep",
            WorkId = "show",
        });
        Assert.True(add.Ok, add.Message);

        await WaitUntil(() => Task.FromResult(harness.Backend.Get(hash)?.State == "complete"), TimeSpan.FromSeconds(60),
            $"initial download never completed (name={releaseName}, path={torrent.Files[0].Path}, initial={initialFile})");
        await harness.Engine.TickAsync();
        var flatPath = Path.Combine(downloadRoot, Path.GetFileName(initialFile));

        await WaitUntil(() => Task.FromResult(File.Exists(flatPath) && !Directory.Exists(Path.Combine(downloadRoot, releaseName))), TimeSpan.FromSeconds(30),
            "completed download was not laid out");

        var remove = await harness.Engine.RemoveAsync(hash, deleteFiles: false);
        Assert.True(remove.Ok, remove.Message);

        var readd = await harness.Engine.AddAsync(new EngineAddRequest
        {
            Name = releaseName,
            Magnet = magnet,
            Purpose = "keep",
            WorkId = "show",
        });
        Assert.True(readd.Ok, readd.Message);

        await WaitUntil(() => Task.FromResult(harness.Backend.Get(hash)?.State == "complete"), TimeSpan.FromSeconds(30), "re-add never completed");

        var snap = harness.Backend.Get(hash)!;
        Assert.Equal(0, snap.BytesReceived ?? 0);
        Assert.True(File.Exists(flatPath));
        Assert.False(Directory.Exists(Path.Combine(downloadRoot, releaseName)));
        Assert.Equal(2, Directory.EnumerateFiles(downloadRoot, "*", SearchOption.AllDirectories).Count());
    }

    private static async Task<(byte[] Bytes, Torrent Torrent, string Hash, string Magnet)> ReleaseAsync(string sourceRoot, string downloadRoot, string name, string video, string fixture, string screen)
    {
        var src = Path.Combine(sourceRoot, name);
        Directory.CreateDirectory(Path.Combine(src, "Screens"));
        File.Copy(fixture, Path.Combine(src, video), overwrite: true);
        await File.WriteAllTextAsync(Path.Combine(src, "Screens", "s1.png"), screen);
        var bytes = (await new TorrentCreator { PieceLength = 64 * 1024 }.CreateAsync(new TorrentFileSource(src))).Encode();
        var torrent = Torrent.Load(bytes);
        // Where MonoTorrent would leave a finished download: <save>/<name>/<path>.
        foreach (var file in torrent.Files)
        {
            var target = Path.Combine(downloadRoot, torrent.Name, file.Path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(Path.Combine(src, file.Path.Replace('/', Path.DirectorySeparatorChar)), target, overwrite: true);
        }
        var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        return (bytes, torrent, hash, $"magnet:?xt=urn:btih:{hash}&dn={Uri.EscapeDataString(torrent.Name)}");
    }

    private static async Task CompleteAndLayOutAsync(RealEngineHarness harness, string name, byte[]? bytes, string hash, string magnet)
    {
        var add = await harness.Engine.AddAsync(new EngineAddRequest { Name = name, Magnet = magnet, TorrentBytes = bytes, Purpose = "keep", WorkId = "show" });
        Assert.True(add.Ok, add.Message);
        await WaitUntil(() => Task.FromResult(harness.Backend.Get(hash)?.State == "complete"), TimeSpan.FromSeconds(60), $"{name} never completed");
        await harness.Engine.TickAsync();
        await WaitUntil(() => Task.FromResult(!harness.Backend.Contains(hash)), TimeSpan.FromSeconds(30), $"{name} was not detached");
    }

    [Fact]
    public async Task ReaddingATransferWhoseExtraWasMovedAsideRechecksItInPlaceAndLeavesTheNeighbourAlone()
    {
        var fixture = MediaFixture();
        Assert.NotNull(fixture);
        var root = EngineHarness.NewRoot();
        var sourceRoot = Path.Combine(root, "source");
        var downloadRoot = Path.Combine(root, "downloads");
        var first = await ReleaseAsync(sourceRoot, downloadRoot, "Show.S01E01.1080p.WEB", "Show.S01E01.mp4", fixture, "first screen");
        var second = await ReleaseAsync(sourceRoot, downloadRoot, "Show.S01E02.1080p.WEB", "Show.S01E02.mp4", fixture, "second screen!");

        await using var harness = await RealEngineHarness.CreateAsync(root);
        await CompleteAndLayOutAsync(harness, first.Torrent.Name, first.Bytes, first.Hash, first.Magnet);
        await CompleteAndLayOutAsync(harness, second.Torrent.Name, second.Bytes, second.Hash, second.Magnet);

        var neighbour = Path.Combine(downloadRoot, "Screens", "s1.png");
        var movedAside = Path.Combine(downloadRoot, "Screens", "Show.S01E02.1080p.WEB", "s1.png");
        Assert.True(File.Exists(Path.Combine(downloadRoot, "Show.S01E01.mp4")));
        Assert.True(File.Exists(Path.Combine(downloadRoot, "Show.S01E02.mp4")));
        Assert.Equal("first screen", await File.ReadAllTextAsync(neighbour));
        Assert.Equal("second screen!", await File.ReadAllTextAsync(movedAside));
        Assert.False(Directory.Exists(Path.Combine(downloadRoot, "Show.S01E02.1080p.WEB")));

        Assert.True((await harness.Engine.RemoveAsync(second.Hash, deleteFiles: false)).Ok);
        var readd = await harness.Engine.AddAsync(new EngineAddRequest { Name = second.Torrent.Name, Magnet = second.Magnet, Purpose = "keep", WorkId = "show" });
        Assert.True(readd.Ok, readd.Message);
        await WaitUntil(() => Task.FromResult(harness.Backend.Get(second.Hash)?.State == "complete"), TimeSpan.FromSeconds(30), "re-add never completed");

        var snap = harness.Backend.Get(second.Hash)!;
        Assert.Equal(0, snap.BytesReceived ?? 0);
        Assert.Contains(snap.Files, f => string.Equals(f.FullPath, movedAside, StringComparison.OrdinalIgnoreCase));
        Assert.Equal("first screen", await File.ReadAllTextAsync(neighbour));
        Assert.Equal("second screen!", await File.ReadAllTextAsync(movedAside));
        Assert.False(Directory.Exists(Path.Combine(downloadRoot, "Show.S01E02.1080p.WEB")));
        Assert.Equal(4, Directory.EnumerateFiles(downloadRoot, "*", SearchOption.AllDirectories).Count());
    }
}
