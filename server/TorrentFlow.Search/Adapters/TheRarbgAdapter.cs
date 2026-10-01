using System.Text.Json;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Core.ReleaseEpisodeParser;

namespace TorrentFlow.Search.Adapters;

/// <summary>
/// TheRARBG JSON search (<c>/get-posts/keywords:…:format:json/</c>): every row carries the name, byte size, swarm counts
/// and the info hash, so no detail page is fetched. torrentgalaxy.one and torrentgalaxy.info serve the same index.
/// </summary>
public sealed class TheRarbgAdapter(IndexerHttp http, IOptions<SearchModuleOptions> configuration) : TorrentAdapter(http, configuration)
{
    public override string Id => "therarbg";
    public override async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions o, CancellationToken cancellationToken = default)
    {
        // The keywords sit inside the path, where ':' separates filters and '/' ends them.
        var keywords = Replace(Replace(o.Query ?? "", @"[:/\\?#%]+"), @"\s+").Trim();
        if (keywords.Length == 0) return [];
        // Anime is filed under both TV and Anime, so only movie and TV searches narrow the category.
        var category = o.Category switch { "movies" => ":category:Movies", "tv" => ":category:TV", _ => "" };
        var hosts = IndexerHttp.MirrorList(BaseUrl("https://therarbg.com"), "https://therarbg.to", "https://torrentgalaxy.one", "https://torrentgalaxy.info");
        // MirrorsAsync builds the URL of each host it tries and returns on the first good answer, so the last host seen answered.
        var root = hosts.FirstOrDefault() ?? "https://therarbg.com";
        using var doc = JsonDocument.Parse(await Http.MirrorsAsync(Id, hosts, h => $"{root = h}/get-posts/keywords:{EncodeUriComponent(keywords)}{category}:format:json/",
            IndexerHttp.BrowserAgent, cancellationToken));
        var wanted = Parse(o.Query ?? "");
        return Rows(doc.RootElement, "results").Where(r => !S(r, "c").Equals("XXX", StringComparison.OrdinalIgnoreCase) && Fits(S(r, "n"), wanted)).Take(o.Limit ?? 50).Select(r =>
        {
            var title = S(r, "n").Trim();
            var hash = HashFrom(S(r, "h"));
            var slug = Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
            return new TorrentResult { Id = $"therarbg-{S(r, "pk")}", Title = title, InfoHash = hash, Magnet = Magnet(hash ?? "", title, true),
                SizeBytes = L(r, "s") is > 0 and var size ? size : null, Seeders = I(r, "se"), Leechers = I(r, "le"), Category = CategoryHint(S(r, "c")),
                Source = Id, SourceUrl = $"{root}/post-detail/{S(r, "pk")}/{(slug.Length > 0 ? slug[..Math.Min(slug.Length, 80)] : "torrent")}/",
                PublishedAt = Unix(L(r, "a")), Tags = ReleaseQuality.ExtractTags(title) };
        }).Where(r => r.Title.Length > 0 && r.InfoHash is not null).ToArray();
    }
    // The site matches on the show name and ignores SxxEyy, so "Seinfeld S04E11" returns every season. Rows that name
    // another season or episode are dropped; the ranker scores the name only and would otherwise put them on top.
    private static bool Fits(string title, EpisodeInfo wanted)
    {
        if (wanted.Season is not { } season) return true;
        var got = Parse(title);
        if (got.Season is { } s && s != season && got.IsMultiSeason != true) return false;
        return wanted.Episode is not { } episode || got.Episode is null || got.Episode == episode;
    }
}
