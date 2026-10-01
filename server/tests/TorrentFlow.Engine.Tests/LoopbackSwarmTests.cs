using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.Client;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;
using Xunit.Abstractions;

namespace TorrentFlow.Engine.Tests;

/// <summary>A real MonoTorrent seeder on 127.0.0.1 and the engine backend as leecher: no internet, no trackers, no DHT.</summary>
public class LoopbackSwarmTests(ITestOutputHelper output) : IAsyncLifetime
{
    private const int FileSize = 3 * 1024 * 1024 + 12345;
    private string _root = null!;
    private byte[] _payload = null!;
    private byte[] _torrentBytes = null!;
    private string _hash = null!;
    private ClientEngine _seeder = null!;
    private IPEndPoint _seederEndPoint = null!;

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    public async Task InitializeAsync()
    {
        _root = EngineHarness.NewRoot();
        var seedDir = Path.Combine(_root, "seed");
        Directory.CreateDirectory(seedDir);
        _payload = new byte[FileSize];
        new Random(42).NextBytes(_payload);
        var file = Path.Combine(seedDir, "synthetic.bin");
        await File.WriteAllBytesAsync(file, _payload);

        var creator = new TorrentCreator { PieceLength = 64 * 1024 };
        var dict = await creator.CreateAsync(new TorrentFileSource(file));
        _torrentBytes = dict.Encode();
        var torrent = Torrent.Load(_torrentBytes);
        _hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();

        _seederEndPoint = new IPEndPoint(IPAddress.Loopback, FreePort());
        _seeder = new ClientEngine(new EngineSettingsBuilder
        {
            AllowPortForwarding = false,
            AllowLocalPeerDiscovery = false,
            AutoSaveLoadDhtCache = false,
            AutoSaveLoadFastResume = false,
            CacheDirectory = Path.Combine(_root, "seed-cache"),
            ListenEndPoints = new Dictionary<string, IPEndPoint> { ["ipv4"] = _seederEndPoint },
            DhtEndPoint = null,
        }.ToSettings());
        var seed = await _seeder.AddAsync(torrent, seedDir, new TorrentSettingsBuilder { CreateContainingDirectory = false }.ToSettings());
        await seed.HashCheckAsync(autoStart: true);
        await WaitUntil(() => seed.State == TorrentState.Seeding, TimeSpan.FromSeconds(30), "seeder never started seeding");
    }

    public async Task DisposeAsync()
    {
        await _seeder.StopAllAsync();
        _seeder.Dispose();
        try { Directory.Delete(_root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private MonoTorrentBackend Leecher(string name) => new(Options.Create(new EngineOptions
    {
        DataDirectory = Path.Combine(_root, name),
        ListenPort = FreePort(),
        Dht = false,
        PublicTrackers = [],
    }), NullLogger<MonoTorrentBackend>.Instance);

    private static async Task WaitUntil(Func<bool> condition, TimeSpan timeout, string message)
    {
        var end = DateTime.UtcNow + timeout;
        while (!condition())
        {
            if (DateTime.UtcNow > end) throw new TimeoutException(message);
            await Task.Delay(100);
        }
    }

    [Fact]
    public async Task MultipleMultiFileDownloadsShareOneBoundedDiskCache()
    {
        await using var backend = Leecher("multi-file");
        var hashes = new List<string>();
        var block = new byte[2 * 1024 * 1024];
        for (var episode = 1; episode <= 4; episode++)
        {
            var source = Path.Combine(_root, $"synthetic-episode-{episode}");
            Directory.CreateDirectory(source);
            for (var file = 0; file < 4; file++)
            {
                new Random(episode * 10 + file).NextBytes(block);
                await File.WriteAllBytesAsync(Path.Combine(source, $"generated-{file}.bin"), block);
            }
            var bytes = (await new TorrentCreator { PieceLength = 64 * 1024 }.CreateAsync(new TorrentFileSource(source))).Encode();
            var torrent = Torrent.Load(bytes);
            var seed = await _seeder.AddAsync(torrent, source, new TorrentSettingsBuilder { CreateContainingDirectory = false }.ToSettings());
            await seed.HashCheckAsync(autoStart: true);
            await WaitUntil(() => seed.State == TorrentState.Seeding, TimeSpan.FromSeconds(30), "multi-file seed did not start");
            var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
            hashes.Add(hash);
            Assert.True((await backend.AddAsync(new(hash, null, bytes, Path.Combine(_root, "multi-downloads"),
                TorrentPurpose.Keep, null), default)).Ok);
        }
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        process.Refresh();
        var beforePrivate = process.PrivateMemorySize64;
        long peakPrivate = beforePrivate, peakCache = 0;
        foreach (var hash in hashes) await backend.AddPeerAsync(hash, _seederEndPoint);
        await WaitUntil(() =>
        {
            process.Refresh();
            peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64);
            peakCache = Math.Max(peakCache, backend.Engine.DiskManager.CacheBytesUsed);
            return hashes.All(hash => backend.Get(hash)?.State == "complete");
        }, TimeSpan.FromSeconds(60), "concurrent multi-file downloads did not finish");
        Assert.Equal(4, backend.Engine.Torrents.Count);
        Assert.InRange(peakCache, 0, backend.Engine.Settings.DiskCacheBytes);
        output.WriteLine($"Four generated multi-file torrents (32 MiB payload, 16 files): private before={beforePrivate}, " +
            $"peak={peakPrivate}, shared cache peak={peakCache}, budget={backend.Engine.Settings.DiskCacheBytes} bytes. Includes loopback seeder.");
        foreach (var hash in hashes) await backend.RemoveAsync(hash);
    }

    [Fact]
    public async Task AddDownloadsToCompletionFromTheLocalSwarm()
    {
        await using var backend = Leecher("keep");
        var save = Path.Combine(_root, "keep", "downloads");
        var added = await backend.AddAsync(new BackendAddSpec(_hash, null, _torrentBytes, save, TorrentPurpose.Keep, null), CancellationToken.None);
        Assert.True(added.Ok, added.Message);
        await backend.AddPeerAsync(_hash, _seederEndPoint);

        await WaitUntil(() => backend.Get(_hash)?.State == "complete", TimeSpan.FromSeconds(60), "download never completed");
        var snap = backend.Get(_hash)!;
        Assert.Equal(1, snap.Progress, 3);
        // 49 pieces of 64 KiB: six full bytes and the top bit of the seventh.
        Assert.Equal(Convert.ToBase64String([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x80]), snap.PieceBitfield);
        var path = Assert.Single(snap.Files).FullPath;
        Assert.Equal(Path.Combine(save, "synthetic.bin"), path);   // a single-file torrent lands directly in the save path
        Assert.NotNull(backend.GetMetadata(_hash));
        await backend.RemoveAsync(_hash);                           // release the file handles
        Assert.Equal(_payload, await File.ReadAllBytesAsync(path));
        Assert.False(backend.HasSideState(_hash));                   // no per-hash state outlives the transfer
    }
}
