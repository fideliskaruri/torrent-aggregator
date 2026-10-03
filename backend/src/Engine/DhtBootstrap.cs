using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using MonoTorrent;
using MonoTorrent.BEncoding;
using MonoTorrent.Dht;

namespace TorrentFlow.Engine;

internal sealed class DhtBootstrap(ReliableDhtEngine engine, string directory, Action<string> log)
{
    private readonly string path = Path.Combine(directory, "dht_nodes.compact");
    private readonly SemaphoreSlim saving = new(1, 1);
    private DateTimeOffset nextRefresh, nextSave;
    private int refreshRounds;
    public int ReloadedNodes { get; private set; }
    public long CacheBytes => File.Exists(path) ? new FileInfo(path).Length : 0;

    public async Task StartAsync(CancellationToken ct)
    {
        byte[] cached = File.Exists(path) ? await File.ReadAllBytesAsync(path, ct) : [];
        if (cached.Length % 26 != 0 || cached.Length > 26 * 4096)
            throw new InvalidDataException("The DHT compact routing cache is invalid.");
        ReloadedNodes = cached.Length / 26;
        var routers = new (string Host, int Port)[]
        {
            ("dht.transmissionbt.com", 6881), ("dht.libtorrent.org", 25401),
            ("router.bittorrent.com", 6881), ("router.utorrent.com", 6881),
        };
        var seeds = await Task.WhenAll(routers.Select(async router =>
        {
            try
            {
                var addresses = await Dns.GetHostAddressesAsync(router.Host, ct).WaitAsync(TimeSpan.FromSeconds(4), ct);
                return addresses.Where(a => a.AddressFamily == AddressFamily.InterNetwork).Select(address =>
                {
                    var node = new byte[26];
                    RandomNumberGenerator.Fill(node.AsSpan(0, 20));
                    address.GetAddressBytes().CopyTo(node, 20);
                    BinaryPrimitives.WriteUInt16BigEndian(node.AsSpan(24), (ushort)router.Port);
                    return node;
                }).ToArray();
            }
            catch (Exception ex) when (ex is SocketException or TimeoutException)
            {
                log($"DHT router {router.Host} resolution failed: {ex.Message}");
                return [];
            }
        }));
        var initial = cached.Concat(seeds.SelectMany(nodes => nodes).SelectMany(node => node)).ToArray();
        // 3.0.2's built-in save is bencoded but its loader expects raw 26-byte nodes.
        // Add stores the seed list for subsequent client-driven DHT starts as well.
        engine.Add([initial]);
        engine.BeforeStop = SaveAsync;
        await engine.StartAsync();
        log($"DHT started with {ReloadedNodes} cached nodes and {seeds.Sum(nodes => nodes.Length)} router endpoints.");
    }

    public async Task TickAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await engine.StartAsync();
        var now = DateTimeOffset.UtcNow;
        if (engine.State == DhtState.Ready && engine.NodeCount < 120 && refreshRounds < 8 && now >= nextRefresh)
        {
            // Refresh a bounded range of routing buckets rather than relying on a single
            // unavailable router or waiting three minutes for a torrent's next announce.
            var id = (typeof(DhtEngine).GetProperty("LocalId", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new NotSupportedException("MonoTorrent DHT routing API changed."))
                .GetValue(engine)!;
            var bytes = ((ReadOnlyMemory<byte>)(id.GetType().GetMethod("AsMemory", Type.EmptyTypes)
                ?? throw new NotSupportedException("MonoTorrent DHT node ID API changed.")).Invoke(id, null)!).ToArray();
            for (var depth = 0; depth < 23; depth++)
            {
                var target = RandomNumberGenerator.GetBytes(20);
                var index = depth / 8;
                var bit = 7 - depth % 8;
                Array.Copy(bytes, target, index);
                var mask = (byte)(0xff << bit);
                target[index] = (byte)(((bytes[index] ^ (1 << bit)) & mask) | (target[index] & ~mask));
                engine.GetPeers(InfoHash.FromMemory(target));
            }
            refreshRounds++;
            nextRefresh = now.AddSeconds(15);
        }
        if (now >= nextSave)
        {
            await SaveAsync();
            nextSave = now.AddSeconds(60);
        }
    }

    public async Task SaveAsync()
    {
        await saving.WaitAsync();
        try
        {
            var encoded = await engine.SaveNodesAsync();
            var nodes = BEncodedValue.Decode<BEncodedList>(encoded.Span).OfType<BEncodedString>()
                .Where(n => n.Span.Length == 26).Take(4096).SelectMany(n => n.Span.ToArray()).ToArray();
            if (nodes.Length < 32 * 26) return; // Never replace a useful cache with an empty table.
            await File.WriteAllBytesAsync(path + ".new", nodes);
            File.Move(path + ".new", path, true);
        }
        finally { saving.Release(); }
    }
}
