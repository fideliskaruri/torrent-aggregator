using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private sealed record RailSpec(string Id, string Title, string Type, string TmdbPath, string? Query,
        string CineCatalog, string AnimeSort, bool Seasonal = false);
    private static readonly RailSpec[] Featured =
    [
        new("films-popular", "Popular films", "films", "/trending/movie/week", null, "top", ""),
        new("series-popular", "Popular series", "series", "/trending/tv/week", null, "top", ""),
        new("anime-season", "Anime this season", "anime", "", null, "", "POPULARITY_DESC", true),
        new("films-new", "New films", "films", "/discover/movie", "sort_by=popularity.desc&with_release_type=4|5", "year", ""),
        new("series-new", "New series", "series", "/discover/tv", "sort_by=first_air_date.desc&without_genres=10763|10767|10766", "year", ""),
        new("anime-trending", "Trending anime", "anime", "", null, "", "TRENDING_DESC"),
        new("films-top", "Top rated films", "films", "/movie/top_rated", null, "", ""),
        new("series-top", "Top rated series", "series", "/tv/top_rated", null, "", ""),
        new("anime-top", "Top rated anime", "anime", "", null, "", "SCORE_DESC"),
    ];
    private static readonly (string Id, string Name)[] FilmGenres =
    [
        ("action", "Action"), ("comedy", "Comedy"), ("drama", "Drama"), ("thriller", "Thrillers"),
        ("horror", "Horror"), ("science-fiction", "Science fiction"), ("crime", "Crime"),
        ("romance", "Romance"), ("family", "Family"), ("documentary", "Documentary"),
    ];
    private static readonly (string Id, string Name)[] SeriesGenres =
    [
        ("drama", "Drama"), ("comedy", "Comedy"), ("crime", "Crime"), ("action-adventure", "Action and adventure"),
        ("sci-fi-fantasy", "Sci-fi and fantasy"), ("mystery", "Mystery"), ("documentary", "Documentary"), ("reality", "Reality"),
    ];
    private static readonly (string Id, string Name)[] AnimeGenres =
    [
        ("action", "Action"), ("romance", "Romance"), ("fantasy", "Fantasy"), ("comedy", "Comedy"),
        ("slice-of-life", "Slice of life"), ("sci-fi", "Sci-fi"), ("sports", "Sports"), ("mystery", "Mystery"),
    ];

    public async Task<BrowseResult> BrowseAsync(BrowseQuery query, CancellationToken cancellationToken)
    {
        var type = query.Type is "films" or "series" or "anime" ? query.Type : "all";
        await map.LoadAsync(cancellationToken);
        map.RefreshInBackground();
        var specs = Featured.Where(r => type == "all" || r.Type == type).ToArray();
        var genres = type switch { "films" => FilmGenres, "series" => SeriesGenres, "anime" => AnimeGenres, _ => [] };
        if (type != "all")
            specs = [.. specs, .. genres.Select(g => new RailSpec(type + "-" + g.Id, g.Name + " " + type,
                type, type == "films" ? "/discover/movie" : "/discover/tv",
                "with_genres=" + GenreId(g.Id), "top", "POPULARITY_DESC"))];
        if (query.Genre is { Length: > 0 } genre)
            specs = [new(type + "-" + genre, GenreName(genre) + " " + type, type,
                type == "films" ? "/discover/movie" : "/discover/tv",
                "with_genres=" + GenreId(genre), "top", "POPULARITY_DESC")];
        var tasks = specs.Select(s => RailAsync(s, query.Genre ??
            genres.FirstOrDefault(g => s.Id == type + "-" + g.Id).Id, cancellationToken)).ToArray();
        var rails = await Task.WhenAll(tasks);
        var seen = new HashSet<string>();
        var result = new List<BrowseRail>();
        var cinemas = new List<WorkSnapshot>();
        var now = DateTimeOffset.UtcNow;
        foreach (var (rail, _) in rails)
        {
            if (rail is null) continue;
            cinemas.AddRange(rail.Works.Where(w => InCinemas(w.Work, now)));
            var visible = rail.Works.Where(w => !seen.Contains(w.Work.Id) && !InCinemas(w.Work, now) &&
                    !(w.Work.Kind == WorkKind.Film && w.Work.TheatricalAt > now))
                .OrderBy(w => w.Work.ProviderStatus == "NOT_YET_RELEASED" || w.Work.Year > now.Year)
                .Take(20).ToImmutableArray();
            foreach (var work in visible) seen.Add(work.Work.Id);
            if (!visible.IsEmpty) result.Add(rail with { Works = visible });
        }
        if (type is "all" or "films" && cinemas.Count > 0)
            result.Add(new("films-cinemas", "In cinemas", [.. cinemas.DistinctBy(w => w.Work.Id).Take(20)]));
        return new([.. result], rails.Any(r => r.Stale));
    }

    private async Task<(BrowseRail? Rail, bool Stale)> RailAsync(RailSpec spec, string? genre, CancellationToken ct)
    {
        var cacheId = ProviderHttp.Id("rail:" + spec.Id);
        var previous = (await store.ReadAsync<MetadataCacheRow>(CatalogStore.Query(cacheId), ct)).FirstOrDefault();
        if (previous is not null && previous.ExpiresAt > DateTimeOffset.UtcNow)
            return (await ReadRailAsync(previous, ct), false);
        var configured = await store.SettingsAsync(ct);
        var hasTmdb = configured.EnabledProviders.Contains("tmdb") && await tmdb.EnabledAsync(ct);
        if (spec.Type == "anime" && !configured.EnabledProviders.Contains("anilist") ||
            spec.Type != "anime" && !hasTmdb && (spec.CineCatalog.Length == 0 ||
                !configured.EnabledProviders.Contains("cinemeta")))
            return (null, false);
        var candidates = new List<WorkSnapshot>();
        string? provider = null;
        var failed = false;
        if (spec.Type == "anime" && configured.EnabledProviders.Contains("anilist"))
        {
            var answer = await anilist.BrowseAsync(spec.AnimeSort, genre is null ? null : GenreName(genre), spec.Seasonal, ct);
            failed = !answer.Complete || answer.Stale;
            foreach (var media in answer.Json?.Obj("data").Obj("Page").Obj("media").Items() ?? [])
            {
                var b = new WorkBuilder(new("anilist", media.Text("id")!, null));
                MapAnime(b, media);
                b.Work = b.Work with { RefreshedAt = null };
                candidates.Add(b.Build());
            }
            provider = "anilist";
        }
        else
        {
            var kind = spec.Type == "series" ? WorkKind.Series : WorkKind.Film;
            if (configured.EnabledProviders.Contains("tmdb") && await tmdb.EnabledAsync(ct) &&
                (previous is null || previous.Provider == "tmdb"))
            {
                var dateFilter = spec.Id == "films-new" ? "&release_date.gte=" + DateTime.UtcNow.AddDays(-90).ToString("yyyy-MM-dd") +
                    "&release_date.lte=" + DateTime.UtcNow.ToString("yyyy-MM-dd") :
                    spec.Id == "series-new" ? "&first_air_date.gte=" + DateTime.UtcNow.AddDays(-180).ToString("yyyy-MM-dd") +
                    "&first_air_date.lte=" + DateTime.UtcNow.ToString("yyyy-MM-dd") : "";
                var answer = await tmdb.GetAsync(spec.TmdbPath, "include_adult=false&" + spec.Query + dateFilter, ct,
                    ttl: TimeSpan.FromDays(1));
                failed = !answer.Complete || answer.Stale;
                foreach (var media in answer.Json?.Obj("results").Items() ?? [])
                {
                    var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind)));
                    MapTmdb(b, media, kind);
                    ApplyMap(b, map.Find(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind))));
                    b.Work = b.Work with { RefreshedAt = null };
                    candidates.Add(b.Build());
                }
                provider = "tmdb";
            }
            if (candidates.Count == 0 && previous is null && spec.CineCatalog.Length > 0 ||
                previous?.Provider == "cinemeta")
            {
                var path = "/catalog/" + CinemetaClient.Kind(kind) + "/" + spec.CineCatalog +
                    (genre is null ? spec.CineCatalog == "year" ? "/genre=" + DateTime.Now.Year : "" :
                        "/genre=" + Uri.EscapeDataString(GenreName(genre))) + ".json";
                var answer = await cinemeta.GetAsync(path, ct, ttl: TimeSpan.FromDays(1));
                failed = !answer.Complete || answer.Stale;
                foreach (var media in answer.Json?.Obj("metas").Items() ?? [])
                {
                    var b = new WorkBuilder(new("cinemeta", media.Text("id")!, CinemetaClient.Kind(kind)));
                    MapCinemeta(b, media, kind);
                    ApplyMap(b, map.Find(new("imdb", media.Text("id")!, null)));
                    b.Work = b.Work with { RefreshedAt = null };
                    candidates.Add(b.Build());
                }
                provider = "cinemeta";
            }
        }
        if (failed && previous is not null) return (await ReadRailAsync(previous, ct), true);
        if (failed || candidates.Count == 0) return (null, true);
        var stored = new List<WorkSnapshot>();
        foreach (var candidate in candidates.Take(50))
        {
            var row = await PersistAsync(candidate, ct);
            if (row is not null) stored.Add(row);
        }
        var now = DateTimeOffset.UtcNow;
        var payload = JsonSerializer.SerializeToElement(new { spec.Id, spec.Title,
            workIds = stored.Select(w => w.Work.Id).ToArray() }, CatalogStore.Json);
        var expires = new DateTimeOffset(DateTime.Now.Date.AddDays(1)).ToUniversalTime();
        var cache = new MetadataCacheRow(cacheId, CacheKind.BrowseRail, "rail:" + spec.Id, payload,
            now, expires, null, null, true, provider);
        await store.CommitAsync([new(cache, null, previous)], null, ct);
        return (new(spec.Id, spec.Title, [.. stored]), false);
    }

    private async Task<BrowseRail?> ReadRailAsync(MetadataCacheRow row, CancellationToken ct)
    {
        var works = new List<WorkSnapshot>();
        foreach (var id in row.Payload.Obj("workIds").Strings())
            if (await store.SnapshotAsync(id, ct) is { } work) works.Add(work);
        return new(row.Payload.Text("id")!, row.Payload.Text("title")!, [.. works]);
    }

    public async Task<MetadataExtras?> ExtrasAsync(MetadataQuery query, int? season, CancellationToken cancellationToken)
    {
        var result = await ResolveAsync(query, cancellationToken);
        if (result.Work is not { } work) return null;
        var primary = work.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified);
        int? votes = null;
        string? certification = null;
        WorkSnapshot? partOf = null;
        ImmutableArray<WorkSnapshot> similar = [];
        if (primary?.Provider == "tmdb")
        {
            var detail = await tmdb.DetailAsync(primary.ExternalId, work.Work.Kind, cancellationToken, false);
            votes = detail.Json?.Int("vote_count");
            certification = detail.Json?.Obj("release_dates").Obj("results").Items()
                .Where(c => c.Text("iso_3166_1") == "US").SelectMany(c => c.Obj("release_dates").Items())
                .Select(c => c.Text("certification")).FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));
            var recommendations = await RecommendAsync([work.Work.Id], cancellationToken);
            similar = recommendations?.Works ?? [];
            if (detail.Json?.Obj("belongs_to_collection") is { ValueKind: JsonValueKind.Object } collection)
            {
                var collectionId = collection.Text("id");
                if (collectionId is not null)
                {
                    var b = new WorkBuilder(new("tmdbcollection", collectionId, null));
                    var link = b.Link("tmdbcollection", collectionId);
                    b.Name(collection.Text("name"), NameLabel.English, link);
                    b.Work = b.Work with { PosterUrl = JsonFacts.Image(collection.Text("poster_path"), "w500"),
                        BackdropUrl = JsonFacts.Image(collection.Text("backdrop_path"), "w1280") };
                    partOf = b.Build();
                }
            }
        }
        var now = DateTimeOffset.UtcNow;
        var home = new[] { work.Work.DigitalAt, work.Work.PhysicalAt }.OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();
        var theatrical = InCinemas(work.Work, now);
        return new(work, season is { } number ? work.Seasons.FirstOrDefault(s => s.Number == number)?.Id : null,
            similar, partOf, votes, certification, result.Complete, theatrical, home > now ? home : null, now);
    }

    public async Task<BrowseRail?> RecommendAsync(ImmutableArray<string> seedWorkIds, CancellationToken cancellationToken)
    {
        var rows = new List<WorkSnapshot>();
        foreach (var id in seedWorkIds.Take(3))
        {
            var seed = await store.SnapshotAsync(id, cancellationToken);
            if (seed is null) continue;
            var link = seed.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified);
            if (link is not null && await tmdb.EnabledAsync(cancellationToken))
            {
                var answer = await tmdb.GetAsync("/" + JsonFacts.Kind(seed.Work.Kind) + "/" + link.ExternalId + "/recommendations",
                    "", cancellationToken, ttl: TimeSpan.FromDays(1));
                foreach (var media in answer.Json?.Obj("results").Items() ?? [])
                {
                    var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(seed.Work.Kind)));
                    MapTmdb(b, media, seed.Work.Kind);
                    b.Work = b.Work with { RefreshedAt = null };
                    rows.Add(b.Build());
                }
            }
            else if (seed.Links.FirstOrDefault(l => l.Provider == "anilist" && l.Status == LinkStatus.Verified) is { } anime)
            {
                var answer = await anilist.RecommendationsAsync(anime.ExternalId, cancellationToken);
                foreach (var media in (answer.Json?.Obj("data").Obj("Media").Obj("recommendations").Obj("nodes").Items() ?? [])
                    .Select(n => n.Obj("mediaRecommendation")).Where(n => n.ValueKind == JsonValueKind.Object))
                {
                    var b = new WorkBuilder(new("anilist", media.Text("id")!, null));
                    MapAnime(b, media);
                    b.Work = b.Work with { RefreshedAt = null };
                    rows.Add(b.Build());
                }
            }
            else
            {
                var browse = await BrowseAsync(new(seed.Work.Kind == WorkKind.Series ? "series" : "films", null, null),
                    cancellationToken);
                rows.AddRange(browse.Rails.SelectMany(r => r.Works).Where(w => !seedWorkIds.Contains(w.Work.Id))
                    .OrderByDescending(w => w.Work.Genres.Intersect(seed.Work.Genres).Count()).Take(20));
            }
        }
        return rows.Count == 0 ? null : new("because", "Because you're watching",
            [.. rows.DistinctBy(w => w.Work.WorkKey).Take(20)]);
    }

    private static string GenreName(string genre) => genre.Replace('-', ' ') switch
    {
        "science fiction" or "sci fi" => "Sci-Fi", "slice of life" => "Slice of Life",
        "reality" => "Reality-TV",
        var value => System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(value),
    };
    private static bool InCinemas(WorkRow work, DateTimeOffset now)
    {
        var home = new[] { work.DigitalAt, work.PhysicalAt }.OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();
        return work.Kind == WorkKind.Film && work.TheatricalAt <= now &&
            (home is { } at ? at > now : work.TheatricalAt > now.AddDays(-21));
    }
    private static int GenreId(string genre) => genre switch
    {
        "action" => 28, "comedy" => 35, "drama" => 18, "thriller" => 53, "horror" => 27,
        "science-fiction" or "sci-fi" => 878, "crime" => 80, "romance" => 10749, "family" => 10751,
        "documentary" => 99, "mystery" => 9648, "action-adventure" => 10759, "sci-fi-fantasy" => 10765,
        "reality" => 10764, _ => 0,
    };
}
