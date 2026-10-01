using AngleSharp.Html.Parser;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Adapters;

/// <summary>BitSearch (the SolidTorrents DHT index) search page: each result card carries its magnet, size, category and swarm counts.</summary>
public sealed class BitSearchAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "bitsearch";
    private const string Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var root = BaseUrl("https://bitsearch.to");
        var html = await Http.GetAsync($"{root}/search?q={EncodeUriComponent(o.Query.Trim())}", IndexerHttp.BrowserAgent, accept: Accept, cancellationToken: cancellationToken);
        if (html.Contains("Just a moment") || html.Contains("cf-browser-verification")) throw new HttpRequestException("BitSearch blocked by Cloudflare");
        var doc = await new HtmlParser().ParseDocumentAsync(html, cancellationToken);
        return doc.QuerySelectorAll("div.bg-white").Where(card => card.QuerySelector("a[href^='magnet:']") is not null && card.QuerySelector("h3 a") is not null)
            .Take(o.Limit ?? 50).Select(card =>
            {
                var link = card.QuerySelector("h3 a")!;
                var title = link.TextContent.Trim();
                var magnet = card.QuerySelector("a[href^='magnet:']")!.GetAttribute("href") ?? "";
                var hash = HashFrom(magnet);
                // Stats row order: category, size, date.
                var facts = card.QuerySelectorAll("div.text-sm.text-gray-600 > span > span").Select(s => s.TextContent.Trim()).ToArray();
                int Count(string colour) => int.TryParse(card.QuerySelector($"span.{colour} span.font-medium")?.TextContent.Trim(), out var n) ? n : 0;
                var size = facts.Length > 1 ? facts[1] : null;
                var path = link.GetAttribute("href") ?? "";
                return new TorrentResult { Id = $"bitsearch-{hash ?? path}", Title = title, InfoHash = hash, Magnet = hash is null ? null : magnet,
                    SizeBytes = Size(size), SizeLabel = size, Seeders = Count("text-green-600"), Leechers = Count("text-red-600"),
                    Category = CategoryHint(facts.FirstOrDefault()), Source = Id, SourceUrl = path.StartsWith('/') ? root + path : path,
                    PublishedAt = facts.Length > 2 && DateTime.TryParseExact(facts[2], "M/d/yyyy", System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var date)
                        ? date.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") : null,
                    Tags = ReleaseQuality.ExtractTags(title) };
            }).Where(r => r.Title.Length > 0 && r.InfoHash is not null).ToArray();
    }
}
