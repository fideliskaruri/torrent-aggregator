using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Configuration;

namespace TorrentFlow.Search;

public sealed class SearchModuleOptions
{
    /// <summary>Process-wide bounds; shared searches continue after a request disconnects, but stop with the host.</summary>
    [Range(1, 256)]
    public int MaxConcurrentAdapters { get; set; } = 24;
    [Range(1, 256)]
    public int MaxConcurrentSearches { get; set; } = 64;
    [Range(1, 600_000)]
    public int AdapterLifetimeMs { get; set; } = 180_000;

    /// <summary>
    /// Pacing toward each search site, keyed by host (TorrentFlow:Search:Pacing:apibay.org:SpacingMs). Requests queue for
    /// their site instead of all firing at once, so a burst of season downloads never trips the site's own limit.
    /// </summary>
    public Dictionary<string, SourcePacing> Pacing { get; set; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["apibay.org"] = new() { Concurrency = 2, SpacingMs = 2000 },
        ["nyaa.si"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["api.knaben.org"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["bitsearch.to"] = new() { Concurrency = 1, SpacingMs = 1500 },
        ["limetorrents.fun"] = new() { Concurrency = 1, SpacingMs = 1500 },
        ["limetorrents.lol"] = new() { Concurrency = 1, SpacingMs = 1500 },
        ["torrentdownloads.pro"] = new() { Concurrency = 1, SpacingMs = 1500 },
        ["feed.animetosho.org"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["subsplease.org"] = new() { Concurrency = 1, SpacingMs = 1000 },
        ["therarbg.com"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["therarbg.to"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["torrentgalaxy.one"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["torrentgalaxy.info"] = new() { Concurrency = 2, SpacingMs = 1000 },
        ["torrentdownload.info"] = new() { Concurrency = 1, SpacingMs = 1500 },
    };
    /// <summary>Pacing for any site not listed in <see cref="Pacing"/>.</summary>
    public SourcePacing DefaultPacing { get; set; } = new() { Concurrency = 2, SpacingMs = 250 };

    [ConfigurationKeyName("NYAA_BASE_URL"), Url]
    public string? NyaaBaseUrl { get; set; }
    [ConfigurationKeyName("APIBAY_BASE_URL"), Url]
    public string? ApiBayBaseUrl { get; set; }
    [ConfigurationKeyName("TORRENTS_CSV_BASE_URL"), Url]
    public string? TorrentsCsvBaseUrl { get; set; }
    [ConfigurationKeyName("X1337_BASE_URL"), Url]
    public string? X1337BaseUrl { get; set; }
    [ConfigurationKeyName("YTS_BASE_URL")]
    public string? YtsBaseUrl { get; set; }
    [ConfigurationKeyName("EZTV_BASE_URL")]
    public string? EztvBaseUrl { get; set; }
    [ConfigurationKeyName("TMDB_BASE_URL"), Url]
    public string? TmdbBaseUrl { get; set; }
    [ConfigurationKeyName("TMDB_API_KEY")]
    public string? TmdbApiKey { get; set; }
    [ConfigurationKeyName("ENABLE_1337X"), RegularExpression("^[01]$")]
    public string? Enable1337X { get; set; }
    [ConfigurationKeyName("X1337_USE_PLAYWRIGHT"), RegularExpression("^[01]$")]
    public string? Use1337Browser { get; set; }
    public string? BrowserExecutable { get; set; }
    [ConfigurationKeyName("ARCHIVE_BASE_URL"), Url]
    public string? ArchiveBaseUrl { get; set; }
    /// <summary>Internet Archive is opt-in: its swarms are tiny and magnet-only metadata fetches stall.</summary>
    [ConfigurationKeyName("ENABLE_ARCHIVE"), RegularExpression("^[01]$")]
    public string? EnableArchive { get; set; }
    /// <summary>Full Torznab api endpoint (Jackett/Prowlarr). The torznab source is off while this is empty.</summary>
    [ConfigurationKeyName("TORZNAB_URL"), Url]
    public string? TorznabUrl { get; set; }
    [ConfigurationKeyName("TORZNAB_API_KEY")]
    public string? TorznabApiKey { get; set; }
    /// <summary>Endpoint handed to a registry-driven adapter (its base URL or one of its mirrors); adapters without a legacy setting read it.</summary>
    public string? SourceBaseUrl { get; set; }
    internal string? Setting(string key) => (key switch
    {
        "NYAA_BASE_URL" => NyaaBaseUrl, "APIBAY_BASE_URL" => ApiBayBaseUrl,
        "TORRENTS_CSV_BASE_URL" => TorrentsCsvBaseUrl, "X1337_BASE_URL" => X1337BaseUrl,
        "YTS_BASE_URL" => YtsBaseUrl, "EZTV_BASE_URL" => EztvBaseUrl,
        "TMDB_BASE_URL" => TmdbBaseUrl, "TMDB_API_KEY" => TmdbApiKey,
        "ENABLE_1337X" => Enable1337X, "X1337_USE_PLAYWRIGHT" => Use1337Browser,
        "ARCHIVE_BASE_URL" => ArchiveBaseUrl, "ENABLE_ARCHIVE" => EnableArchive, "TORZNAB_URL" => TorznabUrl, "TORZNAB_API_KEY" => TorznabApiKey, _ => null
    }) ?? Environment.GetEnvironmentVariable(key);
}

/// <summary>How many requests may be open to one site at once, and the minimum gap between two request starts.</summary>
public sealed class SourcePacing
{
    [Range(1, 32)]
    public int Concurrency { get; set; } = 2;
    [Range(0, 60_000)]
    public int SpacingMs { get; set; }
}
