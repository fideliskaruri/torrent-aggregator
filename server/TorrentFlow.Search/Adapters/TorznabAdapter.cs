using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// Generic Torznab client (Jackett, Prowlarr, or any indexer speaking the standard). Off unless TORZNAB_URL names a
/// full api endpoint, e.g. <c>http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api</c>.
/// </summary>
public sealed class TorznabAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "torznab";
    private static readonly XNamespace Torznab = "http://torznab.com/schemas/2015/feed";
    private const string Accept = "application/rss+xml, application/xml, text/xml, */*";

    public bool Configured => !string.IsNullOrWhiteSpace(Setting("TORZNAB_URL"));

    /// <summary>Newznab/Torznab standard category roots.</summary>
    internal static string? Categories(string category) => category switch
    {
        "movies" => "2000", "tv" => "5000", "anime" => "5070", "music" => "3000", "apps" => "4000", "games" => "1000,4050", "books" => "7000", _ => null
    };

    internal string BuildUrl(string function, SearchOptions o, int limit)
    {
        var endpoint = Setting("TORZNAB_URL")!.Trim();
        var key = Setting("TORZNAB_API_KEY");
        var cat = Categories(o.Category);
        return $"{endpoint}{(endpoint.Contains('?') ? "&" : "?")}t={function}&q={EncodeUriComponent(o.Query.Trim())}&limit={limit}"
            + (cat == null ? "" : $"&cat={cat}") + (string.IsNullOrWhiteSpace(key) ? "" : $"&apikey={EncodeUriComponent(key.Trim())}");
    }

    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (!Configured || string.IsNullOrWhiteSpace(o.Query)) return [];
        var limit = Math.Clamp(o.Limit ?? 50, 1, 100);
        var function = o.Category switch { "tv" or "anime" => "tvsearch", "movies" => "movie", _ => "search" };
        string xml;
        try
        {
            xml = await Http.GetAsync(BuildUrl(function, o, limit), IndexerHttp.BrowserAgent, 15000, Accept, cancellationToken);
            if (function != "search" && Error(xml) != null) xml = await Http.GetAsync(BuildUrl("search", o, limit), IndexerHttp.BrowserAgent, 15000, Accept, cancellationToken);
        }
        catch (HttpRequestException e) when (function != "search" && e.StatusCode is { } status && (int)status is >= 400 and < 500 && (int)status is not (401 or 403 or 429))
        {
            xml = await Http.GetAsync(BuildUrl("search", o, limit), IndexerHttp.BrowserAgent, 15000, Accept, cancellationToken);
        }
        if (Error(xml) is { } error) throw new HttpRequestException($"Torznab error: {error}");
        return Parse(xml, Id).Take(limit).ToArray();
    }

    private static XDocument Load(string xml)
    {
        using var reader = System.Xml.XmlReader.Create(new StringReader(xml), new() { DtdProcessing = System.Xml.DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024 });
        return XDocument.Load(reader);
    }

    /// <summary>Torznab reports failures as <c>&lt;error code=".." description=".."/&gt;</c> with HTTP 200.</summary>
    internal static string? Error(string xml)
    {
        try
        {
            var root = Load(xml).Root;
            return root?.Name.LocalName == "error" ? $"{(string?)root.Attribute("code")} {(string?)root.Attribute("description")}".Trim() : null;
        }
        catch (System.Xml.XmlException) { return "invalid XML response"; }
    }

    internal static IEnumerable<TorrentResult> Parse(string xml, string source = "torznab")
    {
        foreach (var item in Load(xml).Descendants("item"))
        {
            string V(string name) => item.Element(name)?.Value.Trim() ?? "";
            var attrs = item.Elements(Torznab + "attr").Concat(item.Elements().Where(e => e.Name.LocalName == "attr" && e.Name.Namespace != Torznab))
                .GroupBy(a => ((string?)a.Attribute("name") ?? "").ToLowerInvariant())
                .ToDictionary(g => g.Key, g => g.Select(a => ((string?)a.Attribute("value") ?? "").Trim()).ToArray());
            string A(string name) => attrs.TryGetValue(name, out var v) ? v.FirstOrDefault(x => x.Length > 0) ?? "" : "";
            long N(string name) => long.TryParse(A(name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : -1;

            var title = V("title");
            if (title.Length == 0) continue;
            var link = V("link");
            var enclosure = (string?)item.Element("enclosure")?.Attribute("url") ?? "";
            var magnet = A("magneturl") is { Length: > 0 } m && m.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase) ? m
                : link.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase) ? link
                : enclosure.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase) ? enclosure : null;
            var hash = A("infohash").ToLowerInvariant();
            if (hash.Length == 0 && magnet != null) hash = Match(magnet, "btih:([a-zA-Z0-9]{32,40})").Groups[1].Value.ToLowerInvariant();
            magnet ??= Magnet(hash, title);
            var download = new[] { link, enclosure }.FirstOrDefault(u => Uri.TryCreate(u, UriKind.Absolute, out var x) && x.Scheme is "http" or "https");
            if (magnet == null && download == null) continue;

            var seeders = N("seeders");
            var peers = N("peers");
            var leechers = N("leechers") is >= 0 and var l ? l : peers >= 0 ? Math.Max(0, peers - Math.Max(0, seeders)) : 0;
            var size = long.TryParse(V("size"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) && s > 0 ? s
                : N("size") is > 0 and var sa ? sa : long.TryParse((string?)item.Element("enclosure")?.Attribute("length"), out var el) && el > 0 ? el : (long?)null;
            var guid = V("guid");
            var details = new[] { V("comments"), guid, download ?? "" }.FirstOrDefault(u => Uri.TryCreate(u, UriKind.Absolute, out var x) && x.Scheme is "http" or "https") ?? "";
            var indexer = item.Elements().FirstOrDefault(e => e.Name.LocalName is "jackettindexer" or "prowlarrindexer")?.Value.Trim();
            var key = hash.Length > 0 ? hash : Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(guid.Length > 0 ? guid : title + download)))[..16];
            var categories = attrs.TryGetValue("category", out var cats) ? cats : [];
            yield return new TorrentResult
            {
                Id = $"{source}-{key}", Title = title, InfoHash = hash.Length > 0 ? hash : null, Magnet = magnet,
                TorrentUrl = download,
                SizeBytes = size, Seeders = (int)Math.Clamp(seeders, 0, int.MaxValue), Leechers = (int)Math.Clamp(leechers, 0, int.MaxValue),
                Completed = N("grabs") is >= 0 and var g ? (int)Math.Min(g, int.MaxValue) : null,
                Category = Category(categories.Length > 0 ? categories : [V("category")]), Source = source, SourceUrl = details,
                PublishedAt = Date(V("pubDate")),
                Tags = [.. ReleaseQuality.ExtractTags(title).Concat(indexer is { Length: > 0 } ? [indexer] : Array.Empty<string>()).Distinct(StringComparer.OrdinalIgnoreCase)]
            };
        }
    }

    /// <summary>Maps Newznab numeric categories to the app's search categories; other values pass through.</summary>
    internal static string? Category(IReadOnlyCollection<string> values)
    {
        if (values.Contains("5070")) return "anime";
        foreach (var value in values)
        {
            if (!int.TryParse(value, out var c)) { if (value.Length > 0) return value; continue; }
            var mapped = c switch { 5070 => "anime", >= 2000 and < 3000 => "movies", >= 5000 and < 6000 => "tv", >= 3000 and < 4000 => "music",
                >= 4050 and < 4060 or >= 1000 and < 2000 => "games", >= 4000 and < 5000 => "apps", >= 7000 and < 8000 => "books", _ => null };
            if (mapped != null) return mapped;
        }
        return null;
    }
}
