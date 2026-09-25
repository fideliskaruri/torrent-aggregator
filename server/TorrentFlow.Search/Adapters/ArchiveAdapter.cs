using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// Internet Archive (public-domain / CC films, TV and animation). Every item has an <c>{id}_archive.torrent</c> whose
/// name is the identifier and whose url-list is <c>archive.org/download/</c>, so HTTP webseeds make downloads fast even
/// with no peers. The advancedsearch index carries the torrent's <c>btih</c>, so one request covers the whole page.
/// </summary>
public sealed class ArchiveAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "archive";
    internal const string Webseed = "https://archive.org/download/";
    internal static readonly string[] Trackers = ["http://bt1.archive.org:6969/announce", "http://bt2.archive.org:6969/announce"];
    private static readonly string[] Fields = ["identifier", "title", "btih", "item_size", "downloads", "publicdate", "year", "mediatype"];

    /// <summary>Lucene query restricted to titles and moving images; category narrows by the Archive's own collections.</summary>
    internal static string? BuildQuery(string query, string category)
    {
        var text = Replace(query, @"[+\-&|!(){}\[\]^""~*?:\\/]", " ");
        var year = Match(text, @"\b(19\d{2}|20\d{2})\b") is { Success: true } y ? y.Groups[1].Value : null;
        var words = Replace(text, @"\b(19\d{2}|20\d{2})\b|\b\d{3,4}p\b|\b(AND|OR|NOT|TO)\b", " ")
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return null;
        var q = $"title:({string.Join(' ', words)}) AND mediatype:movies";
        if (year != null) q += $" AND (year:{year} OR title:{year})";
        return category switch
        {
            "tv" => q + " AND collection:(television OR classic_tv OR tvarchive OR television_inbox)",
            "anime" => q + " AND collection:(animationandcartoons OR classic_cartoons OR anime)",
            _ => q
        };
    }

    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (o.Category is not ("all" or "movies" or "tv" or "anime") || string.IsNullOrWhiteSpace(o.Query)) return [];
        var q = BuildQuery(o.Query.Trim(), o.Category);
        if (q == null) return [];
        var limit = Math.Clamp(o.Limit ?? 40, 1, 50);
        var root = (Setting("ARCHIVE_BASE_URL") ?? "https://archive.org").TrimEnd('/');
        var url = $"{root}/advancedsearch.php?q={EncodeUriComponent(q)}{string.Concat(Fields.Select(f => $"&fl[]={f}"))}&sort[]=downloads+desc&rows={limit}&page=1&output=json";
        using var doc = JsonDocument.Parse(await Http.GetAsync(url, timeoutMs: 10000, cancellationToken: cancellationToken));
        if (!doc.RootElement.TryGetProperty("response", out var response)) return [];
        var category = o.Category == "tv" ? "tv" : "movies";
        return Rows(response, "docs").Select(r => Map(r, category)).OfType<TorrentResult>().Take(limit).ToArray();
    }

    internal static string MagnetFor(string hash, string title) =>
        $"magnet:?xt=urn:btih:{hash}&dn={EncodeUriComponent(title)}{string.Concat(Trackers.Select(t => $"&tr={EncodeUriComponent(t)}"))}&ws={EncodeUriComponent(Webseed)}";

    private static TorrentResult? Map(JsonElement r, string category)
    {
        var id = First(r, "identifier");
        var hash = First(r, "btih").ToLowerInvariant();
        if (id.Length == 0 || !Match(hash, "^[0-9a-f]{40}$").Success) return null;
        var name = First(r, "title") is { Length: > 0 } t ? t.Trim() : id;
        var year = int.TryParse(First(r, "year"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var y) && y is > 1800 and < 2200 ? y : (int?)null;
        var title = year != null && !name.Contains(year.Value.ToString(CultureInfo.InvariantCulture)) ? $"{name} ({year})" : name;
        var encodedId = EncodeUriComponent(id);
        return new TorrentResult
        {
            Id = $"archive-{id}", Title = title, InfoHash = hash, Magnet = MagnetFor(hash, title),
            TorrentUrl = $"https://archive.org/download/{encodedId}/{encodedId}_archive.torrent",
            SizeBytes = L(r, "item_size") is > 0 and var size ? size : null,
            Seeders = 1, Leechers = 0, Completed = L(r, "downloads") > 0 ? I(r, "downloads") : null, Category = category,
            Source = "archive", SourceUrl = $"https://archive.org/details/{encodedId}", PublishedAt = Date(First(r, "publicdate")),
            Tags = [.. ReleaseQuality.ExtractTags(title).Append("Webseed").Distinct(StringComparer.OrdinalIgnoreCase)]
        };
    }

    /// <summary>Archive metadata fields are occasionally arrays (several titles or dates); the first value is canonical.</summary>
    private static string First(JsonElement row, string key) => row.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Array
        ? v.EnumerateArray().Select(x => x.ToString()).FirstOrDefault() ?? "" : S(row, key);
}
