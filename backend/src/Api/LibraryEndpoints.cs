using System.Text.Json;
using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class LibraryEndpoints
{
    internal static async Task<IResult> List(HttpContext h, TorrentFlowDbContext db, IMetadata metadata,
        ILibraryRepository inventory, ILibraryPlacement library, CancellationToken ct)
    {
        var actor = AccessIdentity.UserId(h);
        var rows = await LibraryRead.ItemsAsync(actor,
            [.. await VisibleIntentAsync(db, actor, ct)],
            await db.Targets.AsNoTracking().ToListAsync(ct), inventory, library, ct);
        var works = new List<(WatchItemRow Item, WorkSnapshot Work)>();
        foreach (var item in rows)
            if ((await metadata.GetWorkAsync(item.WorkId, false, ct)).Work is { } work)
                works.Add((item, work));
        var watch = await JellyfinEndpoints.ReadLibrary(h, db,
            works.Select(w => w.Work), inventory, ct);
        var items = new System.Text.Json.Nodes.JsonArray();
        foreach (var (item, work) in works)
        {
            var node = JsonSerializer.SerializeToNode(
                await CatalogEndpoints.WatchProjection(item, work, db, library, ct),
                CatalogProjection.Json)!.AsObject();
            if (watch.States.GetValueOrDefault(work.Work.Id) is { } jellyfin)
            {
                if (jellyfin.Film is not null)
                    node["watchState"] = JsonSerializer.SerializeToNode(jellyfin.Film, CatalogProjection.Json);
                if (jellyfin.NextUp is not null)
                    node["jellyfinNextUp"] = JsonSerializer.SerializeToNode(jellyfin.NextUp, CatalogProjection.Json);
                var itemId = work.Work.Kind == WorkKind.Film ? jellyfin.FilmItemId : jellyfin.SeriesItemId;
                if (watch.PlayUrl(itemId) is { } playUrl)
                    node["jellyfin"] = JsonSerializer.SerializeToNode(new { itemId, playUrl }, CatalogProjection.Json);
            }
            items.Add(node);
        }
        return Results.Json(new { items }, CatalogProjection.Json);
    }

    // A planned row whose follow is off is hidden; the list and every lookup by id must agree on that.
    internal static Task<List<WatchItemRow>> VisibleIntentAsync(TorrentFlowDbContext db, string actor,
        CancellationToken ct) =>
        db.WatchItems.AsNoTracking().Where(item => item.UserId == actor &&
            (item.Status != WatchStatus.Planned ||
             db.Follows.AsNoTracking().Any(follow => follow.WorkId == item.WorkId && follow.Enabled)))
            .ToListAsync(ct);

    internal static void MapLibraryActions(this WebApplication app)
    {
        var group = app.MapGroup("/api/library").AddEndpointFilter(async (context, next) =>
        {
            if (AccessIdentity.Actor(context.HttpContext).Role != UserRole.Owner) return Results.StatusCode(403);
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or JsonException or BadHttpRequestException)
            { return Results.BadRequest(new { ok = false, error = ex.Message, message = ex.Message }); }
        });
        group.MapGet("/cleanup", Cleanup);
        group.MapMethods("/delete", ["GET", "POST"], Delete);
        group.MapPost("/ondemand", OnDemand);
        group.MapPost("/files/{mediaFileId}/find-another", FindAnother);
        group.MapPost("/files/{mediaFileId}/keep-new", KeepNew);
        group.MapPost("/files/{mediaFileId}/keep-both", KeepBoth);
    }

    private sealed record KeepNewInput(bool DeleteAnyway = false);

    private static async Task<IResult> FindAnother(string mediaFileId, HttpContext http,
        TargetPipeline targets, CancellationToken ct)
    {
        var targetId = await targets.FindAnotherForLibraryFileAsync(mediaFileId,
            AccessIdentity.UserId(http), ct);
        return targetId is null
            ? Results.NotFound(new { ok = false, error = "File not found." })
            : Results.Ok(new { ok = true, targetId });
    }

    private static async Task<IResult> KeepNew(string mediaFileId, HttpContext http,
        TorrentFlowDbContext db, ILibraryRepository library, TargetPipeline targets, CancellationToken ct)
    {
        var oldFile = await db.MediaFiles.AsNoTracking().SingleOrDefaultAsync(file =>
            file.Id == mediaFileId && file.Role == FileRole.Video &&
            file.Status == FilePresence.Present && file.MissingSince == null, ct);
        if (oldFile is null) return Results.NotFound(new { ok = false, error = "File not found." });

        var replacementTargets = await db.Targets.AsNoTracking().Where(target =>
            target.Kind == TargetKind.Replace && target.ReplaceMediaFileId == oldFile.Id).ToListAsync(ct);
        var targetIds = replacementTargets.Select(target => target.Id).ToArray();
        var replacementBindings = targetIds.Length == 0 ? [] :
            await db.DownloadFiles.AsNoTracking().Where(binding => targetIds.Contains(binding.TargetId) &&
                binding.Role == FileRole.Video && binding.Filed && binding.MediaFileId != null).ToListAsync(ct);
        var replacementMediaIds = replacementBindings.Select(binding => binding.MediaFileId!).ToArray();
        var replacementFiles = replacementMediaIds.Length == 0 ? [] :
            await db.MediaFiles.AsNoTracking().Where(file => replacementMediaIds.Contains(file.Id) &&
                file.Role == FileRole.Video && file.Status == FilePresence.Present &&
                file.MissingSince == null).ToListAsync(ct);
        var ready = replacementTargets.Where(target => target.State == TargetState.Done)
            .SelectMany(target => replacementBindings.Where(binding => binding.TargetId == target.Id)
                .Select(binding => (Target: target, File: replacementFiles.SingleOrDefault(file =>
                    file.Id == binding.MediaFileId))))
            .Where(item => item.File is not null)
            .OrderByDescending(item => item.Target.UpdatedAt).FirstOrDefault();
        if (ready.Target is null || ready.File is null)
            return Results.Json(new { ok = false, error = "The new copy isn't ready yet.",
                message = "The new copy isn't ready yet.", reason = "not-ready" }, statusCode: 409);

        var sourceBinding = (await library.BindingsAsync(ct))
            .FirstOrDefault(binding => binding.MediaFileId == oldFile.Id && binding.Role == FileRole.Video);
        var sourceTarget = sourceBinding?.TargetId is { } sourceTargetId
            ? await db.Targets.AsNoTracking().SingleOrDefaultAsync(target =>
                target.Id == sourceTargetId, ct) : null;
        var preview = LibraryRemoval.PreviewFile(oldFile, sourceTarget,
            [.. await db.DownloadTargets.AsNoTracking().ToListAsync(ct)],
            await library.DownloadsAsync(ct), await library.BindingsAsync(ct));
        if (preview.Plan.Outcome != "deletes")
            return Results.Json(new { ok = false, error = "Nothing to delete.",
                message = preview.Plan.Summary, reason = preview.Plan.Outcome }, statusCode: 409);

        KeepNewInput input;
        try
        {
            input = await http.Request.ReadFromJsonAsync<KeepNewInput>(ct) ?? new();
        }
        catch (JsonException ex)
        {
            return Results.BadRequest(new { ok = false, error = ex.Message });
        }
        LibraryDeleteResult result;
        try { result = await targets.DeleteLibraryAsync(preview, ct, input.DeleteAnyway); }
        catch (JellyfinDeleteRefusedException ex) { return DeleteRefusal(ex); }
        if (!result.Ok) return Results.Json(result, statusCode: 409);
        if (!await targets.ClearReplacementsAsync(oldFile.Id, ct))
            return Results.Json(new { ok = false, error = "The replacement changed while deleting the old file.",
                message = "The old file was deleted, but the replacement link changed. Refresh the title.",
                reason = "changed" }, statusCode: 409);
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> KeepBoth(string mediaFileId, TorrentFlowDbContext db,
        TargetPipeline targets, CancellationToken ct)
    {
        var exists = await db.MediaFiles.AsNoTracking().AnyAsync(file =>
            file.Id == mediaFileId && file.Role == FileRole.Video, ct);
        if (!exists) return Results.NotFound(new { ok = false, error = "File not found." });
        return await targets.ClearReplacementsAsync(mediaFileId, ct)
            ? Results.Ok(new { ok = true })
            : Results.Json(new { ok = false, error = "The replacement changed. Try again.",
                reason = "changed" }, statusCode: 409);
    }

    internal static IResult DeleteRefusal(JellyfinDeleteRefusedException ex) =>
        Results.Json(new { ok = false, error = "Refused", message = ex.Message, reason = ex.Reason },
            statusCode: 409);

    private sealed record CleanupRoot(string Id, string Label, bool Online);
    private sealed record CleanupSuggestion(string WorkId, string Title, int? Year, string Kind,
        string? Poster, object Watched, DateTimeOffset? LastPlayedAt, long Bytes, long WatchedBytes,
        ImmutableArray<CleanupRoot> Roots, bool Deletable, string[] WatchedEpisodeIds);
    private sealed record DeleteInput(string? WatchListItemId, string? Scope, int? Season, int? Episode,
        bool Confirm = false, string[]? EpisodeIds = null, string? WorkId = null, bool DeleteAnyway = false);

    private static async Task<IResult> Cleanup(HttpContext http, TorrentFlowDbContext db,
        ILibraryRepository inventory, IStorageStatus storage, IJellyfinPlaybackGuard playbackGuard,
        CancellationToken ct)
    {
        var playback = await playbackGuard.ReadAsync(ct);
        if (playback.Status == JellyfinPlaybackReadStatus.NotConfigured)
            return Results.Json(new { jellyfin = "off", isAdmin = false, needsAdmin = false,
                message = (string?)null, items = Array.Empty<CleanupSuggestion>() }, CatalogProjection.Json);
        if (playback.Status == JellyfinPlaybackReadStatus.NotAdmin)
            return Results.Json(new { jellyfin = "ok", isAdmin = false, needsAdmin = true,
                message = "Sign in with an admin account so TorrentFlow can see what everyone is watching.",
                items = Array.Empty<CleanupSuggestion>() }, CatalogProjection.Json);
        if (playback.Status != JellyfinPlaybackReadStatus.Available)
            return Results.Json(new { jellyfin = "unreachable", isAdmin = false, needsAdmin = false,
                message = "Couldn't check Jellyfin playback. Try again.",
                items = Array.Empty<CleanupSuggestion>() }, CatalogProjection.Json);

        var managed = (await inventory.MediaAsync(null, ct)).Where(file => file.RootId is not null).ToArray();
        var workIds = managed.Select(file => file.WorkId).Distinct(StringComparer.Ordinal).ToArray();
        List<WorkRow> works = workIds.Length == 0 ? [] :
            await db.Works.AsNoTracking().Where(work => workIds.Contains(work.Id)).ToListAsync(ct);
        List<WorkNameRow> names = workIds.Length == 0 ? [] :
            await db.WorkNames.AsNoTracking().Where(name => workIds.Contains(name.WorkId)).ToListAsync(ct);
        List<WorkLinkRow> links = workIds.Length == 0 ? [] :
            await db.WorkLinks.AsNoTracking().Where(link => workIds.Contains(link.WorkId)).ToListAsync(ct);
        List<SeasonRow> seasons = workIds.Length == 0 ? [] :
            await db.Seasons.AsNoTracking().Where(season => workIds.Contains(season.WorkId)).ToListAsync(ct);
        var seasonIds = seasons.Select(season => season.Id).ToArray();
        List<EpisodeRow> episodes = seasonIds.Length == 0 ? [] :
            await db.Episodes.AsNoTracking().Where(episode => seasonIds.Contains(episode.SeasonId)).ToListAsync(ct);
        var filesByWork = managed.ToLookup(file => file.WorkId, StringComparer.Ordinal);
        var namesByWork = names.OrderBy(name => name.Ordinal).ThenBy(name => name.Id)
            .ToLookup(name => name.WorkId, StringComparer.Ordinal);
        var seasonsByWork = seasons.ToLookup(season => season.WorkId, StringComparer.Ordinal);
        var episodesBySeason = episodes.ToLookup(episode => episode.SeasonId, StringComparer.Ordinal);
        var snapshots = works.Select(work => new WorkSnapshot(work,
            [.. namesByWork[work.Id]],
            [.. links.Where(link => link.WorkId == work.Id)],
            [.. seasonsByWork[work.Id]],
            [.. seasonsByWork[work.Id].SelectMany(season => episodesBySeason[season.Id])])).ToArray();
        var watch = await JellyfinEndpoints.ReadCleanup(http, db,
            snapshots.Select(work => (work, filesByWork[work.Work.Id].ToImmutableArray())), ct);
        if (watch.Status != "ok")
            return Results.Json(new { jellyfin = watch.Status, isAdmin = true, needsAdmin = false,
                message = "Couldn't check Jellyfin watch state. Try again.",
                items = Array.Empty<CleanupSuggestion>() },
                CatalogProjection.Json);

        var roots = await inventory.RootsAsync(ct);
        var rootsById = roots.ToDictionary(root => root.Id, StringComparer.Ordinal);
        var onlineById = new Dictionary<string, bool>(StringComparer.Ordinal);
        bool IsOnline(string id)
        {
            if (onlineById.TryGetValue(id, out var online)) return online;
            online = rootsById.TryGetValue(id, out var root) && storage.IsOnline(root.Path);
            onlineById[id] = online;
            return online;
        }

        var items = new List<(bool FullyWatched, CleanupSuggestion Item)>();
        foreach (var work in snapshots)
        {
            if (work.Work.Kind is not (WorkKind.Film or WorkKind.Series)) continue;
            var workFiles = filesByWork[work.Work.Id].ToArray();
            if (!watch.Items.TryGetValue(work.Work.Id, out var state)) continue;
            int played;
            int total;
            long watchedBytes;
            DateTimeOffset? lastPlayedAt;
            object watched;
            bool fullyWatched;
            string[] episodeIdsOnDisk;
            if (work.Work.Kind == WorkKind.Film)
            {
                if (state.Film?.Watched != true) continue;
                if (workFiles.Any(file => playback.PlayingPaths.Any(path =>
                        JellyfinPathMapper.PathsEqual(file.Path, path)))) continue;
                played = total = 1;
                watchedBytes = workFiles.Sum(file => file.Bytes);
                lastPlayedAt = state.Film.LastPlayedAt;
                watched = "movie";
                episodeIdsOnDisk = [];
                fullyWatched = true;
            }
            else
            {
                var watchedEpisodeIds = work.Episodes.Where(episode =>
                    state.Episodes.TryGetValue(episode.Id, out var progress) && progress.Watched &&
                    !workFiles.Where(file => file.EpisodeId == episode.Id).Any(file =>
                        playback.PlayingPaths.Any(path => JellyfinPathMapper.PathsEqual(file.Path, path))))
                    .Select(episode => episode.Id).ToHashSet(StringComparer.Ordinal);
                played = watchedEpisodeIds.Count;
                if (played == 0) continue;
                total = work.Episodes.Length;
                watchedBytes = workFiles.Where(file => file.EpisodeId is not null &&
                    watchedEpisodeIds.Contains(file.EpisodeId)).Sum(file => file.Bytes);
                lastPlayedAt = state.Episodes.Where(entry => entry.Value.Watched)
                    .Select(entry => entry.Value.LastPlayedAt).OfType<DateTimeOffset>()
                    .Select(value => (DateTimeOffset?)value).Max();
                watched = new { played, total };
                episodeIdsOnDisk = [.. workFiles.Select(file => file.EpisodeId).OfType<string>()
                    .Where(watchedEpisodeIds.Contains).Distinct(StringComparer.Ordinal)];
                fullyWatched = total > 0 && played >= total;
            }

            var rootIds = workFiles.Select(file => file.RootId!).Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal).ToArray();
            var rootViews = rootIds.Select(id => rootsById.TryGetValue(id, out var root)
                ? new CleanupRoot(id, storage.Label(root.Path), IsOnline(id))
                : new CleanupRoot(id, id, false)).ToImmutableArray();
            items.Add((fullyWatched, new CleanupSuggestion(work.Work.Id,
                CatalogProjection.Title(work), work.Work.Year,
                work.Work.Kind == WorkKind.Film ? "film" : "series", work.Work.PosterUrl,
                watched, lastPlayedAt, workFiles.Sum(file => file.Bytes), watchedBytes, rootViews,
                rootIds.All(IsOnline), episodeIdsOnDisk)));
        }

        return Results.Json(new
        {
            jellyfin = "ok", isAdmin = true, needsAdmin = false, message = (string?)null,
            items = items.OrderByDescending(row => row.FullyWatched)
                .ThenBy(row => row.Item.LastPlayedAt ?? DateTimeOffset.MaxValue)
                .ThenByDescending(row => row.Item.WatchedBytes)
                .Select(row => row.Item),
        }, CatalogProjection.Json);
    }

    private static async Task<IResult> Delete(HttpContext http, TorrentFlowDbContext db,
        ILibraryRepository library, ILibraryPlacement placement, TargetPipeline targets,
        IStorageStatus storage, CancellationToken ct)
    {
        var mutate = HttpMethods.IsPost(http.Request.Method);
        var input = mutate ? await http.Request.ReadFromJsonAsync<DeleteInput>(ct) :
            new(http.Request.Query["watchListItemId"], http.Request.Query["scope"],
                Number(http.Request.Query["season"]), Number(http.Request.Query["episode"]), false,
                http.Request.Query["episodeIds"].Where(value => value is not null)
                    .Select(value => value!).ToArray(), http.Request.Query["workId"]);
        if (mutate && input?.Confirm != true)
            return Results.BadRequest(new { ok = false, error = "Confirmation required",
                message = "Preview the files first, then confirm their deletion.", reason = "unconfirmed" });
        if (input is null ||
            string.IsNullOrWhiteSpace(input.WatchListItemId) && string.IsNullOrWhiteSpace(input.WorkId) ||
            (input.WatchListItemId?.Length ?? 0) > 128 || (input.WorkId?.Length ?? 0) > 128 ||
            input.Scope is not ("show" or "season" or "episode" or "episodes") ||
            input.Scope is "season" or "episode" && input.Season is not (>= 1 and <= 10000) ||
            input.Scope == "episode" && input.Episode is not (>= 1 and <= 100000) ||
            input.Scope == "episodes" && (input.EpisodeIds is null || input.EpisodeIds.Length is < 1 or > 500 ||
                input.EpisodeIds.Any(string.IsNullOrWhiteSpace) ||
                input.EpisodeIds.Distinct(StringComparer.Ordinal).Count() != input.EpisodeIds.Length) ||
            input.Scope != "episodes" && input.EpisodeIds is { Length: > 0 })
            return Results.BadRequest(new { ok = false, error = "Invalid scope",
                message = "Choose a title, season or episode to delete.", reason = "bad-scope" });
        var actor = AccessIdentity.UserId(http);
        var libraryItems = await LibraryRead.ItemsAsync(actor,
            [.. await VisibleIntentAsync(db, actor, ct)],
            await db.Targets.AsNoTracking().ToListAsync(ct),
            library, placement, ct);
        var item = libraryItems.SingleOrDefault(i =>
            !string.IsNullOrWhiteSpace(input.WorkId) && !string.IsNullOrWhiteSpace(input.WatchListItemId)
                ? i.WorkId == input.WorkId && i.Id == input.WatchListItemId
                : !string.IsNullOrWhiteSpace(input.WorkId) ? i.WorkId == input.WorkId :
                    i.Id == input.WatchListItemId);
        if (item is null) return Results.NotFound(new { error = "Not found" });
        var work = await db.Works.AsNoTracking().SingleAsync(w => w.Id == item.WorkId, ct);
        var title = CatalogProjection.Title(new(work,
            [.. await db.WorkNames.AsNoTracking().Where(n => n.WorkId == work.Id).OrderBy(n => n.Id).ToListAsync(ct)], [], [], []));
        var allSeasons = input.Scope == "show" || input.Scope == "episodes";
        var seasonIds = db.Seasons.Where(s => s.WorkId == work.Id &&
                (allSeasons || s.Number == input.Season))
            .Select(s => s.Id);
        var episodeIds = (await db.Episodes.AsNoTracking().Where(e => seasonIds.Contains(e.SeasonId) &&
            (input.Scope == "episode" ? e.Number == input.Episode :
                input.Scope == "episodes" ? input.EpisodeIds!.Contains(e.Id) : true))
            .Select(e => e.Id).ToListAsync(ct)).ToHashSet(StringComparer.Ordinal);
        if (input.Scope == "episodes" && episodeIds.Count != input.EpisodeIds!.Length)
            return Results.BadRequest(new { ok = false, error = "Invalid episodes",
                message = "Choose episodes from this title.", reason = "bad-episodes" });
        bool Within(string? id) => input.Scope == "show" || id is not null && episodeIds.Contains(id);
        var selectedTargets = (await db.Targets.AsNoTracking().Where(t => t.WorkId == work.Id).OrderBy(t => t.Id).ToListAsync(ct))
            .Where(t => Within(t.EpisodeId)).ToArray();
        var allBindings = await library.BindingsAsync(ct);
        var media = await library.MediaAsync(null, ct);
        if (input.Scope == "episodes")
            media = [.. media.Where(file => file.RootId is not null)];
        var links = await db.DownloadTargets.AsNoTracking().OrderBy(l => l.Id).ToListAsync(ct);
        var downloads = await db.Downloads.AsNoTracking().OrderBy(d => d.Id).ToListAsync(ct);
        var preview = LibraryRemoval.Preview(new(input.Scope, input.Scope == "show" ? null : input.Season,
            input.Scope == "episode" ? input.Episode : null), item.WorkId, episodeIds, selectedTargets,
            links, downloads, allBindings, media, input.Scope == "episodes");
        var plan = preview.Plan;
        if (!mutate) return Results.Ok(new { ok = true, title, plan });
        if (plan.Outcome != "deletes") return Results.Json(new { ok = false, error = plan.Outcome == "blocked" ? "Refused" : "Nothing to delete",
            message = plan.Summary, reason = plan.Outcome, plan }, statusCode: 409);
        var roots = await library.RootsAsync(ct);
        foreach (var rootId in preview.Items.Select(entry => entry.Download.RootId)
                     .Concat(preview.UnboundMedia.Select(file => file.RootId))
                     .OfType<string>().Distinct(StringComparer.Ordinal))
        {
            var root = roots.SingleOrDefault(entry => entry.Id == rootId);
            if (root is null || !storage.IsOnline(root.Path))
                return Results.Json(new
                {
                    ok = false,
                    error = "Drive offline",
                    message = root is null ? "Plug in the storage drive before deleting this." :
                        $"Plug in drive {storage.Label(root.Path)} before deleting this.",
                    reason = "drive-offline",
                }, statusCode: 409);
        }
        LibraryDeleteResult result;
        try { result = await targets.DeleteLibraryAsync(preview, ct, input.DeleteAnyway); }
        catch (JellyfinDeleteRefusedException ex)
        {
            return DeleteRefusal(ex);
        }
        if (result.Ok)
        {
            if (input.Scope == "episodes")
            {
                var coordinates = await (from episode in db.Episodes.AsNoTracking()
                    join season in db.Seasons.AsNoTracking() on episode.SeasonId equals season.Id
                    where episodeIds.Contains(episode.Id)
                    select new { Season = season.Number, Episode = episode.Number }).Distinct().ToListAsync(ct);
                foreach (var coordinate in coordinates)
                    await targets.ScopeActionAsync(work.WorkKey, coordinate.Season, coordinate.Episode,
                        TargetAction.Remove, ct);
            }
            else
                await targets.ScopeActionAsync(work.WorkKey,
                    input.Scope == "show" ? null : input.Season,
                    input.Scope == "episode" ? input.Episode : null, TargetAction.Remove, ct);
            if (input.Scope == "show" && !await CatalogEndpoints.RemoveWatchAsync(db, actor, item.Id, ct, item.WorkId))
                return Results.Json(result with { Ok = false, Failed = result.Failed.Add(new(title,
                    "The files were deleted, but this title could not be removed from your library. Reload and remove it again.")) },
                    statusCode: 409);
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> OnDemand(HttpContext http, TorrentFlowDbContext db, IMetadata metadata,
        TargetPipeline targets, CancellationToken ct)
    {
        var body = await http.Request.ReadFromJsonAsync<JsonElement>(ct);
        var id = Text(body, "watchListItemId");
        var season = Integer(body, "season");
        var episode = Integer(body, "episode");
        if (season is null || episode is null || season < 1 || episode < 1)
            return Results.BadRequest(new { ok = false, error = "Season and episode required",
                message = "Choose a season and episode.", field = season is null ? "season" : "episode" });
        WorkRow? work = null;
        if (!string.IsNullOrWhiteSpace(id))
        {
            var actor = AccessIdentity.UserId(http);
            var item = await db.WatchItems.AsNoTracking().SingleOrDefaultAsync(i => i.Id == id && i.UserId == actor, ct);
            if (item is null) return Results.NotFound(new { ok = false, error = "Not found", message = "Library item not found" });
            work = await db.Works.AsNoTracking().SingleOrDefaultAsync(w => w.Id == item.WorkId, ct);
        }
        else if (Text(body, "workKey") is { } key)
            work = await db.Works.AsNoTracking().OrderBy(w => w.Id).FirstOrDefaultAsync(w => w.WorkKey == key || w.Id == key, ct);
        if (work is null && Text(body, "title") is { Length: > 0 } title)
            work = (await metadata.ResolveAsync(new(null, title, null,
                Text(body, "mediaType") == "movie" ? WorkKind.Film : WorkKind.Series), ct)).Work?.Work;
        if (work is null) return Results.BadRequest(new { ok = false, error = "Missing title",
            message = "title or watchListItemId required" });
        var result = await targets.AcquireAsync(new(work.WorkKey, work.Kind == WorkKind.Film ? null : season,
            work.Kind == WorkKind.Film ? null : episode, Integer(body, "quality")), AccessIdentity.UserId(http), ct);
        return Results.Ok(AdmissionProjection.Title(result, work.WorkKey));
    }

    private static int? Number(string? text) => int.TryParse(text, out var n) ? n : null;
    private static string? Text(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static int? Integer(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n) ? n : null;
}
