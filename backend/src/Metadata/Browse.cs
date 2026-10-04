using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Metadata;

internal sealed partial class Browse(IDbContextFactory<TorrentFlowDbContext> dbs, TmdbClient tmdb,
    AniListClient anilist, CinemetaClient cinemeta)
{
    private static readonly JsonSerializerOptions ListingJson = new(JsonSerializerOptions.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
    private sealed record RailSpec(string Id, string Title, string Type, string TmdbPath, string? Query,
        string CineCatalog, string AnimeSort, bool Seasonal = false);
    private sealed record RailCandidates(List<WorkSnapshot> Works, bool Failed, string? Provider);
    private sealed record ListingName(string Value, string NormalizedValue, NameLabel Label, int? Link);
    private sealed record ListingEntry(WorkRow Work, ListingName[] Names, WorkLinkRow[] Links,
        ImmutableArray<SeasonRow> Seasons, ImmutableArray<EpisodeRow> Episodes,
        DateTimeOffset? PremiereAt, string? ProviderFormat);
    private static readonly RailSpec[] Featured =
    [
        new("films-popular", "Popular films", "films", "/trending/movie/week", null, "top", ""),
        new("series-popular", "Popular series", "series", "/trending/tv/week", null, "top", ""),
        new("anime-season", "Anime this season", "anime", "", null, "", "POPULARITY_DESC", true),
        new("films-new", "New films", "films", "/discover/movie", "region=US&with_release_type=4|5&sort_by=popularity.desc&vote_count.gte=20&include_adult=false", "year", ""),
        new("series-new", "New series", "series", "/discover/tv", "sort_by=popularity.desc&vote_count.gte=10&without_genres=10763|10767|10766&without_keywords=210024&include_adult=false", "year", ""),
        new("anime-trending", "Trending anime", "anime", "", null, "", "TRENDING_DESC"),
        new("films-top", "Top rated films", "films", "/discover/movie", "sort_by=vote_average.desc&vote_count.gte=5000&include_adult=false", "", ""),
        new("series-top", "Top rated series", "series", "/discover/tv", "sort_by=vote_average.desc&vote_count.gte=2000&without_genres=10763|10767|10766&without_keywords=210024&include_adult=false", "", ""),
        new("anime-top", "Top rated anime", "anime", "", null, "", "SCORE_DESC"),
    ];

    public async Task<BrowseResult> BrowseAsync(BrowseQuery query, CancellationToken cancellationToken)
    {
        var type = query.Type is "films" or "series" or "anime" ? query.Type : "all";
        var configured = await ProviderHttp.SettingsAsync(dbs, cancellationToken);
        var hasTmdb = configured.EnabledProviders.Contains("tmdb") && await tmdb.EnabledAsync(cancellationToken);
        var specs = Featured.Where(r => type == "all" || r.Type == type).ToArray();
        var genres = CatalogViews.Genres(type);
        if (type != "all")
            specs = [.. specs, .. genres.Select(g => new RailSpec(type + "-" + g.Id, CatalogViews.Heading(type, g),
                type, type == "films" ? "/discover/movie" : "/discover/tv",
                GenreQuery(type, g.Id), "top", "POPULARITY_DESC"))];
        if (query.Genre is { Length: > 0 } genre)
            specs = [new(type + "-" + genre, CatalogViews.Heading(type,
                genres.FirstOrDefault(g => g.Id == genre) ?? new(genre, GenreName(genre))), type,
                type == "films" ? "/discover/movie" : "/discover/tv",
                GenreQuery(type, genre), "top", "POPULARITY_DESC")];
        var animeSpecs = specs.Where(s => s.Type == "anime").ToArray();
        var anime = animeSpecs.Length == 0 ? null : new Lazy<Dictionary<string, Task<ProviderAnswer[]>>>(() =>
            anilist.BrowseBatchAsync(animeSpecs.Select(s => (s.Id, s.AnimeSort,
                (query.Genre ?? genres.FirstOrDefault(g => s.Id == type + "-" + g.Id)?.Id) is { } g
                    ? GenreName(g) : null, s.Seasonal)).ToArray(), cancellationToken, sizeForOverlap: true));
        var tasks = specs.Select(s => RailAsync(s, query.Genre ??
            genres.FirstOrDefault(g => s.Id == type + "-" + g.Id)?.Id, cancellationToken, anime, configured, hasTmdb)).ToArray();
        var rails = await ApplyCachedHomeReleasesAsync(await Task.WhenAll(tasks), cancellationToken);
        var poolSeen = new HashSet<string>();
        var holes = new List<int>();
        var expanded = new HashSet<int>();
        var limit = query.Genre is { Length: > 0 } ? 48 : 24;
        while (true)
        {
            poolSeen.Clear();
            holes.Clear();
            for (var i = 0; i < rails.Length; i++)
                if (rails[i].Rail is { } rail)
                {
                    var visible = Visible(rail, poolSeen, limit, DateTimeOffset.UtcNow);
                    foreach (var work in visible) poolSeen.UnionWith(RailKeys(work).Claim);
                    if (visible.Length < limit && !rails[i].Stale && !expanded.Contains(i)) holes.Add(i);
                }
            if (holes.Count == 0) break;
            expanded.UnionWith(holes);
            var moreAnime = new Lazy<Dictionary<string, Task<ProviderAnswer[]>>>(() =>
            {
                var needed = holes.Select(i => specs[i]).Where(s => s.Type == "anime").ToArray();
                var replenishment = LoadAsync();
                return needed.ToDictionary(s => s.Id, async s => (await replenishment)[s.Id]);

                async Task<Dictionary<string, ProviderAnswer[]>> LoadAsync()
                {
                    var initial = new Dictionary<string, ProviderAnswer[]>();
                    foreach (var spec in needed) initial.Add(spec.Id, await anime!.Value[spec.Id]);
                    var prefetched = needed.Where(s => initial[s.Id].Length > 1)
                        .ToDictionary(s => s.Id, s => initial[s.Id][1..]);
                    var missing = needed.Where(s => !prefetched.ContainsKey(s.Id)).ToArray();
                    if (missing.Length > 0)
                        foreach (var pair in anilist.BrowseBatchAsync(missing.Select(s => (s.Id, s.AnimeSort,
                            (query.Genre ?? genres.FirstOrDefault(g => s.Id == type + "-" + g.Id)?.Id) is { } g
                                ? GenreName(g) : null, s.Seasonal)).ToArray(), cancellationToken, firstPage: 2, pageCount: 1))
                            prefetched.Add(pair.Key, await pair.Value);
                    return prefetched;
                }
            });
            var replenished = await Task.WhenAll(holes.Select(i => RailAsync(specs[i], query.Genre ??
                genres.FirstOrDefault(g => specs[i].Id == type + "-" + g.Id)?.Id, cancellationToken,
                moreAnime, configured, hasTmdb, replenish: true)));
            for (var i = 0; i < holes.Count; i++) rails[holes[i]] = replenished[i];
            rails = await ApplyCachedHomeReleasesAsync(rails, cancellationToken);
        }
        var seen = new HashSet<string>();
        var result = new List<BrowseRail>();
        if (type == "all" && query.UserId is { } userId)
        {
            WatchItemRow? seed;
            await using (var db = await dbs.CreateDbContextAsync(cancellationToken))
                seed = (await db.WatchItems.AsNoTracking().Where(w => w.UserId == userId).OrderBy(w => w.Id)
                    .ToListAsync(cancellationToken)).OrderByDescending(w => w.UpdatedAt).FirstOrDefault();
            if (seed is not null && await Catalog.SnapshotAsync(dbs, seed.WorkId, cancellationToken) is { } work &&
                await HomeRecommendationsAsync(work, rails.Where(r => r.Rail is not null)
                    .Select(r => r.Rail!).ToArray(), cancellationToken) is { } personal)
            {
                result.Add(personal with { Id = "because-you-are-watching" });
                foreach (var item in personal.Works) seen.UnionWith(RailKeys(item).Claim);
            }
        }
        var cinemas = new List<WorkSnapshot>();
        var now = DateTimeOffset.UtcNow;
        foreach (var (rail, _) in rails)
        {
            if (rail is null) continue;
            cinemas.AddRange(rail.Works.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) && InCinemas(w, now)));
            var visible = Visible(rail, seen, limit, now);
            foreach (var work in visible) seen.UnionWith(RailKeys(work).Claim);
            if (!visible.IsEmpty) result.Add(rail with { Works = visible });
        }
        if (query.Genre is null && type is "all" or "films" && cinemas.Count > 0)
            result.Add(new("films-cinemas", "In cinemas", [.. cinemas.DistinctBy(w =>
                RailKeys(w).Check.Last()).Take(24)]));
        var canonical = (await Catalog.PersistListingsAsync(dbs, result.SelectMany(r => r.Works), cancellationToken))
            .ToDictionary(w => w.Work.WorkKey);
        result = result.Select(r => r with
        {
            Works = [.. r.Works.Where(w => canonical.ContainsKey(w.Work.WorkKey))
                .Select(w => w with { Work = w.Work with { Id = canonical[w.Work.WorkKey].Work.Id } })],
        }).Where(r => !r.Works.IsEmpty).ToList();
        return new([.. result], rails.Any(r => r.Stale));
    }

    private static ImmutableArray<WorkSnapshot> Visible(BrowseRail rail, HashSet<string> seen, int limit, DateTimeOffset now) =>
        [.. rail.Works.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) &&
                !RailKeys(w).Check.Any(seen.Contains) && !InCinemas(w, now) &&
                !(w.Work.Kind == WorkKind.Film && w.Work.TheatricalAt > now))
            .OrderBy(w => w.PremiereAt is { } premiere ? premiere > now : w.Work.Year > now.Year).Take(limit)];

    private async Task<(BrowseRail? Rail, bool Stale)[]> ApplyCachedHomeReleasesAsync(
        (BrowseRail? Rail, bool Stale)[] rails, CancellationToken cancellationToken)
    {
        var presentations = rails.Where(r => r.Rail is not null).SelectMany(r => r.Rail!.Works)
            .DistinctBy(w => w.Work.WorkKey).ToDictionary(w => w.Work.WorkKey);
        var releaseDetails = await tmdb.CachedFilmDetailsAsync(rails.Where(r => r.Rail is not null)
            .SelectMany(r => r.Rail!.Works).Where(NeedsHomeRelease)
            .Select(w => w.Links.First(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified).ExternalId),
            cancellationToken);
        for (var i = 0; i < rails.Length; i++)
            if (rails[i].Rail is { } native)
                rails[i] = (native with { Works = [.. native.Works.Select(w =>
                {
                    var presentation = presentations[w.Work.WorkKey];
                    return NeedsHomeRelease(presentation) && releaseDetails.TryGetValue(
                        presentation.Links.First(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified).ExternalId, out var detail)
                        ? ApplyHomeRelease(presentation, detail) : presentation;
                })] }, rails[i].Stale);
        return rails;
    }

}
