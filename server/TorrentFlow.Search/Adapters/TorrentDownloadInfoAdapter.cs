using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Core.ReleaseEpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// TorrentDownload.info search RSS, a meta-search: each item's description carries size, seeds, peers and the info hash.
/// Its titles are slugs (spaces and dots become hyphens), so other sources' names win when the same hash appears twice.
/// </summary>
public sealed class TorrentDownloadInfoAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "torrentdownloadinfo";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var root = BaseUrl("https://www.torrentdownload.info");
        var doc = Feed(await Http.GetAsync($"{root}/feed?q={EncodeUriComponent(o.Query.Trim())}", IndexerHttp.BrowserAgent,
            accept: "application/rss+xml, application/xml, text/xml, */*", cancellationToken: cancellationToken));
        return doc.Descendants("item").Take(o.Limit ?? 50).Select(r =>
        {
            var title = V(r, "title");
            var about = V(r, "description");
            var link = V(r, "link");
            var hash = HashFrom(Match(about, @"Hash:\s*([0-9a-f]{40})").Groups[1].Value) ?? HashFrom(link);
            return new TorrentResult { Id = $"torrentdownloadinfo-{hash ?? link}", Title = title, InfoHash = hash, Magnet = Magnet(hash ?? "", title, true),
                SizeBytes = Size(Match(about, @"Size:\s*([\d.,]+\s*[kmgt]?i?b)\b").Groups[1].Value),
                Seeders = int.TryParse(Match(about, @"Seeds:\s*([\d,]+)").Groups[1].Value.Replace(",", ""), out var seeds) ? seeds : 0,
                Leechers = int.TryParse(Match(about, @"Peers:\s*([\d,]+)").Groups[1].Value.Replace(",", ""), out var peers) ? peers : 0,
                Source = Id, SourceUrl = link.StartsWith('/') ? root + link : link, PublishedAt = Date(V(r, "pubDate")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && r.InfoHash is not null).ToArray();
    }
}
