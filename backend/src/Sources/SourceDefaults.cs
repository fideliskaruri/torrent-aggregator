namespace TorrentFlow.Sources;

internal static class SourceDefaults
{
    // Tier/enabled/courtesy defaults belong to Store's typed settings, not this endpoint catalog.
    internal static readonly IReadOnlyDictionary<string, string> Endpoints = new Dictionary<string, string>
    {
        ["apibay"] = "https://apibay.org",
        ["nyaa"] = "https://nyaa.si",
        ["eztv"] = "https://eztv.re/api",
        ["yts"] = "https://yts.lt/api/v2",
        ["torrentscsv"] = "https://torrents-csv.com/service/search",
        ["knaben"] = "https://api.knaben.org/v1",
        ["animetosho"] = "https://feed.animetosho.net"
    };
}
