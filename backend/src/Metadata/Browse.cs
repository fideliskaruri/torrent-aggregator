using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private static readonly JsonSerializerOptions ListingJson = new(JsonSerializerOptions.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
    private sealed record RailSpec(string Id, string Title, string Type, string TmdbPath, string? Query,
        string CineCatalog, string AnimeSort, bool Seasonal = false);
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
            if (seed is not null && await SnapshotAsync(seed.WorkId, cancellationToken) is { } work &&
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
        var canonical = (await PersistListingsAsync(result.SelectMany(r => r.Works), cancellationToken))
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

    private async Task<(BrowseRail? Rail, bool Stale)> RailAsync(RailSpec spec, string? genre, CancellationToken ct,
        Lazy<Dictionary<string, Task<ProviderAnswer[]>>>? anime, MetadataSettings configured, bool hasTmdb,
        bool replenish = false)
    {
        var cacheId = ProviderHttp.Id("rail:" + spec.Id);
        var feed = ProviderHttp.Id(spec.TmdbPath + "|" + spec.Query + "|" + spec.AnimeSort + "|" + spec.Seasonal + "|" + genre + "|legacy-listings-v6");
        MetadataCacheRow? previous;
        await using (var db = await dbs.CreateDbContextAsync(ct))
            previous = await db.MetadataCaches.AsNoTracking().SingleOrDefaultAsync(c => c.Id == cacheId, ct);
        var preferred = spec.Type == "anime" ? "anilist" : hasTmdb ? "tmdb" : "cinemeta";
        if (!replenish && previous is not null && previous.ExpiresAt > DateTimeOffset.UtcNow && previous.Payload.Text("feed") == feed &&
            previous.Provider == preferred &&
            previous.Complete && previous.Payload.Obj("entries") is { ValueKind: JsonValueKind.Array } entries &&
            entries.GetArrayLength() > 0)
            return (await ReadRailAsync(previous, spec.Title, ct), false);
        if (spec.Type == "anime" && !configured.EnabledProviders.Contains("anilist") ||
            spec.Type != "anime" && !hasTmdb && (spec.CineCatalog.Length == 0 ||
                !configured.EnabledProviders.Contains("cinemeta")))
            return (null, false);
        var candidates = new List<WorkSnapshot>();
        if (replenish && previous is not null && await ReadRailAsync(previous, spec.Title, ct) is { } priorRail)
            candidates.AddRange(priorRail.Works);
        string? provider = null;
        var failed = false;
        if (spec.Type == "anime" && configured.EnabledProviders.Contains("anilist"))
        {
            var answers = (await anime!.Value[spec.Id]).Take(1).ToArray();
            failed = answers.Any(answer => !answer.Complete || answer.Stale);
            foreach (var media in answers.SelectMany(answer => answer.Json?.Items() ?? []))
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
                ProviderAnswer[] answers;
                if (replenish)
                    answers = await Task.WhenAll(Enumerable.Range(4, 2).Select(page =>
                        tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=" + page,
                            ct, ttl: TimeSpan.FromDays(1))));
                else
                {
                    var first = await tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=1",
                        ct, ttl: TimeSpan.FromDays(1));
                    var rest = await Task.WhenAll(Enumerable.Range(2, 2).Select(page =>
                    tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=" + page,
                        ct, ttl: TimeSpan.FromDays(1))));
                    answers = [first, .. rest];
                }
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
        var stored = candidates.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))
            .DistinctBy(w => w.Work.WorkKey).Take(96).ToArray();
        var now = DateTimeOffset.UtcNow;
        var payload = JsonSerializer.SerializeToElement(new { spec.Id, spec.Title, feed, projection = "native-names-v1",
            entries = stored.Select(w => new ListingEntry(w.Work, w.Names.Select(n => new ListingName(
                n.Value, n.NormalizedValue, n.Label, n.LinkId is null ? null :
                    Array.FindIndex(w.Links.ToArray(), l => l.Id == n.LinkId))).ToArray(),
                w.Links.ToArray(), w.Seasons, w.Episodes, w.PremiereAt, w.ProviderFormat)).ToArray() }, ListingJson);
        var expires = new DateTimeOffset(DateTime.Now.Date.AddDays(1)).ToUniversalTime();
        var cache = new MetadataCacheRow { Id = cacheId, Kind = CacheKind.BrowseRail, CacheKey = "rail:" + spec.Id, Payload = payload, FetchedAt = now, ExpiresAt = expires, Etag = null, LastModified = null, Complete = true, Provider = provider };
        await using (var db = await dbs.CreateDbContextAsync(ct))
        {
            if (previous is null) db.Add(cache);
            else db.Update(cache);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex)) { }
        }
        return (new(spec.Id, spec.Title, [.. stored]), false);
    }

    private async Task<BrowseRail?> ReadRailAsync(MetadataCacheRow row, string title, CancellationToken ct)
    {
        if (row.Payload.Text("projection") == "native-names-v1")
        {
            var entries = row.Payload.Obj("entries").Deserialize<ListingEntry[]>(ListingJson)!;
            return new(row.Payload.Text("id")!, title, [.. entries.Select(e =>
                new WorkSnapshot(e.Work, [.. e.Names.Select((n, i) => new WorkNameRow { Id = ProviderHttp.Id(e.Work.Id + ":" + n.NormalizedValue + ":" + n.Label + ":" +
                        (n.Link is { } index && index >= 0 ? e.Links[index].Id : "")), WorkId = e.Work.Id, Value = n.Value, NormalizedValue = n.NormalizedValue, Label = n.Label, LinkId = n.Link is { } link && link >= 0 ? e.Links[link].Id : null, Ordinal = i, Authoritative = true, RefreshedAt = e.Work.CreatedAt })],
                    [.. e.Links], e.Seasons, e.Episodes)
                    { PremiereAt = e.PremiereAt, ProviderFormat = e.ProviderFormat })
                .Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))]);
        }
        if (row.Payload.Obj("entries").ValueKind == JsonValueKind.Array)
            return new(row.Payload.Text("id")!, title,
                [.. row.Payload.Obj("entries").Deserialize<WorkSnapshot[]>(JsonSerializerOptions.Web)!
                    .Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))]);
        var works = new List<WorkSnapshot>();
        foreach (var id in row.Payload.Obj("workIds").Strings())
            if (await SnapshotAsync(id, ct) is { } work && !string.IsNullOrWhiteSpace(work.Work.PosterUrl)) works.Add(work);
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

    private static bool NeedsHomeRelease(WorkSnapshot work) =>
        work.Work.Kind == WorkKind.Film && work.Work.TheatricalAt >= DateTimeOffset.UtcNow.AddDays(-180) &&
        work.Work.TheatricalAt <= DateTimeOffset.UtcNow &&
        work.Links.Any(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");

    private async Task<WorkSnapshot> HomeReleaseAsync(WorkSnapshot work, CancellationToken ct)
    {
        if (!NeedsHomeRelease(work)) return work;
        var link = work.Links.First(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");
        ProviderAnswer detail;
        var background = ProviderHttp.Background.Value;
        try
        {
            ProviderHttp.Background.Value = true;
            detail = await tmdb.DetailAsync(link.ExternalId, WorkKind.Film, ct, false);
        }
        finally { ProviderHttp.Background.Value = background; }
        return detail.Json is { ValueKind: JsonValueKind.Object } json ? ApplyHomeRelease(work, json) : work;
    }

    private static WorkSnapshot ApplyHomeRelease(WorkSnapshot work, JsonElement json)
    {
        var now = DateTimeOffset.UtcNow;
        var link = work.Links.First(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");
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
        var stored = await PersistListingsAsync(rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) &&
            SearchText.Normalize(w.Names.First().Value) != SearchText.Normalize(title))
            .OrderBy(w => onScreen.Contains(w.Work.WorkKey)).Take(24), ct);
        return stored.IsEmpty ? null : new("because", "Because you're watching " + title, stored);
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
            var seed = await SnapshotAsync(id, cancellationToken);
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
        var stored = (await PersistListingsAsync(rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))
            .DistinctBy(w => w.Work.WorkKey), cancellationToken))
            .Where(w => !seedWorkIds.Contains(w.Work.Id)).Take(20).ToImmutableArray();
        var first = seedWorkIds.IsEmpty ? null : await SnapshotAsync(seedWorkIds[0], cancellationToken);
        var title = first?.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ?? first?.Names.FirstOrDefault()?.Value;
        return stored.IsEmpty ? null : new("because", "Because you're watching " + title, stored);
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
