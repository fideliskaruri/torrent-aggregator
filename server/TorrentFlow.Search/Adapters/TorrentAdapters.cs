using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using AngleSharp.Html.Parser;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search.Adapters;

public interface ITorrentSourceAdapter
{
    string Id { get; }
    Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default);
}

public abstract class TorrentAdapter(IndexerHttp http, IConfiguration configuration) : ITorrentSourceAdapter
{
    public abstract string Id { get; }
    protected IndexerHttp Http => http;
    protected string? Setting(string key) => configuration[$"TorrentFlow:Search:{key}"] ?? Environment.GetEnvironmentVariable(key);
    protected static string S(JsonElement row, string key) => row.TryGetProperty(key, out var value) && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? value.ToString() : "";
    protected static long L(JsonElement row, string key) => long.TryParse(S(row, key), out var n) ? n : 0;
    protected static int I(JsonElement row, string key) => (int)Math.Clamp(L(row, key), 0, int.MaxValue);
    protected static IEnumerable<JsonElement> Rows(JsonElement row, string key) => row.TryGetProperty(key, out var a) && a.ValueKind == JsonValueKind.Array ? a.EnumerateArray() : [];
    protected static string? Date(string? value) => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") : null;
    protected static string? Unix(long value) => value > 0 && value < 253402300800 ? DateTimeOffset.FromUnixTimeSeconds(value).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") : null;
    protected static string? Magnet(string hash, string title, bool tracker = false) => string.IsNullOrEmpty(hash) ? null
        : $"magnet:?xt=urn:btih:{hash}&dn={Uri.EscapeDataString(title)}{(tracker ? "&tr=udp://tracker.opentrackr.org:1337/announce" : "")}";
    public static long? Size(string? value)
    {
        var m = Match(value ?? "", @"^([\d.,]+)\s*([kmgt]?i?b)$");
        if (!m.Success || !double.TryParse(m.Groups[1].Value.Replace(",", ""), CultureInfo.InvariantCulture, out var number)) return null;
        var unit = m.Groups[2].Value.ToLowerInvariant();
        var exponent = "kmgt".IndexOf(unit[0]) + 1;
        return (long)Math.Floor(number * Math.Pow(unit.Contains('i') ? 1024 : 1000, exponent) + .5);
    }
    public abstract Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default);
}

public sealed class ApiBayAdapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "apibay";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var cat = o.Category switch { "music" => "101", "games" => "401", "apps" => "301", _ => "0" };
        var json = await Http.GetAsync($"{Setting("APIBAY_BASE_URL") ?? "https://apibay.org"}/q.php?q={Uri.EscapeDataString(o.Query.Trim())}&cat={cat}", IndexerHttp.BrowserAgent, accept: "application/json, text/plain, */*", cancellationToken: cancellationToken);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
        var rows = doc.RootElement.EnumerateArray().Where(r => !(S(r, "id") == "0" && S(r, "name") == "No results returned"))
            .Where(r => o.Category switch { "tv" => new[] { "205", "208", "212" }.Contains(S(r, "category")), "movies" => new[] { "201", "202", "207", "209", "210", "211" }.Contains(S(r, "category")), _ => true });
        return rows.Take(o.Limit ?? 40).Select((r, i) =>
        {
            var title = S(r, "name"); var hash = S(r, "info_hash").ToLowerInvariant();
            return new TorrentResult { Id = $"apibay-{S(r, "id")}", Title = title, InfoHash = hash, Magnet = Magnet(hash, title, true),
                SizeBytes = L(r, "size") is > 0 and var size ? size : null, Seeders = I(r, "seeders"), Leechers = I(r, "leechers"), Category = S(r, "category"),
                Source = Id, SourceUrl = $"https://thepiratebay.org/description.php?id={S(r, "id")}", PublishedAt = Unix(L(r, "added")), Tags = ReleaseQuality.ExtractTags(title) };
        }).ToArray();
    }
}

public sealed class TorrentsCsvAdapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "torrentscsv";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var limit = Math.Min(o.Limit ?? 40, 50);
        using var doc = JsonDocument.Parse(await Http.GetAsync($"{Setting("TORRENTS_CSV_BASE_URL") ?? "https://torrents-csv.com/service/search"}?q={Uri.EscapeDataString(o.Query.Trim())}&size={limit}", cancellationToken: cancellationToken));
        return Rows(doc.RootElement, "torrents").Take(limit).Select((r, i) =>
        {
            var title = S(r, "name"); var hash = S(r, "infohash").ToLowerInvariant();
            return new TorrentResult { Id = $"torrentscsv-{(S(r, "id") is { Length: > 0 } id ? id : hash)}", Title = title, InfoHash = hash, Magnet = Magnet(hash, title),
                SizeBytes = r.TryGetProperty("size_bytes", out _) ? L(r, "size_bytes") : null, Seeders = I(r, "seeders"), Leechers = I(r, "leechers"),
                Completed = r.TryGetProperty("completed", out _) ? I(r, "completed") : null, Source = Id,
                SourceUrl = $"https://torrents-csv.com/#/search/torrent/{Uri.EscapeDataString(title)}/1", PublishedAt = Unix(L(r, "created_unix")), Tags = ReleaseQuality.ExtractTags(title) };
        }).ToArray();
    }
}

public sealed class NyaaAdapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "nyaa";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        var cat = o.Category switch { "anime" => "1_0", "movies" or "tv" => "4_0", "music" => "2_0", "apps" => "3_0", "games" => "6_0", _ => "0_0" };
        var xml = await Http.GetAsync($"{Setting("NYAA_BASE_URL") ?? "https://nyaa.si"}/?page=rss&q={Uri.EscapeDataString(o.Query.Trim())}&c={cat}&f=0",
            "TorrentAggregator/1.0 (+https://github.com/local/torrent-aggregator)", accept: "application/rss+xml, application/xml, text/xml, */*", cancellationToken: cancellationToken);
        using var reader = System.Xml.XmlReader.Create(new StringReader(xml), new() { DtdProcessing = System.Xml.DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024 });
        var doc = XDocument.Load(reader);
        return doc.Descendants("item").Take(o.Limit ?? 40).Select((r, i) =>
        {
            string V(string key) => r.Elements().FirstOrDefault(e => e.Name.LocalName.Equals(key, StringComparison.OrdinalIgnoreCase))?.Value.Trim() ?? "";
            int Num(string key) => int.TryParse(V(key), out var n) ? n : 0;
            var title = V("title"); var link = V("link"); var hash = V("infoHash").ToLowerInvariant();
            var suffix = Convert.ToBase64String(Encoding.UTF8.GetBytes(title)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return new TorrentResult { Id = $"nyaa-{(hash.Length > 0 ? hash : i.ToString())}-{suffix[..Math.Min(12, suffix.Length)]}", Title = title,
                InfoHash = hash.Length > 0 ? hash : null, Magnet = Magnet(hash, title), TorrentUrl = link.Contains(".torrent") ? link : V("guid").Contains("download") ? V("guid") : link,
                SizeBytes = Size(V("size")), SizeLabel = V("size"), Seeders = Num("seeders"), Leechers = Num("leechers"), Completed = Num("downloads"),
                Category = V("category"), Source = Id, SourceUrl = Replace(link, @"/download/.*", ""), PublishedAt = Date(V("pubDate")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && r.TorrentUrl?.Length > 0).ToArray();
    }
}

public sealed class YtsAdapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "yts";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (o.Category is not ("all" or "movies") || string.IsNullOrWhiteSpace(o.Query)) return [];
        var hosts = IndexerHttp.MirrorList(Setting("YTS_BASE_URL"), "https://yts.mx/api/v2", "https://yts.lt/api/v2", "https://movies-api.accel.li/api/v2");
        var json = await Http.MirrorsAsync(Id, hosts, h => $"{h}/list_movies.json?query_term={Uri.EscapeDataString(o.Query.Trim())}&limit={Math.Min(o.Limit ?? 20, 50)}&sort_by=seeds", "TorrentFlow/1.0", cancellationToken);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var data)) return [];
        List<TorrentResult> results = [];
        foreach (var movie in Rows(data, "movies"))
        foreach (var t in Rows(movie, "torrents"))
        {
            var name = S(movie, "title_long") is { Length: > 0 } longTitle ? longTitle : S(movie, "title");
            var title = $"{name} [{S(t, "quality")}] [{S(t, "type")}] [YTS]";
            var hash = S(t, "hash").ToLowerInvariant();
            results.Add(new() { Id = $"yts-{S(movie, "id")}-{S(t, "hash")}", Title = title, InfoHash = hash, Magnet = Magnet(hash, title, true), SizeBytes = Size(S(t, "size")),
                SizeLabel = S(t, "size"), Seeders = I(t, "seeds"), Leechers = I(t, "peers"), Category = "movies", Source = Id,
                SourceUrl = S(movie, "url") is { Length: > 0 } url ? url : $"https://yts.mx/movies/{S(movie, "slug")}", PublishedAt = Date(S(t, "date_uploaded")), Tags = ReleaseQuality.ExtractTags(title),
                Metadata = S(movie, "medium_cover_image").Length == 0 ? null : new() { Source = "tmdb", MediaType = "movie",
                    ExternalId = S(movie, "imdb_code") is { Length: > 0 } imdb ? imdb : S(movie, "id"), Title = S(movie, "title"), PosterUrl = S(movie, "medium_cover_image"),
                    Synopsis = S(movie, "summary") is { Length: > 0 } summary ? summary : S(movie, "description_full"), Year = I(movie, "year"),
                    Rating = double.TryParse(S(movie, "rating"), CultureInfo.InvariantCulture, out var rating) ? rating : null, Genres = Rows(movie, "genres").Select(x => x.ToString()).ToArray() } });
        }
        return results.OrderByDescending(r => r.Seeders).Take(o.Limit ?? 40).ToArray();
    }
}

public sealed class EztvAdapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "eztv";
    private readonly object gate = new();
    private readonly Dictionary<string, (string? Id, DateTimeOffset Expires)> ids = new(StringComparer.OrdinalIgnoreCase);
    public static string ShowTitle(string query)
    {
        var t = Replace(query, @"[._]+");
        t = Replace(t, @"\bS\s?\d{1,3}\s*E\s?\d{1,4}\b.*$|\bSeason\s*\d{1,3}\b.*$|\bS\s?\d{1,3}\b.*$|\b(1080p|720p|2160p|480p|complete|batch)\b.*$", "");
        return Replace(t, @"\s{2,}").Trim();
    }
    private async Task<string?> Imdb(string title, CancellationToken token)
    {
        var key = Setting("TMDB_API_KEY");
        if (string.IsNullOrWhiteSpace(key) || title.Length == 0) return null;
        lock (gate) if (ids.TryGetValue(title, out var cached) && cached.Expires > DateTimeOffset.UtcNow) return cached.Id;
        var root = Setting("TMDB_BASE_URL") ?? "https://api.themoviedb.org/3";
        string? imdb = null;
        try
        {
            using var search = JsonDocument.Parse(await Http.GetAsync($"{root}/search/tv?api_key={Uri.EscapeDataString(key)}&query={Uri.EscapeDataString(title)}", timeoutMs: 8000, cancellationToken: token));
            string Normalize(string s) => Replace(s.ToLowerInvariant().Replace("&", "and"), @"[^a-z0-9]+", "");
            var wanted = Normalize(title);
            var show = Rows(search.RootElement, "results").FirstOrDefault(r => Normalize(S(r, "name")) == wanted || Normalize(S(r, "original_name")) == wanted);
            if (show.ValueKind != JsonValueKind.Undefined)
            {
                using var result = JsonDocument.Parse(await Http.GetAsync($"{root}/tv/{S(show, "id")}/external_ids?api_key={Uri.EscapeDataString(key)}", timeoutMs: 8000, cancellationToken: token));
                imdb = Replace(S(result.RootElement, "imdb_id").Trim(), "^tt", "");
                if (imdb.Length == 0) imdb = null;
            }
        }
        catch (HttpRequestException) { return null; }
        lock (gate)
        {
            if (ids.Count >= 500) ids.Remove(ids.Keys.First());
            ids[title] = (imdb, DateTimeOffset.UtcNow.AddDays(1));
        }
        return imdb;
    }
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (o.Category is not ("all" or "tv")) return [];
        var imdb = await Imdb(ShowTitle(o.Query), cancellationToken);
        if (imdb == null) return [];
        var hosts = IndexerHttp.MirrorList(Setting("EZTV_BASE_URL"), "https://eztv.wf/api", "https://eztvx.to/api", "https://eztv.re/api");
        using var doc = JsonDocument.Parse(await Http.MirrorsAsync(Id, hosts, h => $"{h}/get-torrents?imdb_id={imdb}&limit=100&page=1", IndexerHttp.BrowserAgent, cancellationToken));
        var wanted = Parse(Replace(o.Query, @"[._]+"));
        return Rows(doc.RootElement, "torrents").Where(r => wanted.Season == null || I(r, "season") == 0 && wanted.Episode == null
            || I(r, "season") == wanted.Season && (wanted.Episode == null || I(r, "episode") == wanted.Episode)).Take(o.Limit ?? 40)
            .Select(r =>
            {
                var title = (S(r, "title") is { Length: > 0 } t ? t : S(r, "filename")).Trim();
                var hash = S(r, "hash").ToLowerInvariant();
                return new TorrentResult { Id = $"eztv-{(S(r, "id") is { Length: > 0 } id ? id : hash)}", Title = title, InfoHash = hash, Magnet = S(r, "magnet_url") is { Length: > 0 } magnet ? magnet : null,
                    SizeBytes = Math.Max(0, L(r, "size_bytes")), Seeders = I(r, "seeds"), Leechers = I(r, "peers"), Category = "tv", Source = Id,
                    SourceUrl = S(r, "episode_url") is { Length: > 0 } url ? url : "https://eztv.wf", PublishedAt = Unix(L(r, "date_released_unix")), Tags = ReleaseQuality.ExtractTags(title) };
            }).Where(r => r.Title.Length > 0 && r.InfoHash?.Length > 0).ToArray();
    }
}

public sealed class X1337Adapter(IndexerHttp http, IConfiguration configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "1337x";
    private const string Agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private const string Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query)) return [];
        var root = (Setting("X1337_BASE_URL") ?? "https://1337x.to").TrimEnd('/');
        var cat = o.Category switch { "anime" => "Anime", "movies" => "Movies", "tv" => "TV", "music" => "Music", "apps" => "Apps", "games" => "Games", "books" => "Other", _ => null };
        var q = Uri.EscapeDataString(o.Query.Trim());
        var html = await Http.GetAsync(cat == null ? $"{root}/search/{q}/1/" : $"{root}/category-search/{q}/{cat}/1/", Agent, 14000, Accept, cancellationToken);
        if (html.Contains("Just a moment") || html.Contains("cf-browser-verification") || html.Contains("Performing security verification")) throw new HttpRequestException("1337x blocked by Cloudflare");
        var doc = await new HtmlParser().ParseDocumentAsync(html, cancellationToken);
        using var pool = new SemaphoreSlim(4);
        var tasks = doc.QuerySelectorAll("table.table-list tbody tr").Take(Math.Min(o.Limit ?? 30, 40)).Select(async (row, index) =>
        {
            var link = row.QuerySelectorAll("td.coll-1.name a").LastOrDefault();
            if (link == null || string.IsNullOrWhiteSpace(link.TextContent)) return null;
            var path = link.GetAttribute("href") ?? "";
            var detailUrl = new Uri(new Uri(root), path).AbsoluteUri;
            var sizeCell = row.QuerySelector("td.coll-4");
            if (sizeCell != null) foreach (var span in sizeCell.QuerySelectorAll("span").ToArray()) span.Remove();
            var size = sizeCell?.TextContent.Trim();
            int Num(string selector) => int.TryParse(row.QuerySelector(selector)?.TextContent.Trim(), out var n) ? n : 0;
            string? magnet = null, torrent = null, hash = null;
            await pool.WaitAsync(cancellationToken);
            try
            {
                var detail = await Http.GetAsync(detailUrl, Agent, 10000, Accept, cancellationToken);
                var parsed = await new HtmlParser().ParseDocumentAsync(detail, cancellationToken);
                magnet = parsed.QuerySelector("a[href^='magnet:']")?.GetAttribute("href");
                hash = magnet == null ? null : Match(magnet, "btih:([a-zA-Z0-9]+)").Groups[1].Value.ToLowerInvariant();
                torrent = parsed.QuerySelector("a[href$='.torrent']")?.GetAttribute("href");
            }
            catch (Exception e) when (!cancellationToken.IsCancellationRequested && e is HttpRequestException or OperationCanceledException) { }
            finally { pool.Release(); }
            var title = link.TextContent.Trim();
            return new TorrentResult { Id = $"1337x-{Match(path, @"/torrent/(\d+)").Groups[1].Value}", Title = title, Source = Id, SourceUrl = detailUrl,
                InfoHash = hash, Magnet = magnet, TorrentUrl = torrent, SizeBytes = Size(size), SizeLabel = size, Seeders = Num("td.coll-2.seeds"), Leechers = Num("td.coll-3.leeches"), Tags = ReleaseQuality.ExtractTags(title) };
        });
        return (await Task.WhenAll(tasks)).OfType<TorrentResult>().ToArray();
    }
}
