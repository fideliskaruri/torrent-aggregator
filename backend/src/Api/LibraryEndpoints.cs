using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class LibraryEndpoints
{
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
        group.MapMethods("/delete", ["GET", "POST"], Delete);
        group.MapPost("/ondemand", OnDemand);
    }

    private sealed record DeleteInput(string? WatchListItemId, string? Scope, int? Season, int? Episode, bool Confirm = false);

    private static async Task<IResult> Delete(HttpContext http, CatalogState state,
        ILibraryRepository library, ILibraryPlacement placement, TargetPipeline targets, DevFiling filing, CancellationToken ct)
    {
        var mutate = HttpMethods.IsPost(http.Request.Method);
        var input = mutate ? await http.Request.ReadFromJsonAsync<DeleteInput>(ct) :
            new(http.Request.Query["watchListItemId"], http.Request.Query["scope"],
                Number(http.Request.Query["season"]), Number(http.Request.Query["episode"]));
        if (mutate && input?.Confirm != true)
            return Results.BadRequest(new { ok = false, error = "Confirmation required",
                message = "Preview the files first, then confirm their deletion.", reason = "unconfirmed" });
        if (input is null || string.IsNullOrWhiteSpace(input.WatchListItemId) || input.WatchListItemId.Length > 128 ||
            input.Scope is not ("show" or "season" or "episode") ||
            input.Scope != "show" && input.Season is not (>= 1 and <= 10000) ||
            input.Scope == "episode" && input.Episode is not (>= 1 and <= 100000))
            return Results.BadRequest(new { ok = false, error = "Invalid scope",
                message = "Choose a title, season or episode to delete.", reason = "bad-scope" });
        var actor = AccessIdentity.UserId(http);
        var item = (await LibraryRead.ItemsAsync(actor,
            await state.ReadAsync<WatchItemRow>(CatalogState.Query(userId: actor), ct),
            library, placement, ct)).SingleOrDefault(i => i.Id == input.WatchListItemId);
        if (item is null) return Results.NotFound(new { error = "Not found" });
        var work = (await state.ReadAsync<WorkRow>(CatalogState.Query(item.WorkId), ct)).Single();
        var names = await state.ReadAsync<WorkNameRow>(CatalogState.Query(workId: item.WorkId), ct);
        var title = CatalogProjection.Title(new(work, names, [], [], []));
        var seasons = await state.ReadAsync<SeasonRow>(CatalogState.Query(workId: item.WorkId), ct);
        var episodeIds = new HashSet<string>();
        foreach (var season in seasons.Where(s => input.Scope == "show" || s.Number == input.Season))
            foreach (var episode in await state.ReadAsync<EpisodeRow>(CatalogState.Query() with { SeasonId = season.Id }, ct))
                if (input.Scope != "episode" || episode.Number == input.Episode) episodeIds.Add(episode.Id);
        bool Within(string? id) => input.Scope == "show" || id is not null && episodeIds.Contains(id);
        var selectedTargets = (await state.ReadAsync<TargetRow>(CatalogState.Query(workId: item.WorkId), ct))
            .Where(t => Within(t.EpisodeId)).ToArray();
        var allBindings = await library.BindingsAsync(ct);
        var media = await library.MediaAsync(null, ct);
        var links = await state.ReadAsync<DownloadTargetRow>(CatalogState.Query(), ct);
        var downloads = await state.ReadAsync<DownloadRow>(CatalogState.Query(), ct);
        var preview = LibraryRemoval.Preview(new(input.Scope, input.Scope == "show" ? null : input.Season,
            input.Scope == "episode" ? input.Episode : null), item.WorkId, episodeIds, selectedTargets,
            links, downloads, allBindings, media);
        var plan = preview.Plan;
        if (!mutate) return Results.Ok(new { ok = true, title, plan });
        if (plan.Outcome != "deletes") return Results.Json(new { ok = false, error = plan.Outcome == "blocked" ? "Refused" : "Nothing to delete",
            message = plan.Summary, reason = plan.Outcome, plan }, statusCode: 409);
        var result = await filing.DeleteLibraryAsync(targets, preview, ct);
        if (result.Ok)
        {
            await targets.ScopeActionAsync(work.WorkKey,
                input.Scope == "show" ? null : input.Season, input.Scope == "episode" ? input.Episode : null, TargetAction.Remove, ct);
            if (input.Scope == "show" && !await state.RemoveAsync(actor, item.Id, ct))
                return Results.Json(result with { Ok = false, Failed = result.Failed.Add(new(title,
                    "The files were deleted, but this title could not be removed from your library. Reload and remove it again.")) },
                    statusCode: 409);
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> OnDemand(HttpContext http, CatalogState state, IMetadata metadata,
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
            var item = (await state.ReadAsync<WatchItemRow>(CatalogState.Query(id,
                userId: AccessIdentity.UserId(http)), ct)).SingleOrDefault();
            if (item is null) return Results.NotFound(new { ok = false, error = "Not found", message = "Library item not found" });
            work = (await state.ReadAsync<WorkRow>(CatalogState.Query(item.WorkId), ct)).SingleOrDefault();
        }
        else if (Text(body, "workKey") is { } key)
            work = (await state.ReadAsync<WorkRow>(CatalogState.Query(), ct)).FirstOrDefault(w => w.WorkKey == key || w.Id == key);
        if (work is null && Text(body, "title") is { Length: > 0 } title)
            work = (await metadata.ResolveAsync(new(null, title, null,
                Text(body, "mediaType") == "movie" ? WorkKind.Film : WorkKind.Series), ct)).Work?.Work;
        if (work is null) return Results.BadRequest(new { ok = false, error = "Missing title",
            message = "title or watchListItemId required" });
        var result = await targets.AcquireAsync(new(work.WorkKey, work.Kind == WorkKind.Film ? null : season,
            work.Kind == WorkKind.Film ? null : episode, Integer(body, "quality")), AccessIdentity.UserId(http), ct);
        return Results.Ok(new { ok = result.Accepted, message = result.Message, queued = result.Queued,
            owned = result.Owned, workKey = work.WorkKey });
    }

    private static int? Number(string? text) => int.TryParse(text, out var n) ? n : null;
    private static string? Text(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static int? Integer(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var n) ? n : null;
}
