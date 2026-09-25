using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Configuration;

namespace TorrentFlow.Search;

public sealed class SearchModuleOptions
{
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

    internal string? Setting(string key) => (key switch
    {
        "NYAA_BASE_URL" => NyaaBaseUrl, "APIBAY_BASE_URL" => ApiBayBaseUrl,
        "TORRENTS_CSV_BASE_URL" => TorrentsCsvBaseUrl, "X1337_BASE_URL" => X1337BaseUrl,
        "YTS_BASE_URL" => YtsBaseUrl, "EZTV_BASE_URL" => EztvBaseUrl,
        "TMDB_BASE_URL" => TmdbBaseUrl, "TMDB_API_KEY" => TmdbApiKey,
        "ENABLE_1337X" => Enable1337X, "X1337_USE_PLAYWRIGHT" => Use1337Browser, _ => null
    }) ?? Environment.GetEnvironmentVariable(key);
}
