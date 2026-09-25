using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.Client;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

/// <summary>A real MonoTorrent seeder on 127.0.0.1 and the engine backend as leecher: no internet, no trackers, no DHT.</summary>
public class LoopbackSwarmTests : IAsyncLifetime
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
        var path = Assert.Single(snap.Files).FullPath;
        Assert.Equal(Path.Combine(save, "synthetic.bin"), path);   // NoSubfolder layout
        Assert.NotNull(backend.GetMetadata(_hash));
        await backend.RemoveAsync(_hash);                           // release the file handles
        Assert.Equal(_payload, await File.ReadAllBytesAsync(path));
        Assert.Null(backend.GetMetadata(_hash));                    // no per-hash state outlives the transfer
    }

    [Fact]
    public async Task StreamSeamReadsBytesInOrderAndSeeks()
    {
        await using var backend = Leecher("stream");
        var save = Path.Combine(_root, "stream", "downloads");
        var added = await backend.AddAsync(new BackendAddSpec(_hash, null, _torrentBytes, save, TorrentPurpose.Stream, null), CancellationToken.None);
        Assert.True(added.Ok, added.Message);
        await backend.AddPeerAsync(_hash, _seederEndPoint);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        await using var stream = await backend.OpenStreamAsync(_hash, 0, cts.Token);
        Assert.True(stream.CanSeek);
        Assert.Equal(FileSize, stream.Length);

        // Seek into the middle first: the provider must prioritise those pieces even though nothing is downloaded.
        var mid = FileSize / 2 + 7;
        stream.Seek(mid, SeekOrigin.Begin);
        var tail = new byte[4096];
        await stream.ReadExactlyAsync(tail, cts.Token);
        Assert.Equal(_payload.AsSpan(mid, tail.Length).ToArray(), tail);

        stream.Seek(0, SeekOrigin.Begin);
        var all = new byte[FileSize];
        var read = 0;
        while (read < FileSize)
        {
            var n = await stream.ReadAsync(all.AsMemory(read, Math.Min(100_000, FileSize - read)), cts.Token);
            Assert.True(n > 0, "stream ended early");
            read += n;
        }
        Assert.Equal(_payload, all);
    }
}
