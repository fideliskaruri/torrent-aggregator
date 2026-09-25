using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

/// <summary>Regression: a single-tier tracker list stalled a restarted download on one zero-peer tracker.</summary>
public class TrackerTierTests : IDisposable
{
    private static readonly string[] Trackers =
        ["http://127.0.0.1:9/a/announce", "http://127.0.0.1:9/b/announce", "http://127.0.0.1:9/c/announce"];

    private readonly string _root = EngineHarness.NewRoot();

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private MonoTorrentBackend Backend() => new(Options.Create(new EngineOptions
    {
        DataDirectory = Path.Combine(_root, "engine"),
        ListenPort = FreePort(),
        Dht = false,
        PublicTrackers = [],
    }), NullLogger<MonoTorrentBackend>.Instance);

    private static List<List<string>> TierUrls(MonoTorrentBackend backend) =>
        backend.Engine.Torrents.Single().TrackerManager.Tiers
            .Select(t => t.Trackers.Select(tr => tr.Uri.ToString()).ToList()).ToList();

    [Fact]
    public async Task TorrentFileTrackersAreEachAnnouncedInTheirOwnTier()
    {
        var file = Path.Combine(_root, "payload.bin");
        await File.WriteAllBytesAsync(file, new byte[200_000]);
        var creator = new TorrentCreator { PieceLength = 32 * 1024 };
        creator.Announces.Add(Trackers.ToList());
        var bytes = (await creator.CreateAsync(new TorrentFileSource(file))).Encode();
        var hash = Torrent.Load(bytes).InfoHashes.V1OrV2.ToHex().ToLowerInvariant();

        await using var backend = Backend();
        var added = await backend.AddAsync(new BackendAddSpec(hash, null, bytes, Path.Combine(_root, "dl"), TorrentPurpose.Keep, null), CancellationToken.None);

        Assert.True(added.Ok, added.Message);
        var tiers = TierUrls(backend);
        Assert.Equal(3, tiers.Count);
        Assert.All(tiers, t => Assert.Single(t));
        Assert.Equal(Trackers.Order(), tiers.Select(t => t[0]).Order());
    }

    [Fact]
    public async Task MagnetTrackersAreEachAnnouncedInTheirOwnTier()
    {
        const string hash = "08ada5a7a6183aae1e09d831df6748d566095a10";
        var magnet = $"magnet:?xt=urn:btih:{hash}&dn=x" + string.Concat(Trackers.Select(t => "&tr=" + Uri.EscapeDataString(t)));

        await using var backend = Backend();
        var added = await backend.AddAsync(new BackendAddSpec(hash, magnet, null, Path.Combine(_root, "dl"), TorrentPurpose.Keep, null), CancellationToken.None);

        Assert.True(added.Ok, added.Message);
        var tiers = TierUrls(backend);
        Assert.Equal(3, tiers.Count);
        Assert.All(tiers, t => Assert.Single(t));
    }
}
