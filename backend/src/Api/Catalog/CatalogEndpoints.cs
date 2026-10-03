using System.Collections.Immutable;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal static class CatalogEndpoints
{
    internal static void AddCatalog(this IServiceCollection services)
    {
        services.AddScoped(sp => new CatalogState(sp.GetRequiredKeyedService<IStore>("targets")));
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
    }
    private static IResult Json(object body, int status = 200) =>
        Results.Json(body, CatalogProjection.Json, statusCode: status);
    private static string? Param(HttpContext h, string key) => h.Request.Query[key].FirstOrDefault();
    private static int? Number(string? value) => int.TryParse(Regex.Match(value?.TrimStart() ?? "", @"^[+-]?\d+",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking).Value, out var n) ? n : null;
    private static string ActorId(HttpContext h) => AccessIdentity.UserId(h);

    internal static void MapCatalog(this WebApplication app)
    {
        app.MapGet("/api/search/titles", Search);
        app.MapGet("/api/suggest", Suggest);
        app.MapGet("/api/browse", Browse);
        app.MapGet("/api/recommendations", Recommend);
        app.MapPost("/api/artwork", Artwork);
        app.MapGet("/api/title/{workKey}", Detail);
        app.MapGet("/api/title/{workKey}/extras", Extras);
        app.MapGet("/api/title/{workKey}/links", Links);
        app.MapDelete("/api/title/{workKey}/links/{provider}/{externalId}", Unlink);
        TitleReleases.Map(app);
        app.MapGet("/api/title/{workKey}/progress", (string workKey) => Json(new
        {
            workKey, transfer = (object?)null, seasonTransfers = new Dictionary<string, object>(),
            episodeTransfers = new Dictionary<string, object>(), generatedAt = DateTimeOffset.UtcNow,
        }));
        app.MapGet("/api/watchlist", Watchlist);
        app.MapPost("/api/watchlist", SaveWatch);
        app.MapPatch("/api/watchlist", SaveWatch);
        app.MapDelete("/api/watchlist", RemoveWatch);
    }

    private static async Task<IResult> Search(HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var q = Param(h, "q")?.Trim() ?? "";
        if (q.Length is 0 or > 200) return Json(new { error = q.Length == 0 ?
            "Missing query parameter `q`" : "Query too long", results = Array.Empty<object>() }, 400);
        var category = Param(h, "category")?.ToLowerInvariant() is { } c && c is "movies" or "series" or "anime" ? c : "all";
        var take = Math.Clamp(Number(Param(h, "limit")) is { } n && n != 0 ? n : 12, 1, 40);
        var result = await metadata.SearchAsync(new(q, category == "movies" ? "films" : category, take), ct);
        if (result.Works.IsEmpty && result.Partial) return Json(new
        {
            error = "Title search failed", message = "The catalogs are unavailable. Try searching again shortly.",
            results = Array.Empty<object>(), partial = true, failedProviders = result.FailedProviders,
        }, 500);
        return Json(new { results = result.Works.Where(w => category == "all" || category == "anime" && w.Work.Anime == true ||
                category != "anime" && w.Work.Anime != true).Select(CatalogProjection.Hit), query = q,
            canonicalQuery = Regex.Replace(q, @"\s+", " ").ToLowerInvariant(), category,
            result.Partial, result.FailedProviders, result.Stale });
    }

    private static async Task<IResult> Suggest(HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var q = Param(h, "q")?.Trim() ?? "";
        if (q.Length < 2) return Json(new { suggestions = Array.Empty<object>() });
        if (q.Length > 200) return Json(new { error = "Query too long", suggestions = Array.Empty<object>() }, 400);
        var result = await metadata.SearchAsync(new(q, "all", 8), ct);
        if (result.Works.IsEmpty && result.Partial) return Json(new
        {
            error = "Suggest failed", message = "The catalogs are unavailable. Try again shortly.",
            suggestions = Array.Empty<object>(), partial = false, failedProviders = result.FailedProviders,
        }, 502);
        return Json(new { suggestions = result.Works.Select(w => new
        {
            title = CatalogProjection.Title(w), w.Work.Year, mediaType = CatalogProjection.Type(w),
            w.Work.PosterUrl, w.Work.WorkKey, provider = CatalogProjection.Provider(w),
            providerId = CatalogProjection.Primary(w)?.ExternalId, href = CatalogProjection.Href(w),
            aliases = CatalogProjection.Aliases(w), source = CatalogProjection.Provider(w),
            externalId = CatalogProjection.Primary(w)?.ExternalId,
        }), query = q, canonicalQuery = q.ToLowerInvariant(), result.Partial, result.FailedProviders });
    }

    private static async Task<IResult> Browse(HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var type = Param(h, "type") ?? "all";
        var genre = Param(h, "genre");
        var genres = Genres(type);
        if (type is not ("all" or "films" or "series" or "anime") ||
            genre is { Length: > 0 } && !genres.Any(g => g.Id == genre))
            return Json(new { error = "Home does not have that category. Pick one from the list above." }, 400);
        var result = await metadata.BrowseAsync(new(type, genre, ActorId(h)), ct);
        var rails = result.Rails.Select(r => new
        {
            r.Id, r.Title, items = r.Works.Select(w => CatalogProjection.Card(w, r.Id == "films-cinemas")),
            kind = r.Id.StartsWith("films-", StringComparison.Ordinal) ? "films" :
                r.Id.StartsWith("series-", StringComparison.Ordinal) ? "series" :
                    r.Id.StartsWith("anime-", StringComparison.Ordinal) ? "anime" : null,
            genre = genres.FirstOrDefault(g => r.Id == type + "-" + g.Id).Id,
        });
        return Json(new { rails, generatedAt = DateTimeOffset.UtcNow, view = type, genre,
            genres = genres.Select(g => new { id = g.Id, label = g.Label }) });
    }

    private static (string Id, string Label)[] Genres(string type) =>
        [.. TorrentFlow.Metadata.CatalogViews.Genres(type).Select(g => (g.Id, g.Label))];

    private static async Task<IResult> Recommend(HttpContext h, CatalogState state, IMetadata metadata, CancellationToken ct)
    {
        var watches = await state.ReadAsync<WatchItemRow>(CatalogState.Query(userId: ActorId(h)), ct);
        var seeds = watches.Where(w => w.Status == WatchStatus.Watching).OrderByDescending(w => w.UpdatedAt)
            .Select(w => w.WorkId).Take(1).ToImmutableArray();
        var rail = await metadata.RecommendAsync(seeds, ct);
        var seed = seeds.IsEmpty ? null : (await metadata.GetWorkAsync(seeds[0], false, ct)).Work;
        return Json(new { rail = rail is null ? null : new
        {
            seedTitle = seed is null ? rail.Title : CatalogProjection.Title(seed),
            items = rail.Works.Select(w => new
            {
                provider = CatalogProjection.Provider(w), sourceMediaType = CatalogProjection.Type(w),
                mediaType = CatalogProjection.TitleType(w), titleMediaType = CatalogProjection.TitleType(w),
                externalId = CatalogProjection.Primary(w)?.ExternalId, title = CatalogProjection.Title(w),
                w.Work.PosterUrl, w.Work.Year, w.Work.Rating, format = CatalogProjection.Format(w),
                isSeries = CatalogProjection.Series(w),
            }),
        } });
    }

    private static async Task<MetadataResult> Resolve(string key, HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var provider = Param(h, "provider");
        var id = Param(h, "providerId");
        id ??= Param(h, "externalId");
        var type = Param(h, "type");
        if (provider is null)
        {
            var stored = await metadata.GetWorkAsync(key, false, ct);
            if (stored.Work is not null) return stored;
        }
        if (provider is null && key.Contains(':'))
        {
            var parts = key.Split(':');
            provider = parts[0]; id = parts[^1];
            if (parts.Length == 3) type ??= parts[1];
        }
        var kind = type is "tv" or "series" or "anime" || Param(h, "series") == "1" ? WorkKind.Series :
            type is "movie" or "movies" ? WorkKind.Film : WorkKind.Unknown;
        return await metadata.ResolveAsync(new(provider is not null && id is not null
            ? new(provider, id, provider == "tmdb" ? kind == WorkKind.Series ? "tv" : "movie" : null) : null,
            Param(h, "t") ?? Regex.Replace(key.Replace('-', ' '), @"\s+\d{4}$", ""),
            Number(Param(h, "y")) ?? Number(Regex.Match(key, @"-(\d{4})$",
                RegexOptions.CultureInvariant | RegexOptions.NonBacktracking).Groups[1].Value), kind), ct);
    }

    private static int? Season(WorkSnapshot w, HttpContext h) => !CatalogProjection.Series(w) ? null :
        (Number(Param(h, "s")) ?? Number(Param(h, "remembered"))) is { } chosen &&
            (chosen == 0 && w.Seasons.Any(s => s.Number == 0) ||
                CatalogProjection.TitleSeasons(w).Any(s => s.Number == chosen)) ? chosen :
            CatalogProjection.TitleSeasons(w).FirstOrDefault()?.Number;

    private static async Task<IResult> Detail(string workKey, HttpContext h, IMetadata metadata,
        CatalogState state, CancellationToken ct)
    {
        var provider = Param(h, "provider");
        var external = Param(h, "providerId") ?? Param(h, "externalId");
        if (provider is { Length: > 0 } && provider is not ("tmdb" or "anilist" or "cinemeta" or "tvmaze" or "itunes"))
            return Json(new { error = "Unsupported title provider" }, 400);
        if (external is { Length: > 0 } && string.IsNullOrWhiteSpace(provider))
            return Json(new { error = "A supported title provider is required." }, 400);
        var result = await Resolve(workKey, h, metadata, ct);
        if (result.Work is not { } w) return UnknownTitle(workKey, h);
        var season = Season(w, h);
        var watch = (await state.ReadAsync<WatchItemRow>(CatalogState.Query(workId: w.Work.Id, userId: ActorId(h)), ct)).FirstOrDefault();
        var follow = (await state.ReadAsync<FollowRow>(CatalogState.Query(workId: w.Work.Id), ct)).FirstOrDefault();
        var coordinate = CatalogProjection.Coordinate(w, follow);
        var owned = await state.OwnedAsync(w.Work.Id, ct);
        var episodes = w.Episodes.Where(e => e.MappingStatus != MappingStatus.Unavailable &&
            w.Seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.Number == season).ToArray();
        int? Id(string provider) => Number(w.Links.FirstOrDefault(l => l.Provider == provider && l.Status == LinkStatus.Verified)?.ExternalId);
        return Json(new
        {
            workKey, title = CatalogProjection.Title(w), aliases = CatalogProjection.Aliases(w),
            names = w.Names.DistinctBy(n => (n.Value, n.Label)).Select(n => new { text = n.Value, kind = n.Label.ToString().ToLowerInvariant() }),
            ids = new { tmdb = Id("tmdb"), anilist = Id("anilist"), mal = Id("mal"),
                imdb = w.Links.FirstOrDefault(l => l.Provider == "imdb" && l.Status == LinkStatus.Verified)?.ExternalId },
            format = CatalogProjection.Format(w), originalLanguage = CatalogProjection.PresentationLanguage(w),
            provider = CatalogProjection.Provider(w),
            providerId = CatalogProjection.Primary(w)?.ExternalId, w.Work.Year, mediaType = CatalogProjection.TitleType(w),
            isSeries = CatalogProjection.Series(w), overview = w.Work.Synopsis, w.Work.Rating, w.Work.RatingSource,
            w.Work.PosterUrl, w.Work.BackdropUrl, releaseDate = CatalogProjection.Release(w),
            availability = owned.Any(f => f.EpisodeId is null) ? "ready" : null, infoHash = (string?)null,
            downloadFraction = (double?)null, transfer = (object?)null,
            seasons = CatalogProjection.TitleSeasons(w).Select(s => new
            {
                season = s.Number, knownEpisodes = s.ExpectedEpisodeCount ?? w.Episodes.Count(e => e.SeasonId == s.Id),
                pack = (object?)null, transfer = (object?)null,
                downloadedEpisodes = w.Episodes.Count(e => e.SeasonId == s.Id && owned.Any(f => f.EpisodeId == e.Id)),
                downloadingEpisodes = 0,
            }), season,
            episodes = episodes.Take(200).Select(e => new
            {
                season, episode = e.Number, label = $"S{season:00}E{e.Number:00}",
                availability = owned.Any(f => f.EpisodeId == e.Id) ? "ready" : null,
                infoHash = (string?)null, filePath = (string?)null, downloadFraction = (double?)null,
                nextUp = false, fromPack = false, transfer = (object?)null,
            }), episodesTruncated = episodes.Length > 200,
            library = new
            {
                inLibrary = watch is not null, watchListItemId = watch?.Id, monitored = follow?.Enabled ?? false,
                status = watch?.Status.ToString().ToLowerInvariant(), cursorSeason = coordinate?.Season, cursorEpisode = coordinate?.Episode,
                addPayload = CatalogProjection.AddPayload(w, workKey),
            }, known = true, generatedAt = DateTimeOffset.UtcNow,
        });
    }
    private static IResult UnknownTitle(string workKey, HttpContext h)
    {
        var title = Param(h, "t")?.Trim() ?? workKey;
        var type = Param(h, "type");
        return Json(new
        {
            workKey, title, aliases = Array.Empty<string>(), names = new[] { new { text = title, kind = "english" } },
            ids = new { tmdb = (int?)null, anilist = (int?)null, mal = (int?)null, imdb = (string?)null },
            format = (string?)null, originalLanguage = (string?)null, provider = (string?)null, providerId = (string?)null,
            year = Number(Param(h, "y")), mediaType = type, isSeries = type is "tv" or "anime" or "series",
            overview = (string?)null, rating = (double?)null, ratingSource = (string?)null, posterUrl = (string?)null,
            backdropUrl = (string?)null, releaseDate = (string?)null, availability = (string?)null,
            infoHash = (string?)null, downloadFraction = (double?)null, transfer = (object?)null,
            seasons = Array.Empty<object>(), season = (int?)null, episodes = Array.Empty<object>(), episodesTruncated = false,
            library = new
            {
                inLibrary = false, watchListItemId = (string?)null, monitored = false, status = (string?)null,
                cursorSeason = (int?)null, cursorEpisode = (int?)null,
                addPayload = new { mediaType = type ?? "movie", externalId = "work:" + workKey, title,
                    posterUrl = (string?)null, synopsis = (string?)null, rating = (double?)null, workKey },
            }, known = false, generatedAt = DateTimeOffset.UtcNow,
        });
    }

    private static async Task<IResult> Extras(string workKey, HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var result = await Resolve(workKey, h, metadata, ct);
        var w = result.Work;
        var season = w is null ? Number(Param(h, "s")) : Season(w, h);
        var link = w is null ? null : CatalogProjection.Primary(w);
        var extras = w is null ? null : await metadata.ExtrasAsync(new(link is null ? null :
            new(link.Provider, link.ExternalId, link.ProviderKind), CatalogProjection.Title(w), w.Work.Year, w.Work.Kind), season, ct);
        w = extras?.Work ?? w;
        var seasonId = w?.Seasons.FirstOrDefault(s => s.Number == season)?.Id;
        var payload = new
        {
            workKey, season, seasonCount = w is not null && CatalogProjection.TitleSeasons(w).Count() is > 0 and var count ? (int?)count : null,
            seasons = w is null ? [] : CatalogProjection.TitleSeasons(w).Select(s => s.Number).ToArray(),
            airedEpisodes = w?.Seasons.Where(s => s.Number > 0 && w.Episodes.Any(e => e.SeasonId == s.Id) &&
                w.Episodes.Where(e => e.SeasonId == s.Id).All(e => e.AirAt is not null)).ToDictionary(s => s.Number.ToString(),
                s => w.Episodes.Count(e => e.SeasonId == s.Id && e.AirAt <= DateTimeOffset.UtcNow)) ?? new Dictionary<string, int>(),
            episodes = w?.Episodes.Where(e => e.SeasonId == seasonId && e.MappingStatus != MappingStatus.Unavailable).Select(e => new
            {
                episode = e.Number, name = e.Title, overview = e.Synopsis, airDate = e.AirAt?.ToString("yyyy-MM-dd"),
                runtimeMin = e.RuntimeMinutes, e.StillUrl, airStamp = e.AirAt,
            }).ToArray() ?? [],
            moreLikeThis = extras?.Similar.Select(Similar).ToArray() ?? [],
            partOf = extras?.PartOf is { } parent ? Similar(parent) : null,
            overview = w?.Work.Synopsis, rating = w?.Work.Rating, releaseDate = w is null ? null : CatalogProjection.Release(w),
            inTheatricalWindow = extras?.InTheatricalWindow ?? false,
            nextHomeReleaseAt = extras?.NextHomeReleaseAt?.ToString("yyyy-MM-dd"),
            genres = w?.Work.Genres ?? [], voteCount = extras?.VoteCount, ratingSource = w?.Work.RatingSource,
            certification = extras?.Certification, originalLanguage = w is null ? null :
                CatalogProjection.PresentationLanguage(w)?.ToUpperInvariant(),
            resolved = extras?.Resolved ?? w is not null, generatedAt = DateTimeOffset.UtcNow,
        };
        var node = JsonSerializer.SerializeToNode(payload, CatalogProjection.Json)!;
        if (extras?.PartOf is null) node.AsObject().Remove("partOf");
        foreach (var episode in node["episodes"]!.AsArray())
            if (episode!["airStamp"] is null) episode.AsObject().Remove("airStamp");
        return Json(node);
    }
    private static object Similar(WorkSnapshot w) => new { w.Work.WorkKey, href = CatalogProjection.Href(w),
        title = CatalogProjection.Title(w), w.Work.Year, mediaType = CatalogProjection.TitleType(w), w.Work.PosterUrl, w.Work.Rating };

    private static async Task<IResult> Links(string workKey, HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var result = await Resolve(workKey, h, metadata, ct);
        var w = result.Work;
        if (w is null) return Json(new { error = "This title has no saved record yet." }, 404);
        return Json(new { links = w?.Links.Select(l => new
        {
            l.Id, l.Provider, externalId = l.ExternalId, mediaType = l.ProviderKind,
            season = w.Seasons.FirstOrDefault(s => s.Id == l.SeasonId)?.Number, l.Source,
            confidence = l.Confidence, verified = l.Status == LinkStatus.Verified, rejected = l.Status == LinkStatus.Rejected,
            givesNames = w.Names.Any(n => n.LinkId == l.Id), names = w.Names.Where(n => n.LinkId == l.Id).Select(n => n.Value).Distinct(),
            url = l.Provider switch
            {
                "tmdb" => "https://www.themoviedb.org/" + (l.ProviderKind ?? "movie") + "/" + l.ExternalId,
                "anilist" => "https://anilist.co/anime/" + l.ExternalId,
                "mal" => "https://myanimelist.net/anime/" + l.ExternalId,
                "imdb" => "https://www.imdb.com/title/" + l.ExternalId + "/",
                "tvdb" => "https://thetvdb.com/dereferrer/series/" + l.ExternalId,
                "tvmaze" => "https://www.tvmaze.com/shows/" + l.ExternalId,
                _ => (string?)null,
            },
        }).ToArray() ?? [] });
    }

    private static async Task<IResult> Unlink(string workKey, string provider, string externalId,
        HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        var link = work?.Links.FirstOrDefault(l => l.Provider == provider.Trim().ToLowerInvariant() &&
            l.ExternalId == externalId.Trim() && l.Status != LinkStatus.Rejected);
        if (work is null || link is null)
            return Json(new { ok = false, message = "That link was not found. Reload the page and try again." }, 404);
        var result = await metadata.ChangeLinkAsync(new(work.Work.Id, link.Id, true, work.Work.Version), ct);
        if (result.Failure is { } failure)
            return Json(new { ok = false, message = failure.Message }, failure.Code == "not_found" ? 404 : 409);
        var response = await Links(workKey, h, metadata, ct);
        if (response is not IValueHttpResult { Value: { } value }) return response;
        var body = JsonSerializer.SerializeToNode(value, CatalogProjection.Json)!;
        body["ok"] = true;
        return Json(body);
    }

    private static async Task<IResult> Artwork(HttpContext h, IMetadata metadata, CancellationToken ct)
    {
        var art = new Dictionary<string, object>();
        JsonElement body;
        try { body = await JsonSerializer.DeserializeAsync<JsonElement>(h.Request.Body, cancellationToken: ct); }
        catch (JsonException) { return Json(new { artwork = art }); }
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
            return Json(new { artwork = art });
        var count = 0;
        foreach (var item in items.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || Text(item, "title")?.Trim() is not { Length: > 0 } title) continue;
            if (++count > 60) break;
            int? year = null;
            if (double.TryParse(Text(item, "year"), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var numeric) &&
                numeric == Math.Floor(numeric) && numeric is > 1800 and < 2200) year = (int)numeric;
            var kind = Text(item, "mediaType") is "tv" or "anime" ? WorkKind.Series : WorkKind.Film;
            var result = await metadata.ResolveAsync(new(null, title, year, kind), ct);
            var key = Regex.Replace(title.ToLowerInvariant(), @"[^a-z0-9]+", "-").Trim('-') + ":" + (year?.ToString() ?? "");
            art[key] = new { posterUrl = result.Work?.Work.PosterUrl, backdropUrl = result.Work?.Work.BackdropUrl };
        }
        return Json(new { artwork = art });
    }
    private static string? Text(JsonElement body, string key) => body.TryGetProperty(key, out var value) ?
        value.ValueKind == JsonValueKind.String ? value.GetString() : value.ValueKind == JsonValueKind.Number ? value.ToString() : null : null;

    private static async Task<IResult> Watchlist(HttpContext h, CatalogState state, IMetadata metadata, CancellationToken ct)
    {
        var rows = await state.ReadAsync<WatchItemRow>(CatalogState.Query(userId: ActorId(h)), ct);
        var items = new List<object>();
        foreach (var item in rows.OrderByDescending(w => w.UpdatedAt))
        {
            var w = (await metadata.GetWorkAsync(item.WorkId, false, ct)).Work;
            if (w is not null) items.Add(await WatchProjection(item, w, state, ct));
        }
        return Json(new { items });
    }
    private static async Task<IResult> SaveWatch(HttpContext h, CatalogState state, IMetadata metadata, CancellationToken ct)
    {
        JsonElement body;
        try { body = await JsonSerializer.DeserializeAsync<JsonElement>(h.Request.Body, cancellationToken: ct); }
        catch (JsonException) { return Json(new { error = "Send a valid watchlist item." }, 400); }
        if (body.ValueKind != JsonValueKind.Object) return Json(new { error = "Send a watchlist item." }, 400);
        var actor = ActorId(h);
        WatchItemRow? prior = null;
        WorkSnapshot? w;
        if (h.Request.Method == "PATCH")
        {
            prior = (await state.ReadAsync<WatchItemRow>(CatalogState.Query(id: Text(body, "id") ?? "", userId: actor), ct)).FirstOrDefault();
            if (prior is null) return Json(new { error = "Not found" }, 404);
            w = (await metadata.GetWorkAsync(prior.WorkId, false, ct)).Work;
        }
        else
        {
            var title = Text(body, "title");
            var type = Text(body, "mediaType");
            if (string.IsNullOrWhiteSpace(title) || title.Length > 500 || type is not ("movie" or "tv" or "anime" or "movies" or "series")
                || string.IsNullOrWhiteSpace(Text(body, "externalId")))
                return Json(new { error = "Provide a title, mediaType and externalId." }, 400);
            var key = Text(body, "workKey");
            w = key is null ? null : (await metadata.GetWorkAsync(key, false, ct)).Work;
            var provider = Text(body, "provider");
            var external = Text(body, "providerId") ?? Text(body, "externalId");
            if (w is not null && provider is not null && !w.Links.Any(l =>
                (l.Provider == provider || provider == "cinemeta" && l.Provider == "imdb") &&
                l.ExternalId == external && l.Status == LinkStatus.Verified))
                return Json(new { error = "That catalog entry belongs to a different title. Open the title again before saving it." }, 409);
            w ??= (await metadata.ResolveAsync(new(provider is null ? null :
                new(provider, Text(body, "providerId") ?? Text(body, "externalId")!,
                    provider == "tmdb" ? type is "tv" or "series" ? "tv" : "movie" : null),
                title, null, type is "tv" or "series" or "anime" ? WorkKind.Series : WorkKind.Film), ct)).Work;
        }
        if (w is null) return Json(new { error = "The catalog could not identify this title. Try again shortly." }, 502);
        WatchStatus? status = null;
        if (Text(body, "status") is { } raw)
        {
            if (raw is not ("watching" or "planned" or "completed" or "dropped") ||
                !Enum.TryParse<WatchStatus>(raw, true, out var parsed))
                return Json(new { error = "Pick watching, planned, completed or dropped." }, 400);
            status = parsed;
        }
        bool? monitored = null;
        if (body.TryGetProperty("monitored", out var monitor))
        {
            if (monitor.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Json(new { error = "monitored must be true or false." }, 400);
            monitored = monitor.GetBoolean();
        }
        var changeStart = Text(body, "fromSeason") is not null || Text(body, "fromEpisode") is not null;
        string? fromId = null;
        if (changeStart)
        {
            var follow = (await state.ReadAsync<FollowRow>(CatalogState.Query(workId: w.Work.Id), ct)).FirstOrDefault();
            var start = CatalogProjection.Coordinate(w, follow);
            var fromSeason = Number(Text(body, "fromSeason")) ?? start?.Season ?? 1;
            var fromEpisode = Number(Text(body, "fromEpisode")) ?? start?.Episode ?? 1;
            var selected = w.Seasons.FirstOrDefault(s => s.Number == fromSeason);
            fromId = w.Episodes.FirstOrDefault(e => e.SeasonId == selected?.Id && e.Number == fromEpisode)?.Id;
            if (fromId is null) return Json(new { error = "That episode is not in the catalog. Pick an existing season and episode." }, 400);
        }
        var mode = Text(body, "monitorMode");
        if (mode is not (null or "ongoing" or "new"))
            return Json(new { error = "Pick ongoing or new." }, 400);
        var changeResolution = body.TryGetProperty("preferredResolution", out var resolutionValue);
        var resolution = Number(Text(body, "preferredResolution"));
        if (changeResolution && resolutionValue.ValueKind != JsonValueKind.Null &&
            (resolutionValue.ValueKind != JsonValueKind.Number || !resolutionValue.TryGetInt32(out _) ||
                resolution is not (480 or 720 or 1080 or 2160)))
            return Json(new { error = "preferredResolution must be 480, 720, 1080 or 2160." }, 400);
        prior ??= (await state.ReadAsync<WatchItemRow>(CatalogState.Query(workId: w.Work.Id, userId: actor), ct)).FirstOrDefault();
        var item = await state.SaveAsync(actor, w.Work.Id, status, monitored, fromId, changeStart, mode,
            resolution, changeResolution, ct);
        return item is null ? Json(new { error = "The item changed. Try saving again." }, 409) :
            Json(new { item = await WatchProjection(item, w, state, ct), existed = prior is not null });
    }
    private static async Task<object> WatchProjection(WatchItemRow item, WorkSnapshot w, CatalogState state, CancellationToken ct) =>
        CatalogProjection.Watch(item, w, !(await state.OwnedAsync(w.Work.Id, ct)).IsEmpty,
            (await state.ReadAsync<FollowRow>(CatalogState.Query(workId: w.Work.Id), ct)).FirstOrDefault(),
            (await state.ReadAsync<WorkPreferenceRow>(CatalogState.Query(workId: w.Work.Id), ct)).FirstOrDefault());
    private static async Task<IResult> RemoveWatch(HttpContext h, CatalogState state, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(Param(h, "id"))) return Json(new { error = "Provide the item's id." }, 400);
        return await state.RemoveAsync(ActorId(h), Param(h, "id")!, ct) ? Json(new { ok = true }) :
            Json(new { error = "The item changed. Try removing it again." }, 409);
    }
}
