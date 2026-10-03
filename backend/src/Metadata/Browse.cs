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
        await map.LoadAsync(cancellationToken);
        map.RefreshInBackground();
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
        var tasks = specs.Select(s => RailAsync(s, query.Genre ??
            genres.FirstOrDefault(g => s.Id == type + "-" + g.Id)?.Id, cancellationToken)).ToArray();
        var rails = await Task.WhenAll(tasks);
        var seen = new HashSet<string>();
        var result = new List<BrowseRail>();
        if (type == "all" && query.UserId is { } userId)
        {
            var watches = await store.AllAsync<WatchItemRow>(CatalogStore.Query() with { UserId = userId }, cancellationToken);
            var seed = watches.OrderByDescending(w => w.UpdatedAt).FirstOrDefault();
            if (seed is not null && await store.SnapshotAsync(seed.WorkId, cancellationToken) is { } work &&
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
            var visible = rail.Works.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) &&
                    !RailKeys(w).Check.Any(seen.Contains) && !InCinemas(w, now) &&
                    !(w.Work.Kind == WorkKind.Film && w.Work.TheatricalAt > now))
                .OrderBy(w => w.PremiereAt is { } premiere ? premiere > now : w.Work.Year > now.Year)
                .Take(query.Genre is { Length: > 0 } ? 48 : 24).ToImmutableArray();
            foreach (var work in visible) seen.UnionWith(RailKeys(work).Claim);
            if (!visible.IsEmpty) result.Add(rail with { Works = visible });
        }
        if (query.Genre is null && type is "all" or "films" && cinemas.Count > 0)
            result.Add(new("films-cinemas", "In cinemas", [.. cinemas.DistinctBy(w =>
                RailKeys(w).Check.Last()).Take(24)]));
        return new([.. result], rails.Any(r => r.Stale));
    }

    private async Task<(BrowseRail? Rail, bool Stale)> RailAsync(RailSpec spec, string? genre, CancellationToken ct)
    {
        var cacheId = ProviderHttp.Id("rail:" + spec.Id);
        var feed = ProviderHttp.Id(spec.TmdbPath + "|" + spec.Query + "|" + spec.AnimeSort + "|" + spec.Seasonal + "|" + genre + "|legacy-listings-v4");
        var previous = (await store.ReadAsync<MetadataCacheRow>(CatalogStore.Query(cacheId), ct)).FirstOrDefault();
        var configured = await store.SettingsAsync(ct);
        var hasTmdb = configured.EnabledProviders.Contains("tmdb") && await tmdb.EnabledAsync(ct);
        var preferred = spec.Type == "anime" ? "anilist" : hasTmdb ? "tmdb" : "cinemeta";
        if (previous is not null && previous.ExpiresAt > DateTimeOffset.UtcNow && previous.Payload.Text("feed") == feed &&
            previous.Provider == preferred &&
            previous.Payload.Obj("workIds").Strings().Count() >= (genre is null ? 24 : 48))
            return (await ReadRailAsync(previous, spec.Title, ct), false);
        if (spec.Type == "anime" && !configured.EnabledProviders.Contains("anilist") ||
            spec.Type != "anime" && !hasTmdb && (spec.CineCatalog.Length == 0 ||
                !configured.EnabledProviders.Contains("cinemeta")))
            return (null, false);
        var candidates = new List<WorkSnapshot>();
        string? provider = null;
        var failed = false;
        if (spec.Type == "anime" && configured.EnabledProviders.Contains("anilist"))
        {
            var answers = await Task.WhenAll(Enumerable.Range(1, 2).Select(page =>
                anilist.BrowseAsync(spec.AnimeSort, genre is null ? null : GenreName(genre), spec.Seasonal, ct, page)));
            failed = answers.Any(answer => !answer.Complete || answer.Stale);
            foreach (var media in answers.SelectMany(answer => answer.Json?.Obj("data").Obj("Page").Obj("media").Items() ?? []))
            {
                var b = new WorkBuilder(new("anilist", media.Text("id")!, null));
                MapAnime(b, media);
                b.Work = b.Work with { RefreshedAt = null };
                candidates.Add(b.Build() with { PremiereAt = JsonFacts.Start(media.Obj("startDate")),
                    ProviderFormat = media.Text("format") });
            }
            provider = "anilist";
        }
        else
        {
            var kind = spec.Type == "series" ? WorkKind.Series : WorkKind.Film;
            if (hasTmdb)
            {
                var dateFilter = spec.Id == "films-new" ? "&release_date.gte=" + DateTime.Now.AddDays(-90).ToString("yyyy-MM-dd") +
                    "&release_date.lte=" + DateTime.Now.ToString("yyyy-MM-dd") :
                    spec.Id == "series-new" ? "&first_air_date.gte=" + DateTime.Now.AddDays(-180).ToString("yyyy-MM-dd") +
                    "&first_air_date.lte=" + DateTime.Now.ToString("yyyy-MM-dd") : "";
                var answers = await Task.WhenAll(Enumerable.Range(1, 5).Select(page =>
                    tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=" + page,
                        ct, ttl: TimeSpan.FromDays(1))));
                failed = answers.Any(answer => !answer.Complete || answer.Stale);
                foreach (var media in answers.SelectMany(answer => answer.Json?.Obj("results").Items() ?? [])
                    .DistinctBy(media => media.Text("id")))
                {
                    var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind)));
                    MapTmdb(b, media, kind);
                    b.Work = b.Work with { RefreshedAt = null };
                    candidates.Add(b.Build() with { PremiereAt = JsonFacts.Date(
                        media.Text(kind == WorkKind.Film ? "release_date" : "first_air_date")) });
                }
                provider = "tmdb";
            }
            if (spec.CineCatalog.Length > 0 && configured.EnabledProviders.Contains("cinemeta") &&
                (!hasTmdb || candidates.Count == 0 && previous is null))
            {
                var answers = await Task.WhenAll(Enumerable.Range(0, 2).Select(page =>
                {
                    var parameters = new List<string>();
                    if (genre is not null) parameters.Add("genre=" + Uri.EscapeDataString(GenreName(genre)));
                    else if (spec.CineCatalog == "year") parameters.Add("genre=" + DateTime.Now.Year);
                    if (page > 0) parameters.Add("skip=" + page * 50);
                    var path = "/catalog/" + CinemetaClient.Kind(kind) + "/" + spec.CineCatalog +
                        (parameters.Count == 0 ? "" : "/" + string.Join('&', parameters)) + ".json";
                    return cinemeta.GetAsync(path, ct, ttl: TimeSpan.FromDays(1));
                }));
                failed = answers.Any(answer => !answer.Complete || answer.Stale);
                foreach (var media in answers.SelectMany(answer => answer.Json?.Obj("metas").Items() ?? []))
                {
                    var b = new WorkBuilder(new("cinemeta", media.Text("id")!, CinemetaClient.Kind(kind)));
                    MapCinemeta(b, media, kind);
                    b.Work = b.Work with { RefreshedAt = null, Anime = false };
                    candidates.Add(b.Build() with { PremiereAt = JsonFacts.Date(media.Text("released")) });
                }
                provider = "cinemeta";
            }
        }
        if (failed && previous is not null) return (await ReadRailAsync(previous, spec.Title, ct), true);
        if (failed || candidates.Count == 0) return (null, true);
        var enriched = await Task.WhenAll(candidates.Select(candidate => HomeReleaseAsync(candidate, ct)));
        var stored = new List<WorkSnapshot>();
        foreach (var candidate in enriched.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))
            .DistinctBy(w => w.Work.WorkKey).Take(96))
        {
            var row = await PersistAsync(candidate, ct, listing: true);
            // Provider entries (anime sequels, for example) are not the canonical work's root presentation.
            // Cache the listing projection, while ownership continues to refer to the canonical work id.
            stored.Add(row is null ? candidate : candidate with { Work = candidate.Work with
            {
                Id = row.Work.Id,
            }});
        }
        var now = DateTimeOffset.UtcNow;
        var payload = JsonSerializer.SerializeToElement(new { spec.Id, spec.Title, feed,
            workIds = stored.Select(w => w.Work.Id).ToArray(), entries = stored.ToArray() }, CatalogStore.Json);
        var expires = new DateTimeOffset(DateTime.Now.Date.AddDays(1)).ToUniversalTime();
        var cache = new MetadataCacheRow(cacheId, CacheKind.BrowseRail, "rail:" + spec.Id, payload,
            now, expires, null, null, true, provider);
        await store.CommitAsync([new(cache, null, previous)], null, ct);
        return (new(spec.Id, spec.Title, [.. stored]), false);
    }

    private async Task<BrowseRail?> ReadRailAsync(MetadataCacheRow row, string title, CancellationToken ct)
    {
        if (row.Payload.Obj("entries").ValueKind == JsonValueKind.Array)
            return new(row.Payload.Text("id")!, title,
                [.. row.Payload.Obj("entries").Deserialize<WorkSnapshot[]>(CatalogStore.Json)!
                    .Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))]);
        var works = new List<WorkSnapshot>();
        foreach (var id in row.Payload.Obj("workIds").Strings())
            if (await store.SnapshotAsync(id, ct) is { } work && !string.IsNullOrWhiteSpace(work.Work.PosterUrl)) works.Add(work);
        return new(row.Payload.Text("id")!, title, [.. works]);
    }

    private static (string[] Check, string[] Claim) RailKeys(WorkSnapshot work)
    {
        var link = work.Links.First(l => l.IsPrimary);
        var exact = new[] { "id:" + link.Provider + ":" + work.Work.Kind + ":" + link.ExternalId,
            "key:" + work.Work.WorkKey };
        var title = SearchText.Compact(work.Names.First().Value);
        if (work.Work.Kind == WorkKind.Series)
            return ([.. exact, "series:" + title], [.. exact, "series:" + title]);
        var yearless = "film:" + title + ":";
        return work.Work.Year is { } year
            ? ([.. exact, yearless + year, yearless], [.. exact, yearless + year, yearless + "*"])
            : ([.. exact, yearless, yearless + "*"], [.. exact, yearless]);
    }

    private async Task<WorkSnapshot> HomeReleaseAsync(WorkSnapshot work, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if (work.Work.Kind != WorkKind.Film || work.Work.TheatricalAt < now.AddDays(-180) ||
            work.Work.TheatricalAt > now || work.Work.TheatricalAt is null ||
            work.Links.FirstOrDefault(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb") is not { } link) return work;
        ProviderAnswer detail;
        var background = ProviderHttp.Background.Value;
        try
        {
            ProviderHttp.Background.Value = true;
            detail = await tmdb.DetailAsync(link.ExternalId, WorkKind.Film, ct, false);
        }
        finally { ProviderHttp.Background.Value = background; }
        if (detail.Json is not { ValueKind: JsonValueKind.Object } json) return work;
        var b = new WorkBuilder(new("tmdb", link.ExternalId, "movie")) { Work = work.Work };
        b.Names.AddRange(work.Names); b.Links.AddRange(work.Links);
        MapTmdb(b, json, WorkKind.Film);
        var releases = json.Obj("release_dates").Obj("results").Items()
            .SelectMany(country => country.Obj("release_dates").Items()).ToArray();
        var checkedEvidence = releases.Any(r => r.Int("type") is >= 1 and <= 6 &&
            JsonFacts.Date(r.Text("release_date")) is not null);
        var theatrical = EarliestRelease(json, [1, 2, 3]);
        var home = new[] { b.Work.DigitalAt, b.Work.PhysicalAt }.OfType<DateTimeOffset>().Order()
            .Cast<DateTimeOffset?>().FirstOrDefault();
        var primary = work.PremiereAt ?? work.Work.TheatricalAt;
        var today = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero);
        var inCinemas = checkedEvidence
            ? primary <= today && theatrical <= today && primary >= today.AddDays(-180) &&
                theatrical >= today.AddDays(-180) && (home is null || home > today)
            : primary <= today && primary >= today.AddDays(-21);
        return b.Build() with { PremiereAt = work.PremiereAt, InTheatricalWindow = inCinemas };
    }

    private async Task<BrowseRail?> HomeRecommendationsAsync(WorkSnapshot seed, BrowseRail[] rails, CancellationToken ct)
    {
        var title = seed.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ?? seed.Names.First().Value;
        var pool = rails.Where(r => r.Id is "films-popular" or "series-popular" or "anime-trending")
            .SelectMany(r => r.Works).ToArray();
        var onScreen = rails.Where(r => r.Id is "films-popular" or "series-popular" or "anime-trending")
            .SelectMany(r => r.Works.Take(24)).Select(w => w.Work.WorkKey).ToHashSet();
        var rows = new List<WorkSnapshot>();
        if (await tmdb.EnabledAsync(ct))
        {
            var search = await tmdb.SearchAsync(title, seed.Work.Kind, null, ct);
            var id = search.Json?.Obj("results").Items().FirstOrDefault().Text("id");
            if (id is not null)
                rows.AddRange(await TmdbRecommendationsAsync(id, seed.Work.Kind, ct));
        }
        if (rows.Count == 0)
        {
            var seedIndex = Array.FindIndex(pool, w => w.Work.Id == seed.Work.Id);
            rows.AddRange(pool.Where(w => w.Work.Kind == seed.Work.Kind && w.Work.Id != seed.Work.Id)
                .OrderBy(w => onScreen.Contains(w.Work.WorkKey))
                .ThenBy(w => seedIndex < 0 ? 0 : Math.Abs(Array.IndexOf(pool, w) - seedIndex)));
        }
        var stored = new List<WorkSnapshot>();
        foreach (var row in rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) &&
            SearchText.Normalize(w.Names.First().Value) != SearchText.Normalize(title))
            .OrderBy(w => onScreen.Contains(w.Work.WorkKey)).Take(24))
            if (await PersistAsync(row, ct, listing: true) is { } work)
                stored.Add(row with { Work = row.Work with { Id = work.Work.Id } });
        return stored.Count == 0 ? null : new("because", "Because you're watching " + title, [.. stored]);
    }

    private async Task<List<WorkSnapshot>> TmdbRecommendationsAsync(string id, WorkKind kind, CancellationToken ct)
    {
        var answer = await tmdb.GetAsync("/" + JsonFacts.Kind(kind) + "/" + id + "/recommendations",
            "", ct, ttl: TimeSpan.FromDays(1));
        return (answer.Json?.Obj("results").Items() ?? []).Select(media =>
        {
            var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind)));
            MapTmdb(b, media, kind);
            b.Work = b.Work with { RefreshedAt = null };
            return b.Build();
        }).ToList();
    }

    public async Task<MetadataExtras?> ExtrasAsync(MetadataQuery query, int? season, CancellationToken cancellationToken)
    {
        var result = await ResolveAsync(query, cancellationToken);
        if (result.Work is not { } work) return null;
        work = await HomeReleaseAsync(work, cancellationToken);
        var primary = work.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified);
        int? votes = null;
        string? certification = null;
        WorkSnapshot? partOf = null;
        var recommendations = await RecommendAsync([work.Work.Id], cancellationToken);
        ImmutableArray<WorkSnapshot> similar = recommendations is null ? [] :
            [.. recommendations.Works.Take(12)];
        if (primary?.Provider == "tmdb")
        {
            var detail = await tmdb.DetailAsync(primary.ExternalId, work.Work.Kind, cancellationToken, false);
            votes = detail.Json?.Int("vote_count");
            certification = detail.Json?.Obj("release_dates").Obj("results").Items()
                .Where(c => c.Text("iso_3166_1") == "US").SelectMany(c => c.Obj("release_dates").Items())
                .Select(c => c.Text("certification")).FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));
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
        var theatrical = InCinemas(work, now);
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
            if (seed.Work.Anime != true && link is not null && await tmdb.EnabledAsync(cancellationToken))
            {
                rows.AddRange(await TmdbRecommendationsAsync(link.ExternalId, seed.Work.Kind, cancellationToken));
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
                var browse = await BrowseAsync(new(seed.Work.Anime == true ? "anime" :
                    seed.Work.Kind == WorkKind.Series ? "series" : "films", null, null),
                    cancellationToken);
                rows.AddRange(browse.Rails.SelectMany(r => r.Works).Where(w => !seedWorkIds.Contains(w.Work.Id))
                    .OrderByDescending(w => w.Work.Genres.Intersect(seed.Work.Genres).Count()).Take(20));
            }
        }
        var stored = new List<WorkSnapshot>();
        foreach (var row in rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl)).DistinctBy(w => w.Work.WorkKey))
        {
            if (await PersistAsync(row, cancellationToken, listing: true) is { } work && !seedWorkIds.Contains(work.Work.Id) &&
                !string.IsNullOrWhiteSpace(row.Work.PosterUrl))
                stored.Add(row with { Work = row.Work with { Id = work.Work.Id } });
            if (stored.Count == 20) break;
        }
        var first = seedWorkIds.IsEmpty ? null : await store.SnapshotAsync(seedWorkIds[0], cancellationToken);
        var title = first?.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ?? first?.Names.FirstOrDefault()?.Value;
        return stored.Count == 0 ? null : new("because", "Because you're watching " + title, [.. stored]);
    }

    private static string GenreQuery(string type, string genre) => "with_genres=" + GenreId(genre) +
        "&sort_by=popularity.desc&vote_count.gte=" + (type == "films" ? "300" : "100") +
        (type == "series" ? "&without_genres=10763|10767|10766&without_keywords=210024" : "") + "&include_adult=false";

    private static string GenreName(string genre) => genre.Replace('-', ' ') switch
    {
        "science fiction" or "sci fi" or "sci fi fantasy" => "Sci-Fi", "slice of life" => "Slice of Life",
        "action adventure" => "Action",
        "reality" => "Reality-TV",
        var value => System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(value),
    };
    private static bool InCinemas(WorkSnapshot snapshot, DateTimeOffset now)
    {
        if (snapshot.InTheatricalWindow is { } window) return window;
        var work = snapshot.Work;
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
