using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MonoTorrent;
using MonoTorrent.BEncoding;
using MonoTorrent.Client;
using MonoTorrent.PieceWriter;

internal static class Loopback
{
    public static async Task RunAsync(int cacheCapacity)
    {
        var root = Path.GetFullPath(Path.Combine("artifacts", "cache-drain-loopback", Guid.NewGuid().ToString("N")));
        var source = Path.Combine(root, "source");
        var destination = Path.Combine(root, "destination");
        Directory.CreateDirectory(source);
        Directory.CreateDirectory(destination);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var ct = deadline.Token;
        const int pieceSize = 64 * 1024;
        var lengths = Enumerable.Range(1, 12).Select(n => 1024 * 1024 + n * 137).ToArray();
        var total = lengths.Sum();
        var bytes = new byte[total];
        new Random(20261121).NextBytes(bytes);
        var pieces = new List<byte>();
        for (var offset = 0; offset < total; offset += pieceSize)
            pieces.AddRange(SHA1.HashData(bytes.AsSpan(offset, Math.Min(pieceSize, total - offset))));
        var metadataFiles = new BEncodedList();
        var expected = new Dictionary<string, byte[]>();
        var position = 0;
        for (int i = 0; i < lengths.Length; i++)
        {
            var name = $"episode-{i + 1:D2}.partial";
            var file = bytes.AsMemory(position, lengths[i]).ToArray();
            position += file.Length;
            expected[name] = SHA256.HashData(file);
            await File.WriteAllBytesAsync(Path.Combine(source, name), file, ct);
            metadataFiles.Add(new BEncodedDictionary { ["length"] = new BEncodedNumber(file.Length),
                ["path"] = new BEncodedList { new BEncodedString(name) } });
        }
        var torrent = Torrent.Load(new BEncodedDictionary { ["info"] = new BEncodedDictionary {
            ["name"] = new BEncodedString("generated-cache-check"), ["private"] = new BEncodedNumber(1),
            ["piece length"] = new BEncodedNumber(pieceSize), ["files"] = metadataFiles,
            ["pieces"] = new BEncodedString(pieces.ToArray()) } }.Encode());
        ClientEngine Engine(string name, int capacity) => new(new EngineSettingsBuilder {
            CacheDirectory = Path.Combine(root, name), ListenEndPoints = new() { ["ipv4"] = new(IPAddress.Loopback, 0) },
            AllowLocalPeerDiscovery = false, AllowPortForwarding = false, AutoSaveLoadDhtCache = false,
            DhtEndPoint = null, AutoSaveLoadFastResume = false, UsePartialFiles = false,
            DiskCachePolicy = CachePolicy.WritesOnly, DiskCacheBytes = capacity }.ToSettings());
        var options = new TorrentSettingsBuilder { AllowDht = false, AllowPeerExchange = false,
            CreateContainingDirectory = false, AllowInitialSeeding = false }.ToSettings();
        using var seed = Engine("seed-cache", 0);
        using var client = Engine("client-cache", cacheCapacity);
        var seeder = await seed.AddAsync(torrent, source, options);
        await seeder.StartAsync();
        while (seeder.State != TorrentState.Seeding) await Task.Delay(30, ct);
        var port = (int)typeof(ClientEngine).GetMethod("GetOverrideOrActualListenPort", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(seed, ["ipv4"])!;
        var peer = new PeerInfo(new Uri($"ipv4://127.0.0.1:{port}"));
        var manager = await client.AddAsync(torrent, destination, options);
        var loop = typeof(ClientEngine).GetField("MainLoop", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!;
        var onLoop = loop.GetType().GetMethod("QueueWait", [typeof(Action)])!;
        var addPeer = typeof(TorrentManager).GetMethod("AddPeers", BindingFlags.NonPublic | BindingFlags.Instance)!;
        Action connect = () => addPeer.Invoke(manager, [new[] { peer }, manager.InfoHashes.V1!, false, true]);
        var timer = Stopwatch.StartNew();
        await manager.StartAsync();
        double? firstPayloadMs = null;
        while (!manager.Bitfield.AllTrue)
        {
            if (manager.Error is { } error) throw new IOException("Loopback failed", error.Exception);
            if (manager.Monitor.DataBytesReceived > 0) firstPayloadMs ??= timer.Elapsed.TotalMilliseconds;
            onLoop.Invoke(loop, [connect]);
            await Task.Delay(30, ct);
        }
        var transferMs = timer.Elapsed.TotalMilliseconds;
        await manager.StopAsync(TimeSpan.Zero);
        await client.DiskManager.FlushAsync(manager);
        await client.RemoveAsync(manager, RemoveMode.KeepAllData);
        var drainMs = timer.Elapsed.TotalMilliseconds - transferMs;
        foreach (var (name, checksum) in expected)
        {
            await using var stream = File.Open(Path.Combine(destination, name), FileMode.Open, FileAccess.Read, FileShare.None);
            var actual = await SHA256.HashDataAsync(stream, ct);
            if (!checksum.SequenceEqual(actual)) throw new Exception($"Wrong checksum for {name}");
        }
        Console.WriteLine(JsonSerializer.Serialize(new { cacheCapacity, total, filesVerified = expected.Count,
            firstPayloadMs, transferMs, drainMs, miBPerSecond = total / 1048576d / (transferMs / 1000d),
            client.DiskManager.TotalCacheBytesRead, client.DiskManager.TotalBytesRead,
            client.DiskManager.TotalBytesWritten, client.DiskManager.OpenFiles }));
        await seeder.StopAsync(TimeSpan.Zero);
    }
}
