using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Engine;

/// <summary>
/// Bound from TorrentFlow:Engine. Defaults are sized for the owner's RAM target (≤ 200 MB total process RSS
/// while a 13-episode season is handled): a small queue, capped connections and a small disk cache.
/// </summary>
public sealed class EngineOptions
{
    public const string Section = "TorrentFlow:Engine";
    public const string MaxActiveEnvVar = "TORRENTFLOW_MAX_ACTIVE_DOWNLOADS";

    /// <summary>Kept downloads transferring at once; the rest wait as "queued" rows outside the client.</summary>
    [Range(1, 100)] public int MaxActiveDownloads { get; set; } = Queue.DownloadQueue.DefaultMaxActiveDownloads;

    /// <summary>Global peer connection cap across all live torrents.</summary>
    [Range(1, 2000)] public int MaxConnections { get; set; } = 80;

    [Range(1, 500)] public int MaxConnectionsPerTorrent { get; set; } = 30;

    /// <summary>Speculative next-episode warming must not crowd out real transfers (TS prewarm peer cap was 20).</summary>
    [Range(1, 500)] public int PrewarmMaxConnections { get; set; } = 10;

    [Range(1, 200)] public int MaxHalfOpenConnections { get; set; } = 8;

    /// <summary>MonoTorrent write/read cache. Small on purpose: this is the dominant per-engine buffer.</summary>
    [Range(0, 1L << 30)] public long DiskCacheBytes { get; set; } = 4 * 1024 * 1024;

    [Range(1, 1000)] public int MaxOpenFiles { get; set; } = 20;

    public bool Dht { get; set; } = true;

    public bool PortForwarding { get; set; }

    public bool LocalPeerDiscovery { get; set; }

    /// <summary>TCP listen port for incoming peers; 0 lets the OS pick.</summary>
    [Range(0, 65535)] public int ListenPort { get; set; }

    /// <summary>Upload cap in bytes/s (0 = unlimited). WebTorrent throttled foreground uploads to 64 KiB/s.</summary>
    [Range(0, long.MaxValue)] public long MaxUploadRate { get; set; }

    [Range(1, 3600)] public int MetadataTimeoutSeconds { get; set; } = 90;

    /// <summary>How often live progress is persisted and completion is checked.</summary>
    [Range(1, 300)] public int MonitorIntervalSeconds { get; set; } = 5;

    /// <summary>Extra trackers appended to magnets (never replacing the release's own).</summary>
    public List<string> PublicTrackers { get; set; } =
    [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://open.demonii.com:1337/announce",
    ];

    /// <summary>Set by the module from TorrentFlow:DataDirectory; fast resume + DHT cache live under it.</summary>
    public string DataDirectory { get; set; } = "";

    public string EngineDirectory => Path.Combine(DataDirectory, "engine");
}
