using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Requests;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal static class CatalogEndpoints
{
    internal static void AddCatalog(this IServiceCollection services) =>
        services.AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider());
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
        app.MapGet("/api/title/{workKey}/progress", async (string workKey, TorrentFlowDbContext db,
            TargetPipeline pipeline, CancellationToken ct) =>
        {
            var workId = await db.Works.AsNoTracking().Where(work => work.WorkKey == workKey)
                .Select(work => work.Id).FirstOrDefaultAsync(ct);
            var progress = string.IsNullOrEmpty(workId) ? null :
                await TitleTransfers.ReadAsync(workId, pipeline, db, ct);
            return Json(new
            {
                workKey, transfer = progress?.Film,
                seasonTransfers = progress?.Seasons ?? new Dictionary<string, TitleTransfer>(),
                episodeTransfers = progress?.Episodes ?? new Dictionary<string, TitleTransfer>(),
                generatedAt = DateTimeOffset.UtcNow,
            });
        });
        app.MapGet("/api/watchlist", LibraryEndpoints.List);
        app.MapWatchLater();
        app.MapPost("/api/watchlist", SaveWatch);
        app.MapPatch("/api/watchlist", SaveWatch);
        app.MapDelete("/api/watchlist", RemoveWatch);
    }

    private static async Task<IResult> Search(HttpContext h, TorrentFlowDbContext db, IMetadata metadata, CancellationToken ct)
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
        var works = result.Works.Where(w => category == "all" || category == "anime" && w.Work.Anime == true ||
                category != "anime" && w.Work.Anime != true).ToArray();
        var actions = await CardAction.ResolveAsync(db, works, ActorId(h), CanDownload(h), ct);
        return Json(new { results = works.Select(w => CatalogProjection.Hit(w, actions[w.Work.Id])), query = q,
            canonicalQuery = Regex.Replace(q, @"\s+", " ").ToLowerInvariant(), category,
            result.Partial, result.FailedProviders, result.Stale });
    }

    private static async Task<IResult> Suggest(HttpContext h, TorrentFlowDbContext db, IMetadata metadata, CancellationToken ct)
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
        var actions = await CardAction.ResolveAsync(db, result.Works, ActorId(h), CanDownload(h), ct);
        return Json(new { suggestions = result.Works.Select(w => new
        {
            title = CatalogProjection.Title(w), w.Work.Year, mediaType = CatalogProjection.Type(w),
            w.Work.PosterUrl, w.Work.WorkKey, provider = CatalogProjection.Provider(w),
            providerId = CatalogProjection.Primary(w)?.ExternalId, href = CatalogProjection.Href(w),
            action = actions[w.Work.Id],
            aliases = CatalogProjection.Aliases(w), source = CatalogProjection.Provider(w),
            externalId = CatalogProjection.Primary(w)?.ExternalId,
        }), query = q, canonicalQuery = q.ToLowerInvariant(), result.Partial, result.FailedProviders });
    }

    private static async Task<IResult> Browse(HttpContext h, TorrentFlowDbContext db, IMetadata metadata, CancellationToken ct)
    {
        var type = Param(h, "type") ?? "all";
        var genre = Param(h, "genre");
        var genres = Genres(type);
        if (type is not ("all" or "films" or "series" or "anime") ||
            genre is { Length: > 0 } && !genres.Any(g => g.Id == genre))
            return Json(new { error = "Home does not have that category. Pick one from the list above." }, 400);
        var result = await metadata.BrowseAsync(new(type, genre, ActorId(h)), ct);
        var actions = await CardAction.ResolveAsync(db, result.Rails.SelectMany(r => r.Works), ActorId(h), CanDownload(h), ct);
        var rails = result.Rails.Select(r => new
        {
            r.Id, r.Title, items = r.Works.Select(w => CatalogProjection.Card(w, actions[w.Work.Id], r.Id == "films-cinemas")),
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

    private static async Task<IResult> Recommend(HttpContext h, TorrentFlowDbContext db, IMetadata metadata, CancellationToken ct)
    {
        var actor = ActorId(h);
        var seedWatch = await db.WatchItems.AsNoTracking()
            .Where(w => w.UserId == actor && w.Status == WatchStatus.Watching)
            .OrderByDescending(w => w.UpdatedAt).ThenBy(w => w.Id)
            .FirstOrDefaultAsync(ct);
        var seeds = seedWatch is null ? ImmutableArray<string>.Empty : ImmutableArray.Create(seedWatch.WorkId);
        var rail = await metadata.RecommendAsync(seeds, ct);
        var seed = seedWatch is null ? null : (await metadata.GetWorkAsync(seedWatch.WorkId, false, ct)).Work;
        var actions = await CardAction.ResolveAsync(db, rail?.Works ?? [], actor, CanDownload(h), ct);
        return Json(new { rail = rail is null ? null : new
        {
            seedTitle = seed is null ? rail.Title : CatalogProjection.Title(seed),
            items = rail.Works.Select(w => new
            {
                workKey = w.Work.WorkKey,
                provider = CatalogProjection.Provider(w), sourceMediaType = CatalogProjection.Type(w),
                mediaType = CatalogProjection.TitleType(w), titleMediaType = CatalogProjection.TitleType(w),
                externalId = CatalogProjection.Primary(w)?.ExternalId, title = CatalogProjection.Title(w),
                w.Work.PosterUrl, w.Work.BackdropUrl, w.Work.Year, w.Work.Rating, format = CatalogProjection.Format(w),
                isSeries = CatalogProjection.Series(w), href = CatalogProjection.Href(w),
                action = actions[w.Work.Id],
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
        TorrentFlowDbContext db, ILibraryPlacement library, TargetPipeline pipeline, CancellationToken ct)
    {
        var provider = Param(h, "provider");
        var external = Param(h, "providerId") ?? Param(h, "externalId");
        if (provider is { Length: > 0 } && provider is not ("tmdb" or "anilist" or "cinemeta" or "tvmaze" or "itunes"))
            return Json(new { error = "Unsupported title provider" }, 400);
        if (external is { Length: > 0 } && string.IsNullOrWhiteSpace(provider))
            return Json(new { error = "A supported title provider is required." }, 400);
        var result = await Resolve(workKey, h, metadata, ct);
        if (result.Work is not { } w) return UnknownTitle(workKey, h, result.Failure);
        var season = Season(w, h);
        var actor = ActorId(h);
        var watch = await db.WatchItems.AsNoTracking().SingleOrDefaultAsync(i => i.WorkId == w.Work.Id && i.UserId == actor, ct);
        var follow = await db.Follows.AsNoTracking().SingleOrDefaultAsync(f => f.WorkId == w.Work.Id, ct);
        var coordinate = CatalogProjection.Coordinate(w, follow);
        var transfers = await TitleTransfers.ReadAsync(w.Work.Id, pipeline, db, ct);
        var ownedItems = await library.OwnedAsync(new(w.Work.Id, [], false), ct);
        var owned = ownedItems.SelectMany(i => i.Videos).ToImmutableArray();
        watch ??= owned.IsEmpty ? null : LibraryRead.OwnedItem(actor, w.Work.Id, owned);
        var jellyfinRead = await JellyfinEndpoints.ReadTitle(h, db, w, owned, ct);
        var jellyfin = jellyfinRead.State;
        var episodes = w.Episodes.Where(e => e.MappingStatus != MappingStatus.Unavailable &&
            w.Seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.Number == season).ToArray();
        int? Id(string provider) => Number(w.Links.FirstOrDefault(l => l.Provider == provider && l.Status == LinkStatus.Verified)?.ExternalId);
        return JellyfinEndpoints.TitleJson(new
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
            owned = Owned(owned, null),
            downloadFraction = (double?)null, transfer = transfers.Film,
            watchState = jellyfin?.Film,
            jellyfinNextUp = jellyfin?.NextUp is { } next ? new
            {
                next.EpisodeId, next.Season, next.Episode,
                jellyfinItemId = jellyfin.EpisodeItemIds?.GetValueOrDefault(next.EpisodeId),
            } : null,
            jellyfin = jellyfinRead.Playback,
            seasons = CatalogProjection.TitleSeasons(w).Select(s => new
            {
                season = s.Number, knownEpisodes = s.ExpectedEpisodeCount ?? w.Episodes.Count(e => e.SeasonId == s.Id),
                pack = (object?)null, transfer = transfers.Seasons.GetValueOrDefault(
                    s.Number.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                downloadedEpisodes = w.Episodes.Count(e => e.SeasonId == s.Id && owned.Any(f => f.EpisodeId == e.Id)),
                downloadingEpisodes = 0,
            }), season,
            episodes = episodes.Take(200).Select(e => new
            {
                season, episode = e.Number, label = $"S{season:00}E{e.Number:00}",
                availability = owned.Any(f => f.EpisodeId == e.Id) ? "ready" : null, owned = Owned(owned, e.Id),
                infoHash = (string?)null, filePath = (string?)null, downloadFraction = (double?)null,
                nextUp = false, fromPack = false,
                transfer = transfers.Episodes.GetValueOrDefault($"S{season:00}E{e.Number:00}"),
                watchState = jellyfin?.Episodes.GetValueOrDefault(e.Id),
                jellyfinItemId = jellyfin?.EpisodeItemIds?.GetValueOrDefault(e.Id),
            }), episodesTruncated = episodes.Length > 200,
            library = new
            {
                inLibrary = watch is not null, watchListItemId = watch?.Id, monitored = follow?.Enabled ?? false,
                status = watch?.Status.ToString().ToLowerInvariant(), cursorSeason = coordinate?.Season, cursorEpisode = coordinate?.Episode,
                addPayload = CatalogProjection.AddPayload(w, workKey),
            }, known = true, generatedAt = DateTimeOffset.UtcNow,
        });
    }
    // An item is owned when a MediaFile is present for it, whatever its origin; the resolution is the best owned file's.
    private static object? Owned(ImmutableArray<MediaFileRow> files, string? episodeId)
    {
        var mine = files.Where(f => f.EpisodeId == episodeId).ToArray();
        return mine.Length == 0 ? null : new { resolution = mine.Max(f => f.Resolution) };
    }

    private static IResult UnknownTitle(string workKey, HttpContext h, Failure? failure)
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
            }, known = false, failure = failure is null ? null : new { failure.Code, failure.Message },
            generatedAt = DateTimeOffset.UtcNow,
        });
    }

    private static async Task<IResult> Extras(string workKey, HttpContext h, TorrentFlowDbContext db, IMetadata metadata, CancellationToken ct)
    {
        var result = await Resolve(workKey, h, metadata, ct);
        var w = result.Work;
        var season = w is null ? Number(Param(h, "s")) : Season(w, h);
        var link = w is null ? null : CatalogProjection.Primary(w);
        var extras = w is null ? null : await metadata.ExtrasAsync(new(link is null ? null :
            new(link.Provider, link.ExternalId, link.ProviderKind), CatalogProjection.Title(w), w.Work.Year, w.Work.Kind), season, ct);
        w = extras?.Work ?? w;
        var similarWorks = extras?.Similar ?? [];
        var relatedWorks = similarWorks.AsEnumerable();
        if (extras?.PartOf is { } partOf) relatedWorks = relatedWorks.Append(partOf);
        var actions = await CardAction.ResolveAsync(db, relatedWorks, ActorId(h), CanDownload(h), ct);
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
            moreLikeThis = similarWorks.Select(item => Similar(item, actions[item.Work.Id])).ToArray(),
            partOf = extras?.PartOf is { } parent ? Similar(parent, actions[parent.Work.Id]) : null,
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
    private static object Similar(WorkSnapshot w, CatalogCardAction action) => new
    {
        w.Work.WorkKey, href = CatalogProjection.Href(w), title = CatalogProjection.Title(w),
        w.Work.Year, mediaType = CatalogProjection.TitleType(w), w.Work.PosterUrl, w.Work.Rating,
        action,
    };

    private static bool CanDownload(HttpContext http) => AccessIdentity.Role(http) != "requester";

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

    private static async Task<IResult> SaveWatch(HttpContext h, TorrentFlowDbContext db, IMetadata metadata,
        ILibraryRepository inventory, ILibraryPlacement library, Hunter hunter,
        ILoggerFactory loggerFactory, CancellationToken ct)
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
            var id = Text(body, "id");
            // Saved-for-later rows are hidden from the library list but still editable by their own id.
            prior = (await LibraryRead.ItemsAsync(actor,
                [.. await LibraryEndpoints.VisibleIntentAsync(db, actor, ct)],
                await db.Targets.AsNoTracking().ToListAsync(ct),
                inventory, library, ct)).FirstOrDefault(i => i.Id == id) ??
                await db.WatchItems.AsNoTracking().SingleOrDefaultAsync(i => i.Id == id && i.UserId == actor, ct);
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
        var workId = w.Work.Id;
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
            var follow = await db.Follows.AsNoTracking().SingleOrDefaultAsync(f => f.WorkId == workId, ct);
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
        prior ??= await db.WatchItems.AsNoTracking().SingleOrDefaultAsync(i => i.WorkId == workId && i.UserId == actor, ct);
        var followBefore = await db.Follows.AsNoTracking().SingleOrDefaultAsync(f => f.WorkId == workId, ct);
        for (var retry = 0; retry < 6; retry++)
        {
            var now = DateTimeOffset.UtcNow;
            var current = await db.WatchItems.SingleOrDefaultAsync(i => i.WorkId == workId && i.UserId == actor, ct);
            var item = current is null
                ? new WatchItemRow { Id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(actor + ":" + workId))), UserId = actor, WorkId = workId, Status = status ?? WatchStatus.Planned, UpgradeWatch = false, CreatedAt = now, UpdatedAt = now, Version = 0 }
                : current with { Status = status ?? current.Status, UpdatedAt = now, Version = current.Version + 1 };
            if (current is null) db.WatchItems.Add(item);
            else db.Entry(current).CurrentValues.SetValues(item);
            if (monitored is not null || changeStart || mode is not null)
            {
                var follow = await db.Follows.SingleOrDefaultAsync(f => f.WorkId == workId, ct);
                var (start, since) = FollowPolicy.Configure(follow, fromId, changeStart, mode, now);
                if (follow is null)
                    db.Follows.Add(new FollowRow { Id = Guid.CreateVersion7().ToString(), WorkId = workId, Enabled = monitored ?? false, FromEpisodeId = start, NewEpisodesSince = since, LastMaterializedAt = null, CreatedAt = now, UpdatedAt = now, Version = 0 });
                else
                    db.Entry(follow).CurrentValues.SetValues(follow with { Enabled = monitored ?? follow.Enabled,
                        FromEpisodeId = start, NewEpisodesSince = since, UpdatedAt = now, Version = follow.Version + 1 });
            }
            if (changeResolution)
            {
                var preference = await db.WorkPreferences.SingleOrDefaultAsync(p => p.WorkId == workId, ct);
                if (preference is null)
                    db.WorkPreferences.Add(new WorkPreferenceRow { Id = Guid.CreateVersion7().ToString(), WorkId = workId, ResolutionFloor = resolution, PreferredResolution = resolution, MaxBytesPerItem = null, StorageRootOverrideId = null, UpdatedAt = now, Version = 0 });
                else
                    db.Entry(preference).CurrentValues.SetValues(preference with { ResolutionFloor = resolution,
                        PreferredResolution = resolution, UpdatedAt = now, Version = preference.Version + 1 });
            }
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || ex.InnerException is SqliteException { SqliteErrorCode: 19 })
            {
                db.ChangeTracker.Clear();
                continue;
            }
            var followAfter = await db.Follows.AsNoTracking().SingleOrDefaultAsync(f => f.WorkId == workId, ct);
            if (followAfter is { Enabled: true } && (followBefore is not { Enabled: true } ||
                followBefore.FromEpisodeId != followAfter.FromEpisodeId ||
                followBefore.NewEpisodesSince != followAfter.NewEpisodesSince))
            {
                var logger = loggerFactory.CreateLogger("TorrentFlow.Api.Catalog.CatalogEndpoints");
                _ = Task.Run(async () =>
                {
                    try { await hunter.RunAsync(CancellationToken.None); }
                    catch (Exception ex) { logger.LogWarning(ex, "The follow check failed after saving a library item."); }
                });
            }
            return Json(new { item = await WatchProjection(item, w, db, library, ct), existed = prior is not null });
        }
        return Json(new { error = "The item changed. Try saving again." }, 409);
    }
    internal static async Task<object> WatchProjection(WatchItemRow item, WorkSnapshot w, TorrentFlowDbContext db,
        ILibraryPlacement library, CancellationToken ct)
    {
        var owned = await library.OwnedAsync(new(w.Work.Id, [], w.Work.Kind == WorkKind.Film), ct);
        return CatalogProjection.Watch(item, w, !owned.IsEmpty,
            await db.Follows.AsNoTracking().SingleOrDefaultAsync(f => f.WorkId == w.Work.Id, ct),
            await db.WorkPreferences.AsNoTracking().SingleOrDefaultAsync(p => p.WorkId == w.Work.Id, ct),
            await db.Targets.AsNoTracking().Where(t => t.WorkId == w.Work.Id).ToListAsync(ct), owned);
    }
    private static async Task<IResult> RemoveWatch(HttpContext h, TorrentFlowDbContext db,
        ILibraryRepository inventory, ILibraryPlacement library, TargetPipeline targets,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(Param(h, "id"))) return Json(new { error = "Provide the item's id." }, 400);
        var actor = ActorId(h);
        var id = Param(h, "id")!;
        var visible = await LibraryRead.ItemsAsync(actor,
            [.. await LibraryEndpoints.VisibleIntentAsync(db, actor, ct)],
            await db.Targets.AsNoTracking().ToListAsync(ct),
            inventory, library, ct);
        // A saved-for-later row is not in the library list, but its work can still own files there,
        // so it resolves to that work's library item and the file check below still applies.
        var savedWorkId = await db.WatchItems.AsNoTracking().Where(i => i.Id == id && i.UserId == actor)
            .Select(i => i.WorkId).SingleOrDefaultAsync(ct);
        var item = visible.FirstOrDefault(i => i.Id == id) ??
            (savedWorkId is null ? null : visible.FirstOrDefault(i => i.WorkId == savedWorkId));
        var scopeActionNeeded = false;
        if (item is not null && !(await inventory.MediaAsync(item.WorkId, ct)).IsEmpty)
        {
            if (AccessIdentity.Actor(h).Role != UserRole.Owner)
                return Json(new { error = "Only the owner can remove files from the library." }, 403);
            if (!bool.TryParse(Param(h, "confirm"), out var confirmed) || !confirmed)
                return Json(new { error = "This title has files. Review and confirm their deletion before removing it.",
                    requiresFileDeletion = true }, 409);
            var preview = LibraryRemoval.Preview(new("show", null, null), item.WorkId, [],
                await db.Targets.AsNoTracking().Where(t => t.WorkId == item.WorkId).OrderBy(t => t.Id).ToListAsync(ct),
                await db.DownloadTargets.AsNoTracking().OrderBy(l => l.Id).ToListAsync(ct),
                await db.Downloads.AsNoTracking().OrderBy(d => d.Id).ToListAsync(ct),
                await inventory.BindingsAsync(ct), await inventory.MediaAsync(item.WorkId, ct));
            LibraryDeleteResult deleted;
            try
            {
                deleted = await targets.DeleteLibraryAsync(preview, ct,
                    bool.TryParse(Param(h, "deleteAnyway"), out var anyway) && anyway);
            }
            catch (JellyfinDeleteRefusedException ex)
            {
                return Json(new { error = "Refused", message = ex.Message, reason = ex.Reason }, 409);
            }
            if (!deleted.Ok) return Json(deleted, 409);
            scopeActionNeeded = true;
        }
        // Turn the follow off before removing downloads so a concurrent Hunter pass cannot queue new ones.
        if (!await RemoveWatchAsync(db, actor, Param(h, "id")!, ct, item?.WorkId))
            return Json(new { error = "The item changed. Try removing it again." }, 409);
        if (item is not null && (scopeActionNeeded ||
            await db.Targets.AsNoTracking().AnyAsync(t => t.WorkId == item.WorkId &&
                t.State != TargetState.Removed && t.State != TargetState.Done, ct)))
        {
            var workKey = await db.Works.AsNoTracking().Where(x => x.Id == item.WorkId)
                .Select(x => x.WorkKey).SingleAsync(ct);
            await targets.ScopeActionAsync(workKey, null, null, TargetAction.Remove, ct);
        }
        return Json(new { ok = true });
    }
    internal static async Task<bool> RemoveWatchAsync(TorrentFlowDbContext db, string actor, string id,
        CancellationToken ct, string? validatedWorkId = null)
    {
        for (var retry = 0; retry < 6; retry++)
        {
            var item = await db.WatchItems.SingleOrDefaultAsync(i => i.Id == id && i.UserId == actor, ct);
            var workId = item?.WorkId ?? validatedWorkId;
            if (workId is null) return true;
            var follow = await db.Follows.SingleOrDefaultAsync(f => f.WorkId == workId, ct);
            if (follow is not null)
                db.Entry(follow).CurrentValues.SetValues(follow with
                    { Enabled = false, UpdatedAt = DateTimeOffset.UtcNow, Version = follow.Version + 1 });
            // A synthetic library item can sit over a hidden planned row; removing the title clears both.
            db.WatchItems.RemoveRange(await db.WatchItems
                .Where(i => i.UserId == actor && (i.Id == id || i.WorkId == workId)).ToListAsync(ct));
            try
            {
                await db.SaveChangesAsync(ct);
                return true;
            }
            catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || ex.InnerException is SqliteException { SqliteErrorCode: 19 })
            {
                db.ChangeTracker.Clear();
            }
        }
        return false;
    }
}
