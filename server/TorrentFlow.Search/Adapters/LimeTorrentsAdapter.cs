using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Core.ReleaseEpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>LimeTorrents search RSS: title, byte size, category, seeds/leechers in the description and an itorrents link carrying the info hash.</summary>
public sealed class LimeTorrentsAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "limetorrents";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var root = BaseUrl("https://www.limetorrents.fun");
        var query = EncodeUriComponent(Replace(o.Query.Trim(), @"\s+", "-"));
        var doc = Feed(await Http.GetAsync($"{root}/searchrss/{query}/", IndexerHttp.BrowserAgent, accept: "application/rss+xml, application/xml, text/xml, */*", cancellationToken: cancellationToken));
        return doc.Descendants("item").Take(o.Limit ?? 50).Select(r =>
        {
            var title = V(r, "title");
            var torrent = r.Element("enclosure")?.Attribute("url")?.Value;
            var hash = HashFrom(torrent);
            var swarm = Match(V(r, "description"), @"Seeds:\s*(\d+)\D+?Leechers:?\s*(\d+)");
            return new TorrentResult { Id = $"limetorrents-{hash ?? V(r, "link")}", Title = title, InfoHash = hash, Magnet = Magnet(hash ?? "", title, true), TorrentUrl = torrent,
                SizeBytes = long.TryParse(V(r, "size"), out var size) && size > 0 ? size : null,
                Seeders = swarm.Success ? int.Parse(swarm.Groups[1].Value) : 0, Leechers = swarm.Success ? int.Parse(swarm.Groups[2].Value) : 0,
                Category = CategoryHint(V(r, "category")), Source = Id, SourceUrl = V(r, "link"), PublishedAt = Date(V(r, "pubDate")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && r.InfoHash is not null).ToArray();
    }
}
