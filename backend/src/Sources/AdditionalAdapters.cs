using System.Collections.Immutable;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using AngleSharp.Html.Parser;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Domain;
using static TorrentFlow.Sources.CoreAdapters;

namespace TorrentFlow.Sources;

internal static class AdditionalAdapters
{
    internal static async IAsyncEnumerable<Page> SearchAsync(string id, SourceSettings settings, SourceQuery query,
        int limit, SourceTransport transport, CallTrace trace, IConfiguration configuration,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var root = settings.BaseUrl!.TrimEnd('/');
        var q = Uri.EscapeDataString(query.Query.Trim());
        if (id == "1337x")
        {
            await foreach (var page in Html1337.SearchAsync(settings, query, limit, transport, trace, ct)) yield return page;
            yield break;
        }
        if (id == "torznab")
        {
            await foreach (var page in Torznab.SearchAsync(settings, query, limit, transport, trace, configuration, ct)) yield return page;
            yield break;
        }
        string Url() => id switch
        {
            "therarbg" => $"{root}/get-posts/keywords:{Uri.EscapeDataString(Regex.Replace(query.Query, @"[:/\\?#%]+", " ", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking))}:format:json/",
            "bitsearch" => $"{root}/search?q={q}&limit={limit}",
            "limetorrents" => $"{root}/searchrss/{Uri.EscapeDataString(Regex.Replace(query.Query.Trim(), @"\s+", "-", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking))}/",
            "torrentdownloads" => $"{root}/rss.xml?type=search&search={q}",
            "torrentdownloadinfo" => $"{root}/feed?q={q}",
            "subsplease" => $"{root}/api/?f=search&tz=UTC&s={q}",
            "archive" => ArchiveUrl(root, query.Query, limit),
            _ => throw new SourceException("Unconfigured", "This adapter is not installed.")
        };
        var content = await transport.ReadAsync(new(Url()), null, settings, query, trace, ct);
        Page parsed;
        if (id == "bitsearch") parsed = await BitSearch(content, ct);
        else if (id is "limetorrents" or "torrentdownloads" or "torrentdownloadinfo") parsed = Rss(id, content);
        else
        {
            using var document = JsonDocument.Parse(content);
            parsed = id switch
            {
                "therarbg" => Rarbg(document.RootElement),
                "subsplease" => SubsPlease(document.RootElement),
                "archive" => Archive(document.RootElement, root),
                _ => throw new SourceException("SourceFailure", "Unknown source response.")
            };
        }
        ct.ThrowIfCancellationRequested();
        yield return parsed;
    }

    private static Page Rarbg(JsonElement root)
    {
        var rows = Array(Property(root, "results")).ToArray();
        return new(rows.Select(r => Raw("therarbg", Text(r, "n"), Hash(Text(r, "h")), Long(r, "s"),
            Int(r, "se"), Int(r, "le"), Text(r, "pk"), null, null, Unix(r, "a")))
            .OfType<RawRelease>().ToArray(), rows.Length >= 50);
    }

    private static Page Rss(string id, string content)
    {
        var items = FeedXml.Items(FeedXml.Load(content));
        var results = new List<RawRelease>();
        foreach (var item in items)
        {
            string V(string key) => FeedXml.Value(item, key);
            var description = V("description");
            var torrent = item.Elements().FirstOrDefault(e => e.Name.LocalName == "enclosure")?.Attribute("url")?.Value;
            var hash = id switch
            {
                "limetorrents" => Hash(torrent),
                "torrentdownloads" => Hash(V("info_hash")),
                _ => Hash(Match(description, @"Hash:\s*([0-9a-f]{40})")) is { Length: > 0 } h ? h : Hash(V("link"))
            };
            var seeds = id switch
            {
                "torrentdownloads" => FeedXml.Count(V("seeders")),
                _ => FeedXml.Count(Match(description, @"Seeds:\s*([\d,]+)"))
            };
            var leeches = id switch
            {
                "torrentdownloads" => FeedXml.Count(V("leechers")),
                "limetorrents" => FeedXml.Count(Match(description, @"Leechers:?\s*([\d,]+)")),
                _ => FeedXml.Count(Match(description, @"Peers:\s*([\d,]+)"))
            };
            var bytes = id == "torrentdownloadinfo" ? Size(Match(description, @"Size:\s*([\d.,]+\s*[kmgt]?i?b)\b")) : FeedXml.Bytes(V("size"));
            var result = Raw(id, V("title"), hash, bytes, seeds, leeches, V("guid"), null, torrent, Date(V("pubDate")));
            if (result is not null) results.Add(result);
        }
        return new(results, items.Length >= (id == "limetorrents" ? 40 : 50));
    }

    private static async Task<Page> BitSearch(string html, CancellationToken ct)
    {
        Challenge(html);
        var document = await new HtmlParser().ParseDocumentAsync(html, ct);
        var cards = document.QuerySelectorAll("div.bg-white")
            .Where(c => c.QuerySelector("a[href^='magnet:']") is not null && c.QuerySelector("h3 a") is not null).ToArray();
        var results = new List<RawRelease>();
        foreach (var card in cards)
        {
            var title = card.QuerySelector("h3 a")!.TextContent.Trim();
            var magnet = card.QuerySelector("a[href^='magnet:']")!.GetAttribute("href");
            var facts = card.QuerySelectorAll("div.text-sm.text-gray-600 > span > span").Select(s => s.TextContent.Trim()).ToArray();
            int? Count(string color) => FeedXml.Count(card.QuerySelector($"span.{color} span.font-medium")?.TextContent.Trim() ?? "");
            var result = Raw("bitsearch", title, MagnetHash(magnet) ?? "", facts.Length > 1 ? Size(facts[1]) : null,
                Count("text-green-600"), Count("text-red-600"), null, magnet, null, facts.Length > 2 ? Date(facts[2]) : null);
            if (result is not null) results.Add(result);
        }
        if (cards.Length == 0 && document.QuerySelector("input[name='q']") is null &&
            !html.Contains("No results", StringComparison.OrdinalIgnoreCase))
            throw new SourceException("SourceFailure", "BitSearch returned an unrecognized search page.");
        return new(results, cards.Length >= 20);
    }

    private static Page SubsPlease(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Array && root.GetArrayLength() == 0) return new([], false);
        if (root.ValueKind != JsonValueKind.Object) throw new SourceException("SourceFailure", "SubsPlease returned an invalid search response.");
        var results = new List<RawRelease>();
        foreach (var release in root.EnumerateObject().Select(p => p.Value))
        foreach (var download in Array(Property(release, "downloads")))
        {
            var magnet = Text(download, "magnet");
            var title = Parameter(magnet, "dn");
            if (title.Length == 0) title = $"[SubsPlease] {Text(release, "show")} - {Text(release, "episode")} ({Text(download, "res")}p)";
            var result = Raw("subsplease", title, MagnetHash(magnet) ?? "", FeedXml.Bytes(Parameter(magnet, "xl")),
                null, null, null, magnet, null, Date(Text(release, "release_date")));
            if (result is not null) results.Add(result);
        }
        return new(results, false);
    }

    private static string ArchiveUrl(string root, string query, int limit)
    {
        var words = Regex.Replace(query, @"[+\-&|!(){}\[\]^""~*?:\\/]", " ", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking).Trim();
        var search = $"title:({words}) AND mediatype:movies AND licenseurl:*publicdomain*";
        return $"{root}/advancedsearch.php?q={Uri.EscapeDataString(search)}&fl[]=identifier&fl[]=title&fl[]=btih&fl[]=item_size&fl[]=publicdate&fl[]=licenseurl&rows={limit}&page=1&output=json";
    }

    private static Page Archive(JsonElement root, string endpoint)
    {
        var response = Property(root, "response");
        var rows = Array(Property(response, "docs")).ToArray();
        var results = new List<RawRelease>();
        foreach (var row in rows)
        {
            string First(string key)
            {
                if (!row.TryGetProperty(key, out var value)) return "";
                return value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Select(e => e.ToString()).FirstOrDefault() ?? "" : value.ToString();
            }
            var license = First("licenseurl");
            if (!Uri.TryCreate(license, UriKind.Absolute, out var licenseUri) ||
                licenseUri.IdnHost != "creativecommons.org" ||
                !(licenseUri.AbsolutePath.StartsWith("/publicdomain/", StringComparison.OrdinalIgnoreCase) ||
                  licenseUri.AbsolutePath.StartsWith("/licenses/publicdomain/", StringComparison.OrdinalIgnoreCase))) continue;
            var id = First("identifier");
            if (id.Length == 0) continue;
            var encoded = Uri.EscapeDataString(id);
            var webseed = $"{endpoint}/download/";
            var result = Raw("archive", First("title"), First("btih"), Long(row, "item_size"),
                null, null, id, null, $"{endpoint}/download/{encoded}/{encoded}_archive.torrent", Date(First("publicdate")));
            if (result is not null) results.Add(result with
            {
                WebSeeds = ImmutableArray.Create(webseed),
                Magnet = result.Magnet + "&ws=" + Uri.EscapeDataString(webseed)
            });
        }
        return new(results, Long(response, "numFound") > rows.Length);
    }

    internal static void Challenge(string html)
    {
        if (html.Contains("Just a moment", StringComparison.OrdinalIgnoreCase) ||
            html.Contains("cf-browser-verification", StringComparison.OrdinalIgnoreCase) ||
            html.Contains("Performing security verification", StringComparison.OrdinalIgnoreCase))
            throw new SourceException("SourceFailure", "The site returned a browser verification page.");
    }

    internal static string Hash(string? value) =>
        Regex.Match(value ?? "", @"(?<![0-9a-f])([0-9a-f]{40})(?![0-9a-f])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)).Groups[1].Value.ToLowerInvariant();
    internal static string Match(string value, string expression) =>
        Regex.Match(value, expression, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking).Groups[1].Value;
    internal static string Parameter(string uri, string name)
    {
        foreach (var part in uri.Split('&', '?'))
            if (part.StartsWith(name + "=", StringComparison.Ordinal))
                return Uri.UnescapeDataString(part[(name.Length + 1)..].Replace('+', ' ')).Trim();
        return "";
    }
}
