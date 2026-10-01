using System.Text.Json;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Core.ReleaseEpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// SubsPlease search API: keyless, only SubsPlease's own simulcast releases, one magnet per resolution and no swarm
/// counts (the tracker scrape fills them). It answers JSON labelled text/html, and <c>[]</c> when nothing matches.
/// </summary>
public sealed class SubsPleaseAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "subsplease";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query) || o.Category is not ("all" or "anime")) return [];
        var root = BaseUrl("https://subsplease.org");
        var body = await Http.GetAsync($"{root}/api/?f=search&tz=UTC&s={EncodeUriComponent(o.Query.Trim())}", IndexerHttp.BrowserAgent,
            accept: "application/json, text/plain, */*", cancellationToken: cancellationToken);
        if (string.IsNullOrWhiteSpace(body)) return [];
        using var doc = JsonDocument.Parse(body);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return [];
        List<TorrentResult> results = [];
        foreach (var release in doc.RootElement.EnumerateObject().Select(p => p.Value).Where(r => r.ValueKind == JsonValueKind.Object))
        foreach (var download in Rows(release, "downloads"))
        {
            var magnet = S(download, "magnet");
            if (MagnetHash(magnet) is not { } hash) continue;
            var title = Param(magnet, "dn") is { Length: > 0 } name ? name : $"[SubsPlease] {S(release, "show")} - {S(release, "episode")} ({S(download, "res")}p)";
            results.Add(new TorrentResult { Id = $"subsplease-{hash}", Title = title, InfoHash = hash,
                Magnet = Replace(magnet, "urn:btih:[0-9a-z]+", "urn:btih:" + hash), SizeBytes = long.TryParse(Param(magnet, "xl"), out var size) && size > 0 ? size : null,
                Category = "anime", Source = Id, SourceUrl = S(release, "page") is { Length: > 0 } page ? $"{root}/shows/{page}/" : root,
                PublishedAt = Date(S(release, "release_date")), Tags = ReleaseQuality.ExtractTags(title) });
        }
        return results.Take(o.Limit ?? 50).ToArray();
    }

    private static string Param(string magnet, string key) =>
        Match(magnet, $@"[?&]{key}=([^&]*)") is { Success: true } m ? Uri.UnescapeDataString(m.Groups[1].Value.Replace('+', ' ')).Trim() : "";

    /// <summary>Lower-case hex info hash from a magnet's <c>urn:btih:</c>, written as 40 hex or 32 base32 characters; null when neither.</summary>
    internal static string? MagnetHash(string? magnet)
    {
        var btih = Match(magnet ?? "", "urn:btih:([0-9a-z]+)").Groups[1].Value;
        if (btih.Length == 40) return HashFrom(btih);
        if (btih.Length != 32) return null;
        var bytes = new byte[20];
        int buffer = 0, bits = 0, index = 0;
        foreach (var c in btih.ToUpperInvariant())
        {
            var value = c is >= 'A' and <= 'Z' ? c - 'A' : c is >= '2' and <= '7' ? c - '2' + 26 : -1;
            if (value < 0) return null;
            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits < 8) continue;
            bits -= 8;
            bytes[index++] = (byte)(buffer >> bits);
            buffer &= (1 << bits) - 1;
        }
        return Convert.ToHexStringLower(bytes);
    }
}
