using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal sealed class JellyfinSuggestionService(JellyfinClient client, string dataDirectory)
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<string, CachedSuggestions> cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);

    internal async Task<object> ReadAsync(TorrentFlowDbContext db, string userId, bool owner,
        CancellationToken ct)
    {
        JellyfinSettings settings;
        try
        {
            var row = await db.Settings.AsNoTracking().SingleOrDefaultAsync(setting => setting.Id == "jellyfin", ct);
            if (row is null) return Unavailable();
            settings = SettingsCatalog.Read<JellyfinSettings>(row);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return Unavailable();
        }

        var jellyfinUserId = settings.UserMappings.FirstOrDefault(mapping =>
            string.Equals(mapping.TorrentFlowUserId, userId, StringComparison.Ordinal))?.JellyfinUserId;
        if (string.IsNullOrWhiteSpace(jellyfinUserId) && owner) jellyfinUserId = settings.UserId;
        if (settings.ServerUrl is null || settings.Credential is null ||
            string.IsNullOrWhiteSpace(jellyfinUserId) || settings.SuggestNextEpisodes == 0)
            return Unavailable();

        string? token;
        try { token = SecretFiles.Read(dataDirectory, settings.Credential); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        { return Unavailable(); }
        if (string.IsNullOrWhiteSpace(token)) return Unavailable();

        var cacheKey = CacheKey(settings, jellyfinUserId, userId, owner);
        if (TryReadCache(cacheKey, out var cached)) return Response(cached);
        var gate = gates.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(1500));
        var locked = false;
        try
        {
            await gate.WaitAsync(deadline.Token);
            locked = true;
            if (TryReadCache(cacheKey, out cached)) return Response(cached);
            try
            {
                var items = await BuildAsync(db, settings, token, jellyfinUserId, userId,
                    settings.SuggestNextEpisodes, owner, deadline.Token);
                cache[cacheKey] = new CachedSuggestions(items, DateTimeOffset.UtcNow.Add(CacheDuration));
                return Response(items);
            }
            catch (Exception ex) when (ex is JellyfinException or OperationCanceledException or JsonException or ArgumentException or InvalidOperationException)
            {
                if (ct.IsCancellationRequested) throw;
                return Unavailable();
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return Unavailable(); }
        finally { if (locked) gate.Release(); }
    }

    internal async Task<IResult> DismissAsync(TorrentFlowDbContext db, string userId, JsonElement body,
        CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object ||
            !body.TryGetProperty("workKey", out var keyValue) || keyValue.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(keyValue.GetString()) ||
            !body.TryGetProperty("season", out var seasonValue) || !seasonValue.TryGetInt32(out var season) || season < 1 ||
            !body.TryGetProperty("episode", out var episodeValue) || !episodeValue.TryGetInt32(out var episode) || episode < 1)
            return Results.BadRequest(new { message = "Provide a work key, season and episode." });

        var work = await db.Works.AsNoTracking().Where(item => item.WorkKey == keyValue.GetString())
            .Select(item => new { item.Id, item.Kind }).SingleOrDefaultAsync(ct);
        if (work is null || work.Kind != WorkKind.Series)
            return Results.NotFound(new { message = "That series is not in the catalog." });
        var exists = await (from seasonRow in db.Seasons.AsNoTracking()
                            join episodeRow in db.Episodes.AsNoTracking() on seasonRow.Id equals episodeRow.SeasonId
                            where seasonRow.WorkId == work.Id && seasonRow.Number == season && episodeRow.Number == episode
                            select episodeRow.Id).AnyAsync(ct);
        if (!exists) return Results.NotFound(new { message = "That episode is not in the catalog." });

        var row = await db.JellyfinSuggestionDismissals.SingleOrDefaultAsync(item =>
            item.UserId == userId && item.WorkId == work.Id && item.Season == season && item.Episode == episode, ct);
        if (row is null)
            db.JellyfinSuggestionDismissals.Add(new JellyfinSuggestionDismissalRow
            {
                UserId = userId,
                WorkId = work.Id,
                Season = season,
                Episode = episode,
                DismissedAt = DateTimeOffset.UtcNow,
            });
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            if (!await db.JellyfinSuggestionDismissals.AsNoTracking().AnyAsync(item =>
                item.UserId == userId && item.WorkId == work.Id && item.Season == season && item.Episode == episode, ct))
                throw;
        }

        InvalidateUser(userId);
        return Results.Ok(new { ok = true });
    }

    internal void InvalidateUser(string userId)
    {
        foreach (var key in cache.Keys.Where(key => key.StartsWith(userId + "|", StringComparison.Ordinal)))
            cache.TryRemove(key, out _);
    }

    private async Task<object[]> BuildAsync(TorrentFlowDbContext db, JellyfinSettings settings, string token,
        string jellyfinUserId, string torrentFlowUserId, int suggestionCount, bool isOwner, CancellationToken ct)
    {
        var server = JellyfinWatchState.ValidateUrl(settings.ServerUrl);
        var played = new List<JellyfinItemDto>();
        var start = 0;
        JellyfinItemsResult page;
        var cutoff = DateTimeOffset.UtcNow.AddDays(-30);
        do
        {
            page = await client.GetItems(server, token, new JellyfinItemQuery
            {
                UserId = jellyfinUserId,
                Recursive = true,
                IncludeItemTypes = ["Episode"],
                Filters = ["IsPlayed"],
                SortBy = ["DatePlayed"],
                SortOrder = ["Descending"],
                Fields = ["ProviderIds", "Path", "SeriesId", "UserData"],
                EnableUserData = true,
                Limit = 500,
                StartIndex = start,
            }, ct);
            var pageItems = page.Items.Where(item => item.UserData?.Played == true).ToArray();
            played.AddRange(pageItems.Where(item => item.UserData?.LastPlayedDate >= cutoff));
            start += page.Items.Length;
            if (pageItems.Length > 0 && pageItems.All(item => item.UserData?.LastPlayedDate < cutoff))
                break;
            if (page.Items.IsEmpty && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin returned an incomplete played-episode list.");
            if (start >= 100000 && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin returned too many played episodes to read safely.");
        } while (page.Items.Length > 0 && start < page.TotalRecordCount);

        var nextUp = await client.GetNextUp(server, token, jellyfinUserId, 1000,
            fields: ["ProviderIds", "Path", "SeriesId", "UserData"], ct: ct);
        var seriesIds = played.Select(item => item.SeriesId)
            .Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id!)
            .Distinct(StringComparer.Ordinal).ToArray();
        if (played.Count == 0) return [];

        var seriesItems = seriesIds.Length == 0 ? [] : (await client.GetItems(server, token, new JellyfinItemQuery
        {
            UserId = jellyfinUserId,
            Ids = [.. seriesIds],
            Fields = ["ProviderIds", "Path"],
            EnableUserData = true,
        }, ct)).Items;

        var works = await db.Works.AsNoTracking().Where(work => work.Kind == WorkKind.Series).ToArrayAsync(ct);
        var links = await db.WorkLinks.AsNoTracking().Where(link => link.Status == LinkStatus.Verified)
            .ToArrayAsync(ct);
        var names = await db.WorkNames.AsNoTracking().ToArrayAsync(ct);
        var seasons = await db.Seasons.AsNoTracking().ToArrayAsync(ct);
        var episodes = await db.Episodes.AsNoTracking().ToArrayAsync(ct);
        var mediaFiles = await db.MediaFiles.AsNoTracking().Where(file => file.Role == FileRole.Video)
            .ToArrayAsync(ct);
        var targets = await db.Targets.AsNoTracking().Where(target =>
            target.State != TargetState.Done && target.State != TargetState.Removed).ToArrayAsync(ct);
        var dismissed = await db.JellyfinSuggestionDismissals.AsNoTracking()
            .Where(item => item.UserId == torrentFlowUserId).ToArrayAsync(ct);
        var mapper = new JellyfinPathMapper(settings.PathMappings);
        var workById = works.ToDictionary(work => work.Id, StringComparer.Ordinal);
        var seasonsByWork = seasons.Where(season => workById.ContainsKey(season.WorkId))
            .GroupBy(season => season.WorkId).ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        var episodesByWork = episodes.GroupBy(episode => seasons.FirstOrDefault(season => season.Id == episode.SeasonId)?.WorkId)
            .Where(group => group.Key is not null).ToDictionary(group => group.Key!, group => group.ToArray(), StringComparer.Ordinal);
        var linksByWork = links.GroupBy(link => link.WorkId).ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        var namesByWork = names.GroupBy(name => name.WorkId).ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        var mapperWork = new Dictionary<string, string>(StringComparer.Ordinal);
        var ambiguousSeriesIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var series in seriesItems)
        {
            if (series.Id is null) continue;
            var matches = MatchProviderWorks(series.ProviderIds, links, works);
            if (matches.Length == 1) mapperWork[series.Id] = matches[0];
            else if (matches.Length > 1) ambiguousSeriesIds.Add(series.Id);
            else if (matches.Length == 0 && series.Path is not null)
            {
                var local = mapper.ToLocal(series.Path);
                var pathMatches = mediaFiles.Where(file => local is not null && JellyfinPathMapper.PathsEqual(file.Path, local))
                    .Select(file => file.WorkId).Distinct(StringComparer.Ordinal).ToArray();
                if (pathMatches.Length == 1) mapperWork[series.Id] = pathMatches[0];
            }
        }

        var furthest = new Dictionary<string, EpisodeFrontier>(StringComparer.Ordinal);
        foreach (var watched in played)
        {
            var workId = watched.SeriesId is not null ? mapperWork.GetValueOrDefault(watched.SeriesId) : null;
            EpisodeRow? episode = null;
            if (workId is not null && watched.ParentIndexNumber is { } seasonNumber &&
                watched.IndexNumber is { } episodeNumber && seasonsByWork.TryGetValue(workId, out var workSeasons))
            {
                var season = workSeasons.FirstOrDefault(item => item.Number == seasonNumber);
                episode = episodes.FirstOrDefault(item => item.SeasonId == season?.Id && item.Number == episodeNumber);
            }

            if (episode is null && watched.Path is not null &&
                (watched.SeriesId is null || !ambiguousSeriesIds.Contains(watched.SeriesId)))
            {
                var local = mapper.ToLocal(watched.Path);
                var pathRows = mediaFiles.Where(file => file.EpisodeId is not null && local is not null &&
                    JellyfinPathMapper.PathsEqual(file.Path, local)).ToArray();
                var episodeIds = pathRows.Select(file => file.EpisodeId).Distinct(StringComparer.Ordinal).ToArray();
                if (episodeIds.Length == 1)
                {
                    var pathWorkId = pathRows.Select(file => file.WorkId).Distinct(StringComparer.Ordinal).ToArray();
                    if (pathWorkId.Length == 1 && (workId is null || workId == pathWorkId[0]))
                    {
                        episode = episodes.FirstOrDefault(item => item.Id == episodeIds[0]);
                        workId = pathWorkId[0];
                        if (watched.SeriesId is not null) mapperWork[watched.SeriesId] = workId;
                    }
                }
            }

            if (workId is null || episode is null || !seasonsByWork.TryGetValue(workId, out var matchingSeasons))
                continue;
            var matchedSeason = matchingSeasons.FirstOrDefault(item => item.Id == episode.SeasonId);
            if (matchedSeason is null || matchedSeason.Number < 1) continue;
            var frontier = new EpisodeFrontier(matchedSeason.Number, episode.Number);
            if (!furthest.TryGetValue(workId, out var prior) || frontier.CompareTo(prior) > 0)
                furthest[workId] = frontier;
        }

        if (furthest.Count == 0) return [];
        var jfEpisodesBySeries = new Dictionary<string, JellyfinItemDto[]>(StringComparer.Ordinal);
        var seriesReads = mapperWork.Where(pair => furthest.ContainsKey(pair.Value))
            .Select(async pair => (pair.Key, Items: await ReadSeriesEpisodesAsync(server, token, jellyfinUserId, pair.Key, ct)))
            .ToArray();
        foreach (var (seriesId, seriesEpisodes) in await Task.WhenAll(seriesReads))
        {
            jfEpisodesBySeries[seriesId] = seriesEpisodes;
        }

        var owned = mediaFiles.Where(file => file.Status is FilePresence.Present or FilePresence.Offline)
            .Select(file => (file.WorkId, file.EpisodeId)).ToHashSet();
        var queued = targets.Select(target => (target.WorkId, target.EpisodeId)).ToHashSet();
        var dismissedKeys = dismissed.Select(item => (item.WorkId, item.Season, item.Episode)).ToHashSet();
        var now = DateTimeOffset.UtcNow;
        var suggestions = new List<object>();
        foreach (var (workId, frontier) in furthest.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!workById.TryGetValue(workId, out var work) ||
                !seasonsByWork.TryGetValue(workId, out var workSeasons) ||
                !episodesByWork.TryGetValue(workId, out var workEpisodes)) continue;
            var window = workEpisodes.Select(episode =>
                (Episode: episode, Season: workSeasons.FirstOrDefault(season => season.Id == episode.SeasonId)))
                .Where(pair => pair.Season is { Number: >= 1 } && pair.Episode.MappingStatus == MappingStatus.Confirmed &&
                    pair.Episode.AirAt is { } airAt && airAt <= now &&
                    new EpisodeFrontier(pair.Season.Number, pair.Episode.Number).CompareTo(frontier) > 0)
                .OrderBy(pair => pair.Season!.Number).ThenBy(pair => pair.Episode.Number)
                .Take(suggestionCount).ToArray();
            if (window.Length == 0) continue;

            var jellyfinEpisodes = jfEpisodesBySeries.Where(pair => mapperWork[pair.Key] == workId)
                .SelectMany(pair => pair.Value).Where(item =>
                    !string.Equals(item.LocationType, "Virtual", StringComparison.OrdinalIgnoreCase)).ToArray();
            var namesForWork = namesByWork.GetValueOrDefault(workId) ?? [];
            var title = namesForWork.FirstOrDefault(name => name.Label == NameLabel.English)?.Value
                ?? namesForWork.OrderBy(name => name.Ordinal).FirstOrDefault()?.Value ?? work.WorkKey;
            var requestLink = linksByWork.GetValueOrDefault(workId)?
                .Where(link => link.Status == LinkStatus.Verified && link.Provider is "tmdb" or "anilist" or "tvmaze" or "imdb")
                .OrderBy(link => link.Provider == "tmdb" ? 0 : link.Provider == "anilist" ? 1 : link.Provider == "tvmaze" ? 2 : 3)
                .FirstOrDefault();
            foreach (var pair in window)
            {
                var seasonNumber = pair.Season!.Number;
                var episodeNumber = pair.Episode.Number;
                if (owned.Contains((workId, pair.Episode.Id)) || queued.Contains((workId, pair.Episode.Id)) ||
                    dismissedKeys.Contains((workId, seasonNumber, episodeNumber)) ||
                    jellyfinEpisodes.Any(item => item.ParentIndexNumber == seasonNumber && item.IndexNumber == episodeNumber))
                    continue;

                object? action = null;
                if (isOwner)
                    action = new
                    {
                        kind = "download",
                        method = "POST",
                        url = "/api/title/" + Uri.EscapeDataString(work.WorkKey),
                        body = new { scope = "episode", season = seasonNumber, episode = episodeNumber },
                    };
                else if (requestLink is not null)
                    action = new
                    {
                        kind = "request",
                        method = "POST",
                        url = "/api/requester/requests",
                        body = new
                        {
                            provider = requestLink.Provider == "imdb" ? "cinemeta" : requestLink.Provider,
                            providerId = requestLink.ExternalId,
                            mediaType = work.Anime == true ? "anime" : "tv",
                            title,
                            year = work.Year,
                            posterUrl = work.PosterUrl,
                            scope = "seasons",
                            seasons = new[] { seasonNumber },
                        },
                    };
                suggestions.Add(new
                {
                    workKey = work.WorkKey,
                    title,
                    posterUrl = work.PosterUrl,
                    season = seasonNumber,
                    episode = episodeNumber,
                    episodeId = pair.Episode.Id,
                    episodeTitle = pair.Episode.Title,
                    airDate = pair.Episode.AirAt?.ToString("yyyy-MM-dd"),
                    reason = $"You watched S{frontier.Season}E{frontier.Episode}",
                    action,
                });
            }
        }
        return [.. suggestions];
    }

    private static string[] MatchProviderWorks(Dictionary<string, string>? providerIds,
        WorkLinkRow[] links, WorkRow[] works)
    {
        if (providerIds is null || providerIds.Count == 0) return [];
        var matches = links.Where(link => link.Provider is "tmdb" or "tvdb" or "imdb" &&
            providerIds.Any(pair => pair.Key.Equals(link.Provider, StringComparison.OrdinalIgnoreCase) &&
                pair.Value.Equals(link.ExternalId, StringComparison.OrdinalIgnoreCase)))
            .Select(link => link.WorkId).Where(id => works.Any(work => work.Id == id))
            .Distinct(StringComparer.Ordinal).ToArray();
        return matches;
    }

    private async Task<JellyfinItemDto[]> ReadSeriesEpisodesAsync(string server, string token,
        string jellyfinUserId, string seriesId, CancellationToken ct)
    {
        var items = new List<JellyfinItemDto>();
        var start = 0;
        JellyfinItemsResult page;
        do
        {
            page = await client.GetItems(server, token, new JellyfinItemQuery
            {
                UserId = jellyfinUserId,
                ParentId = seriesId,
                IncludeItemTypes = ["Episode"],
                Fields = ["ProviderIds", "Path", "SeriesId", "UserData"],
                EnableUserData = true,
                Limit = 1000,
                StartIndex = start,
            }, ct);
            items.AddRange(page.Items);
            start += page.Items.Length;
            if (page.Items.IsEmpty && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin returned an incomplete episode list.");
            if (start >= 100000 && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin returned too many episodes to read safely.");
        } while (page.Items.Length > 0 && start < page.TotalRecordCount);
        return [.. items];
    }

    private bool TryReadCache(string key, out object[]? items)
    {
        if (cache.TryGetValue(key, out var cached) && cached.ExpiresAt > DateTimeOffset.UtcNow)
        {
            items = cached.Items;
            return true;
        }
        cache.TryRemove(key, out _);
        items = null;
        return false;
    }

    private static string CacheKey(JellyfinSettings settings, string jellyfinUserId, string userId, bool owner) =>
        string.Join("|", userId, owner, settings.ServerUrl, settings.Credential?.FileId, settings.Credential?.Revision,
            jellyfinUserId, settings.SuggestNextEpisodes, string.Join(";", settings.PathMappings.Select(mapping => mapping.From + ">" + mapping.To)));

    private static object Response(object[]? items) => new { items = items ?? [] };
    private static object Unavailable() => new { items = Array.Empty<object>(), unavailable = true };
    private sealed record CachedSuggestions(object[] Items, DateTimeOffset ExpiresAt);
    private readonly record struct EpisodeFrontier(int Season, int Episode) : IComparable<EpisodeFrontier>
    {
        public int CompareTo(EpisodeFrontier other) =>
            Season != other.Season ? Season.CompareTo(other.Season) : Episode.CompareTo(other.Episode);
    }
}
