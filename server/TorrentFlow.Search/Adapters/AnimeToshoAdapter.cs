using System.Text.Json;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// AnimeTosho's JSON feed: a keyless anime index mirroring Nyaa, TokyoTosho, AniDex and more, with swarm counts. The live
/// site is Anime Tosho NEW (feed.animetosho.xyz, which redirects to feed.animetosho.net); the original feed.animetosho.org
/// stopped processing in May 2026. The base URL is the registry's animetosho entry, shared with the language hints.
/// </summary>
public sealed class AnimeToshoAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    /// <summary>The shipped base URL (sources.default.json); the owner changes it in Settings, Sources.</summary>
    public const string DefaultBaseUrl = "https://feed.animetosho.xyz";
    public override string Id => "animetosho";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(o.Query) || o.Category is not ("all" or "anime")) return [];
        using var doc = JsonDocument.Parse(await Http.GetAsync($"{BaseUrl(DefaultBaseUrl)}/json?q={EncodeUriComponent(o.Query.Trim())}",
            IndexerHttp.BrowserAgent, cancellationToken: cancellationToken));
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
        return doc.RootElement.EnumerateArray().Take(o.Limit ?? 50).Select(r =>
        {
            var title = S(r, "title").Trim();
            var hash = S(r, "info_hash").ToLowerInvariant();
            return new TorrentResult { Id = $"animetosho-{S(r, "id")}", Title = title, InfoHash = hash.Length == 40 ? hash : null,
                Magnet = S(r, "magnet_uri") is { Length: > 0 } magnet ? magnet : Magnet(hash, title, true), TorrentUrl = S(r, "torrent_url") is { Length: > 0 } url ? url : null,
                SizeBytes = L(r, "total_size") is > 0 and var size ? size : null, Seeders = I(r, "seeders"), Leechers = I(r, "leechers"),
                Completed = I(r, "torrent_downloaded_count"), Category = "anime", Source = Id, SourceUrl = S(r, "link"),
                PublishedAt = Unix(L(r, "timestamp")), Tags = ReleaseQuality.ExtractTags(title), SiteId = S(r, "id") is { Length: > 0 } id ? id : null };
        }).Where(r => r.Title.Length > 0 && (r.InfoHash is not null || r.TorrentUrl is not null)).ToArray();
    }
}
