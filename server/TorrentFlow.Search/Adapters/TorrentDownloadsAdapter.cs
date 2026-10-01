using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Adapters;

/// <summary>TorrentDownloads search RSS: every item carries the info hash, byte size, seeders and leechers.</summary>
public sealed class TorrentDownloadsAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "torrentdownloads";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var root = BaseUrl("https://www.torrentdownloads.pro");
        var doc = Feed(await Http.GetAsync($"{root}/rss.xml?type=search&search={EncodeUriComponent(o.Query.Trim())}", IndexerHttp.BrowserAgent,
            accept: "application/rss+xml, application/xml, text/xml, */*", cancellationToken: cancellationToken));
        return doc.Descendants("item").Take(o.Limit ?? 50).Select(r =>
        {
            var title = V(r, "title");
            var hash = HashFrom(V(r, "info_hash"));
            var link = V(r, "link");
            return new TorrentResult { Id = $"torrentdownloads-{hash ?? link}", Title = title, InfoHash = hash, Magnet = Magnet(hash ?? "", title, true),
                SizeBytes = long.TryParse(V(r, "size"), out var size) && size > 0 ? size : null,
                Seeders = int.TryParse(V(r, "seeders"), out var seeds) ? seeds : 0, Leechers = int.TryParse(V(r, "leechers"), out var peers) ? peers : 0,
                Category = CategoryHint(V(r, "category")), Source = Id, SourceUrl = link.StartsWith('/') ? root + link : link,
                PublishedAt = Date(V(r, "pubDate")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && r.InfoHash is not null).ToArray();
    }
}
