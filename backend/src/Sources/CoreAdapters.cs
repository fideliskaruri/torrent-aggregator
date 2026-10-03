using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

internal static class CoreAdapters
{
    internal sealed record SourceRequest(Uri Uri, string? Body, bool Paginates);
    internal sealed record Page(IReadOnlyList<RawRelease> Rows, bool HasMore, string? Cursor = null);

    internal static SourceRequest Request(string id, string root, SourceQuery query, int page, int limit, string? cursor)
    {
        root = root.TrimEnd('/');
        var q = Uri.EscapeDataString(query.Query.Trim());
        return id switch
        {
            "apibay" => new(new($"{root}/q.php?q={q}&cat=0"), null, false),
            "nyaa" => new(new($"{root}/?page=rss&q={q}&c=1_0&f=0"), null, false),
            "eztv" => new(new($"{root}/get-torrents?imdb_id={query.Identity!.ExternalId[2..]}&limit=100&page={page}"), null, true),
            "yts" => new(new($"{root}/list_movies.json?query_term={q}&limit=50&page={page}&sort_by=seeds"), null, true),
            "torrentscsv" => new(new($"{root}?q={q}&size={limit}{(cursor is null ? "" : "&after=" + Uri.EscapeDataString(cursor))}"), null, true),
            "knaben" => new(new(root), KnabenBody(query, limit), false),
            "animetosho" => new(new($"{root}/json?q={q}&page={page}"), null, true),
            _ => throw new SourceException("Unconfigured", "This adapter is not installed.")
        };
    }

    private static string KnabenBody(SourceQuery q, int limit)
    {
        var body = new Dictionary<string, object>
        {
            ["search_type"] = "100%", ["search_field"] = "title", ["query"] = q.Query.Trim(),
            ["order_by"] = "seeders", ["order_direction"] = "desc", ["size"] = limit,
            ["hide_unsafe"] = true, ["hide_xxx"] = true
        };
        if (q.Category != "all")
            body["categories"] = q.Category switch
            {
                "tv" or "series" => new[] { 2000000 }, "movies" or "films" => [3000000], "anime" => [6000000], _ => []
            };
        return JsonSerializer.Serialize(body);
    }

    internal static Page Parse(string id, string content)
    {
        if (id == "nyaa") return Nyaa(content);
        using var doc = JsonDocument.Parse(content);
        var root = doc.RootElement;
        IEnumerable<JsonElement> rows = id switch
        {
            "apibay" or "animetosho" => Array(root),
            "torrentscsv" or "eztv" => Array(Property(root, "torrents")),
            "knaben" => Array(Property(root, "hits")),
            "yts" => YtsRows(root),
            _ => throw new SourceException("SourceFailure", "Unknown source response.")
        };
        var result = new List<RawRelease>();
        var rawCount = 0;
        foreach (var row in rows)
        {
            rawCount++;
            if (id == "apibay" && Text(row, "id") == "0" && Text(row, "name") == "No results returned") continue;
            var release = id switch
            {
                "apibay" => Raw(id, Text(row, "name"), Text(row, "info_hash"), Long(row, "size"),
                    Int(row, "seeders"), Int(row, "leechers"), Text(row, "id"), null, null, Unix(row, "added")),
                "torrentscsv" => Raw(id, Text(row, "name"), Text(row, "infohash"), Long(row, "size_bytes"),
                    Int(row, "seeders"), Int(row, "leechers"), Text(row, "id"), null, null, Unix(row, "created_unix")),
                "knaben" => Raw(id, Text(row, "title"), Text(row, "hash"), Long(row, "bytes"),
                    Int(row, "seeders"), Int(row, "peers"), Text(row, "id"), Text(row, "magnetUrl"),
                    Text(row, "link"), Date(Text(row, "date"))),
                "animetosho" => Raw(id, Text(row, "title"), Text(row, "info_hash"), Long(row, "total_size"),
                    Int(row, "seeders"), Int(row, "leechers"), Text(row, "id"), Text(row, "magnet_uri"),
                    Text(row, "torrent_url"), Unix(row, "timestamp")),
                "eztv" => Raw(id, Nonempty(Text(row, "title")) ?? Text(row, "filename"), Text(row, "hash"),
                    Long(row, "size_bytes"), Int(row, "seeds"), Int(row, "peers"), Text(row, "id"),
                    Text(row, "magnet_url"), Text(row, "torrent_url"), Unix(row, "date_released_unix")),
                _ => null
            };
            if (release is not null) result.Add(release);
        }
        if (id == "yts")
        {
            foreach (var movie in YtsRows(root))
            foreach (var torrent in Array(Property(movie, "torrents")))
            {
                var name = Nonempty(Text(movie, "title_long")) ?? Text(movie, "title");
                var release = Raw(id, $"{name} [{Text(torrent, "quality")}] [{Text(torrent, "type")}] [YTS]",
                    Text(torrent, "hash"), Long(torrent, "size_bytes") ?? Size(Text(torrent, "size")),
                    Int(torrent, "seeds"), Int(torrent, "peers"), Text(movie, "id"), null,
                    Text(torrent, "url"), Unix(torrent, "date_uploaded_unix") ?? Date(Text(torrent, "date_uploaded")));
                if (release is not null) result.Add(release);
            }
        }
        var more = id switch
        {
            "eztv" => rawCount == 100,
            "yts" => rawCount == 50,
            "torrentscsv" => rawCount >= 25 && Long(root, "next") is > 0,
            "animetosho" => rawCount >= 75,
            // Knaben may return fewer hits than the requested window even with a larger total.
            "knaben" => root.TryGetProperty("total", out var total) &&
                (total.ValueKind == JsonValueKind.Object ? Long(total, "value") : Long(root, "total")) > rawCount,
            _ => false
        };
        return new(result, more, id == "torrentscsv" ? Long(root, "next")?.ToString(CultureInfo.InvariantCulture) : null);
    }

    private static IEnumerable<JsonElement> YtsRows(JsonElement root)
    {
        if (Text(root, "status") != "ok") throw new SourceException("SourceFailure", "YTS returned an unsuccessful response.");
        var data = Property(root, "data");
        if (!data.TryGetProperty("movies", out var movies))
        {
            if (Long(data, "movie_count") == 0) return [];
            throw new SourceException("SourceFailure", "YTS response is missing its movie list.");
        }
        return Array(movies);
    }

    private static Page Nyaa(string xml)
    {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024
        });
        var document = XDocument.Load(reader);
        if (document.Root?.Name.LocalName != "rss" || !document.Descendants("channel").Any())
            throw new SourceException("SourceFailure", "The source did not return RSS.");
        var results = new List<RawRelease>();
        var items = document.Descendants().Where(e => e.Name.LocalName == "item").ToArray();
        foreach (var item in items)
        {
            string Value(string key) => item.Elements().FirstOrDefault(e => e.Name.LocalName == key)?.Value.Trim() ?? "";
            int? Count(string key) => int.TryParse(Value(key), CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : null;
            var release = Raw("nyaa", Value("title"), Value("infoHash"), Size(Value("size")), Count("seeders"),
                Count("leechers"), Value("guid"), null, Value("link"), Date(Value("pubDate")));
            if (release is not null) results.Add(release);
        }
        return new(results, items.Length >= 75);
    }

    private static RawRelease? Raw(string source, string name, string hash, long? bytes, int? seeds,
        int? leeches, string? itemId, string? magnet, string? torrent, DateTimeOffset? published)
    {
        hash = hash.Trim().ToLowerInvariant();
        if (hash.Length != 40 || hash.Any(c => !char.IsAsciiHexDigit(c)))
            hash = MagnetHash(magnet) ?? "";
        if (string.IsNullOrWhiteSpace(name) || hash.Length != 40) return null;
        magnet = Nonempty(magnet);
        if (magnet is null || !magnet.StartsWith("magnet:?", StringComparison.OrdinalIgnoreCase))
            magnet = $"magnet:?xt=urn:btih:{hash}&dn={Uri.EscapeDataString(name)}";
        return new(name, hash, bytes is >= 0 ? bytes : null, seeds, leeches, source,
            Nonempty(itemId), magnet, Nonempty(torrent), published, ImmutableArray<string>.Empty);
    }

    private static string? MagnetHash(string? magnet)
    {
        if (magnet is null) return null;
        foreach (var part in magnet.Split('&', '?'))
        {
            var value = Uri.UnescapeDataString(part);
            if (!value.StartsWith("xt=urn:btih:", StringComparison.OrdinalIgnoreCase)) continue;
            var hash = value[12..].ToLowerInvariant();
            if (hash.Length == 40 && hash.All(char.IsAsciiHexDigit)) return hash;
        }
        return null;
    }

    private static IEnumerable<JsonElement> Array(JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() :
            throw new SourceException("SourceFailure", "The source returned an invalid list.");
    private static JsonElement Property(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) ? value :
            throw new SourceException("SourceFailure", $"The source response is missing {key}.");
    private static string Text(JsonElement row, string key) =>
        row.ValueKind == JsonValueKind.Object && row.TryGetProperty(key, out var value) &&
        value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? value.ToString() : "";
    private static long? Long(JsonElement row, string key) =>
        long.TryParse(Text(row, key), CultureInfo.InvariantCulture, out var n) ? n : null;
    private static int? Int(JsonElement row, string key) =>
        Long(row, key) is >= 0 and <= int.MaxValue and var n ? (int)n : null;
    private static string? Nonempty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
    private static DateTimeOffset? Unix(JsonElement row, string key) =>
        Long(row, key) is > 0 and < 253402300800 and var n ? DateTimeOffset.FromUnixTimeSeconds(n) : null;
    private static DateTimeOffset? Date(string value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date)
            ? date.ToUniversalTime() : null;
    private static long? Size(string value)
    {
        var parts = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2 || !decimal.TryParse(parts[0].Replace(",", ""), CultureInfo.InvariantCulture, out var n) || n < 0) return null;
        var unit = parts[1].ToLowerInvariant();
        var exponent = unit switch { "b" => 0, "kb" or "kib" => 1, "mb" or "mib" => 2, "gb" or "gib" => 3, "tb" or "tib" => 4, _ => -1 };
        if (exponent < 0) return null;
        var bytes = n * (decimal)Math.Pow(unit.Contains('i') ? 1024 : 1000, exponent);
        return bytes <= long.MaxValue ? (long)bytes : null;
    }
}
