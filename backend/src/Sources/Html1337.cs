using System.Runtime.CompilerServices;
using AngleSharp.Html.Parser;
using TorrentFlow.Domain;
using static TorrentFlow.Sources.CoreAdapters;

namespace TorrentFlow.Sources;

internal static class Html1337
{
    internal static async IAsyncEnumerable<Page> SearchAsync(SourceSettings settings, SourceQuery query, int limit,
        SourceTransport transport, CallTrace trace, [EnumeratorCancellation] CancellationToken ct)
    {
        var root = new Uri(settings.BaseUrl!.TrimEnd('/') + "/");
        var category = query.Category switch
        {
            "tv" or "series" => "TV", "movies" or "films" => "Movies", "anime" => "Anime", _ => null
        };
        var q = Uri.EscapeDataString(query.Query.Trim());
        var path = category is null ? $"search/{q}/1/" : $"category-search/{q}/{category}/1/";
        var html = await transport.ReadAsync(new(root, path), null, settings, query, trace, ct);
        AdditionalAdapters.Challenge(html);
        var document = await new HtmlParser().ParseDocumentAsync(html, ct);
        var rows = document.QuerySelectorAll("table.table-list tbody tr").Take(limit).ToArray();
        if (rows.Length == 0 && document.QuerySelector("table.table-list") is null &&
            !html.Contains("No results", StringComparison.OrdinalIgnoreCase))
            throw new SourceException("SourceFailure", "1337x returned an unrecognized search page.");
        if (rows.Length == 0) { yield return new([], false); yield break; }
        for (var i = 0; i < rows.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var row = rows[i];
            var link = row.QuerySelectorAll("td.coll-1.name a").LastOrDefault();
            if (link is null) throw new SourceException("SourceFailure", "1337x returned a malformed result row.");
            var detailUri = new Uri(root, link.GetAttribute("href") ?? "");
            if (detailUri.IdnHost != root.IdnHost || detailUri.Port != root.Port || detailUri.Scheme != root.Scheme)
                throw new SourceException("SourceFailure", "1337x detail link leaves the configured site.");
            // Details use the same host gate and logical call token; no separate fanout timeout or swallowed failure.
            var detail = await transport.ReadAsync(detailUri, null, settings, query, trace, ct);
            AdditionalAdapters.Challenge(detail);
            var parsed = await new HtmlParser().ParseDocumentAsync(detail, ct);
            var magnet = parsed.QuerySelector("a[href^='magnet:']")?.GetAttribute("href");
            var hash = MagnetHash(magnet) ??
                AdditionalAdapters.Hash(parsed.QuerySelectorAll(".infohash-box span").LastOrDefault()?.TextContent);
            var sizeCell = row.QuerySelector("td.coll-4");
            if (sizeCell is not null)
                foreach (var span in sizeCell.QuerySelectorAll("span").ToArray()) span.Remove();
            var torrent = parsed.QuerySelector("a[href*='.torrent']")?.GetAttribute("href");
            if (!string.IsNullOrEmpty(torrent)) torrent = new Uri(detailUri, torrent).AbsoluteUri;
            var release = Raw("1337x", link.TextContent.Trim(), hash, Size(sizeCell?.TextContent.Trim() ?? ""),
                FeedXml.Count(row.QuerySelector("td.coll-2.seeds")?.TextContent.Trim() ?? ""),
                FeedXml.Count(row.QuerySelector("td.coll-3.leeches")?.TextContent.Trim() ?? ""),
                detailUri.AbsolutePath, magnet, torrent, Date(row.QuerySelector("td.coll-date")?.TextContent.Trim() ?? ""));
            if (release is null) throw new SourceException("SourceFailure", "1337x detail has no valid torrent identity.");
            yield return new([release], i + 1 < rows.Length || rows.Length >= 40);
        }
    }
}
