using System.Text.Json;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Adapters;

/// <summary>Knaben meta-search (https://knaben.org/api): a keyless JSON API over cached TPB, 1337x, TorrentGalaxy, RARBG, Nyaa and more.</summary>
public sealed class KnabenAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "knaben";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var limit = Math.Clamp(o.Limit ?? 50, 1, 100);
        // Knaben's top-level category ids: 2000000 TV, 3000000 Movies, 6000000 Anime.
        int[]? categories = o.Category switch { "tv" => [2000000], "movies" => [3000000], "anime" => [6000000], _ => null };
        var request = new Dictionary<string, object>
        {
            ["search_type"] = "100%", ["search_field"] = "title", ["query"] = o.Query.Trim(), ["order_by"] = "seeders", ["order_direction"] = "desc",
            ["size"] = limit, ["hide_unsafe"] = true, ["hide_xxx"] = true,
        };
        if (categories is not null) request["categories"] = categories;
        var body = JsonSerializer.Serialize(request);
        using var doc = JsonDocument.Parse(await Http.GetAsync(BaseUrl("https://api.knaben.org/v1"), IndexerHttp.BrowserAgent, 12000,
            "application/json", cancellationToken, jsonBody: body));
        return Rows(doc.RootElement, "hits").Select(r =>
        {
            var title = S(r, "title").Trim();
            var hash = S(r, "hash").ToLowerInvariant();
            var magnet = S(r, "magnetUrl");
            return new TorrentResult { Id = $"knaben-{(S(r, "id") is { Length: > 0 } id ? id : hash)}", Title = title, InfoHash = hash.Length == 40 ? hash : HashFrom(magnet),
                Magnet = magnet.StartsWith("magnet:", StringComparison.Ordinal) ? magnet : Magnet(hash, title, true), TorrentUrl = S(r, "link") is { Length: > 0 } link ? link : null,
                SizeBytes = L(r, "bytes") is > 0 and var size ? size : null, Seeders = I(r, "seeders"), Leechers = I(r, "peers"), Completed = I(r, "grabs"),
                Category = CategoryHint(S(r, "category")), Source = Id, SourceUrl = S(r, "details") is { Length: > 0 } details ? details : "https://knaben.org",
                PublishedAt = Date(S(r, "date")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && (r.InfoHash?.Length > 0 || r.TorrentUrl?.Length > 0)).ToArray();
    }
}
