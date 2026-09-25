using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Engine;

/// <summary>
/// Bound from TorrentFlow:Engine. The queue keeps only a few transfers live (the RAM win); within those, the defaults
/// favour speed: enough peer slots to use a healthy swarm, UPnP/NAT-PMP so peers can dial in, and a disk cache big
/// enough that writes keep up with a fast line.
/// </summary>
public sealed class EngineOptions
{
    public const string Section = "TorrentFlow:Engine";
    public const string MaxActiveEnvVar = "TORRENTFLOW_MAX_ACTIVE_DOWNLOADS";

    /// <summary>Kept downloads transferring at once; the rest wait as "queued" rows outside the client.</summary>
    [Range(1, 100)] public int MaxActiveDownloads { get; set; } = Queue.DownloadQueue.DefaultMaxActiveDownloads;

    /// <summary>Global peer connection cap across all live torrents.</summary>
    [Range(1, 2000)] public int MaxConnections { get; set; } = 400;

    [Range(1, 500)] public int MaxConnectionsPerTorrent { get; set; } = 120;

    /// <summary>Speculative next-episode warming must not crowd out real transfers (TS prewarm peer cap was 20).</summary>
    [Range(1, 500)] public int PrewarmMaxConnections { get; set; } = 10;

    [Range(1, 200)] public int MaxHalfOpenConnections { get; set; } = 40;

    /// <summary>MonoTorrent write/read cache, shared by all live torrents. Too small and writes throttle a fast line.</summary>
    [Range(0, 1L << 30)] public long DiskCacheBytes { get; set; } = 32 * 1024 * 1024;

    [Range(1, 1000)] public int MaxOpenFiles { get; set; } = 40;

    public bool Dht { get; set; } = true;

    /// <summary>UPnP / NAT-PMP mapping of the listen port, so peers behind other NATs can connect to us.</summary>
    public bool PortForwarding { get; set; } = true;

    public bool LocalPeerDiscovery { get; set; } = true;

    /// <summary>TCP listen port for incoming peers; 0 lets the OS pick.</summary>
    [Range(0, 65535)] public int ListenPort { get; set; }

    /// <summary>Upload cap in bytes/s (0 = unlimited). WebTorrent throttled foreground uploads to 64 KiB/s.</summary>
    [Range(0, long.MaxValue)] public long MaxUploadRate { get; set; }

    [Range(1, 3600)] public int MetadataTimeoutSeconds { get; set; } = 90;

    /// <summary>How often live progress is persisted and completion is checked.</summary>
    [Range(1, 300)] public int MonitorIntervalSeconds { get; set; } = 5;

    /// <summary>Extra trackers added to every public torrent (never replacing the release's own).</summary>
    public List<string> PublicTrackers { get; set; } =
    [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.tiny-vps.com:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.dler.org:6969/announce",
        "https://tracker.opentrackr.org:443/announce",
    ];

    /// <summary>Set by the module from TorrentFlow:DataDirectory; fast resume + DHT cache live under it.</summary>
    public string DataDirectory { get; set; } = "";

    public string EngineDirectory => Path.Combine(DataDirectory, "engine");
}
