namespace TorrentFlow.Sources;

internal static class SourceDefaults
{
    // Tier/enabled/courtesy defaults belong to Store's typed settings, not this endpoint catalog.
    internal static readonly IReadOnlyDictionary<string, string> Endpoints = new Dictionary<string, string>
    {
        ["apibay"] = "https://apibay.org",
        ["nyaa"] = "https://nyaa.si",
        ["eztv"] = "https://eztvx.to/api",
        ["yts"] = "https://yts.gg/api/v2",
        ["torrentscsv"] = "https://torrents-csv.com/service/search",
        ["knaben"] = "https://api.knaben.org/v1",
        ["animetosho"] = "https://feed.animetosho.net",
        ["therarbg"] = "https://therarbg.com",
        ["bitsearch"] = "https://bitsearch.to",
        ["limetorrents"] = "https://www.limetorrents.fun",
        ["torrentdownloads"] = "https://www.torrentdownloads.pro",
        ["torrentdownloadinfo"] = "https://www.torrentdownload.info",
        ["1337x"] = "https://1337x.to",
        ["subsplease"] = "https://subsplease.org",
        ["archive"] = "https://archive.org"
    };
}
