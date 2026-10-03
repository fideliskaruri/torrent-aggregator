using System.Net;
using System.Text.Json;
using MonoTorrent;
using MonoTorrent.Client;

if (args.Length != 2 || !Uri.TryCreate(args[1], UriKind.Absolute, out var server) ||
    server.Scheme != "http" || server.UserInfo.Length != 0 ||
    !IPAddress.TryParse(server.Host, out var address) || !IPAddress.IsLoopback(address))
    throw new ArgumentException("Usage: Seeder <fixture directory> <loopback TorrentFlow HTTP URL>");

var home = Path.GetFullPath(args[0]);
using var engine = new ClientEngine(new EngineSettingsBuilder
{
    CacheDirectory = Path.Combine(home, "cache"),
    ListenEndPoints = new() { ["ipv4"] = new(IPAddress.Loopback, 0) },
    DhtEndPoint = null, AllowLocalPeerDiscovery = false, AllowPortForwarding = false,
    MaximumUploadRate = 20 * 1024 * 1024,
}.ToSettings());
var managers = new List<TorrentManager>();
foreach (var torrent in Directory.EnumerateFiles(home, "*.torrent"))
{
    var manager = await engine.AddAsync(torrent, Path.Combine(home, "seed"));
    await manager.HashCheckAsync(false);
    Console.WriteLine($"hash={manager.InfoHashes.V1OrV2.ToHex()} pieces={manager.Bitfield.TrueCount}/{manager.Bitfield.Length}");
    if (!manager.Bitfield.AllTrue)
        throw new InvalidOperationException($"The fixture for {Path.GetFileName(torrent)} is incomplete. Put its files directly in the seed folder.");
    manager.ConnectionAttemptFailed += (_, e) => Console.WriteLine($"failed={manager.InfoHashes.V1OrV2.ToHex()} reason={e.Reason}");
    manager.PeerConnected += (_, _) => Console.WriteLine($"connected={manager.InfoHashes.V1OrV2.ToHex()}");
    managers.Add(manager);
}
using var http = new HttpClient { BaseAddress = server, Timeout = TimeSpan.FromSeconds(2) };
var running = new HashSet<TorrentManager>();
var unavailable = false;
while (true)
{
    try
    {
        using var state = JsonDocument.Parse(await http.GetStringAsync("/api/dev/engine/torrents"));
        if (unavailable) Console.WriteLine("TorrentFlow is available again.");
        unavailable = false;
        var port = state.RootElement.GetProperty("listenPort").GetInt32();
        var active = state.RootElement.GetProperty("diagnostics").EnumerateArray()
            .Where(t => t.GetProperty("state").GetString() is "Metadata" or "Downloading" or "Seeding")
            .Select(t => t.GetProperty("hash").GetString()!).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var manager in managers)
        {
            // An open listener does not imply this hash exists: premature handshakes are rejected.
            if (!active.Contains(manager.InfoHashes.V1OrV2.ToHex()))
            {
                if (running.Remove(manager)) await manager.StopAsync(TimeSpan.Zero);
                continue;
            }
            if (manager.State == TorrentState.Stopped) await manager.StartAsync();
            running.Add(manager);
            var added = await manager.AddPeerAsync(new PeerInfo(new Uri($"ipv4://127.0.0.1:{port}")));
            if (added) Console.WriteLine($"inject hash={manager.InfoHashes.V1OrV2.ToHex()} port={port}");
        }
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        if (!unavailable) Console.WriteLine($"TorrentFlow at {server.GetLeftPart(UriPartial.Authority)} is unavailable: {ex.GetType().Name}");
        unavailable = true;
        foreach (var manager in running)
            await manager.StopAsync(TimeSpan.Zero);
        running.Clear();
    }
    await Task.Delay(250);
}
