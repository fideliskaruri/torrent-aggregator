using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Requests;

internal static class RequestEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static IResult Reply(object body) => Results.Json(body, Json);
    internal static void AddRequests(this IServiceCollection services)
    {
        services.AddScoped(sp => new RequestService(sp.GetRequiredService<IStore>(),
            sp.GetRequiredService<IMetadata>(), sp.GetRequiredService<TargetPipeline>()));
        services.AddHostedService<RequestReconciler>();
    }

    internal static void MapRequests(this WebApplication app)
    {
        var requester = app.MapGroup("/api/requester");
        var owner = app.MapGroup("/api/requests");
        requester.AddEndpointFilter(async (context, next) => AccessIdentity.Role(context.HttpContext) == "requester"
            ? await Filter(context, next) : Results.Json(new
            {
                error = "Only people you share TorrentFlow with use these; the owner adds titles directly.",
                code = "requester_only",
            }, statusCode: 403));
        owner.AddEndpointFilter(async (context, next) => AccessIdentity.Role(context.HttpContext) == "owner"
            ? await Filter(context, next) : Results.StatusCode(403));
        requester.MapGet("/seasons", async (HttpContext http, IMetadata metadata, CancellationToken ct) =>
        {
            var provider = http.Request.Query["source"].FirstOrDefault() ?? http.Request.Query["provider"].FirstOrDefault();
            var providerId = http.Request.Query["sourceId"].FirstOrDefault() ?? http.Request.Query["providerId"].FirstOrDefault();
            var title = http.Request.Query["title"].FirstOrDefault();
            int? year = int.TryParse(http.Request.Query["year"], out var parsedYear) ? parsedYear : null;
            if (string.IsNullOrWhiteSpace(provider) || string.IsNullOrWhiteSpace(providerId))
                return Results.BadRequest(new { error = "Choose a catalog title to load its seasons." });
            var result = await metadata.ResolveAsync(new(new(provider, providerId, "tv"),
                title, year, WorkKind.Series), ct);
            return result.Work is null ? Results.Json(new { error = "The season list isn't available. Try again.",
                code = "seasons_failed" }, statusCode: 502) :
                Reply(new { seasons = result.Work.Seasons.Select(s => s.Number).Distinct().Order() });
        });
        requester.MapGet("/library", async (RequestService service, CancellationToken ct) =>
        {
            var files = await service.Read<MediaFileRow>(CatalogState.Query(), ct);
            var works = await service.Read<WorkRow>(CatalogState.Query(), ct);
            var names = await service.Read<WorkNameRow>(CatalogState.Query(), ct);
            return Reply(new { titles = works.Where(w => files.Any(f => f.WorkId == w.Id &&
                f.Role == FileRole.Video && f.Status == FilePresence.Present && File.Exists(f.Path)))
                .Select(w => new { key = w.WorkKey,
                    title = names.Where(n => n.WorkId == w.Id).OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? w.WorkKey,
                    w.Year, mediaType = w.Kind == WorkKind.Film ? "movie" : "tv", w.PosterUrl }) });
        });
        requester.MapGet("/requests", async (HttpContext http, RequestService service, CancellationToken ct) =>
        {
            var rows = await service.Read<RequestRow>(CatalogState.Query(userId: AccessIdentity.UserId(http)), ct);
            var results = new List<object>();
            foreach (var row in rows) results.Add(await service.Project(row, false, ct));
            return Reply(new { requests = results });
        });
        requester.MapPost("/requests", async (HttpContext http, RequestService service, CancellationToken ct) =>
        {
            if (http.Request.ContentLength is > 16384) return Results.StatusCode(413);
            var input = await http.Request.ReadFromJsonAsync<CreateRequest>(ct) ??
                throw new ArgumentException("Send a request object.");
            await RequestService.Gate.WaitAsync(ct);
            try
            {
                var request = await service.Create(AccessIdentity.UserId(http),
                    input with { Seasons = input.Seasons.IsDefault ? [] : input.Seasons }, ct);
                return Results.Json(new { request = await service.Project(request, false, ct) }, Json, statusCode: 201);
            }
            finally { RequestService.Gate.Release(); }
        });
        owner.MapGet("/", async (string? status, RequestService service, CancellationToken ct) =>
        {
            if (status is not (null or "pending" or "approved" or "downloading" or "available" or
                "declined" or "fulfilled" or "partial" or "failed" or "cancelled"))
                throw new ArgumentException("Choose a valid request status.");
            var rows = await service.Read<RequestRow>(CatalogState.Query(), ct);
            var results = new List<object>();
            foreach (var row in rows.OrderBy(r => r.CreatedAt).DistinctBy(r =>
                $"{r.WorkId}:{r.Scope}:{string.Join(",", r.ScopeData.Seasons.Order())}:{r.Decision}"))
            {
                var projected = await service.Project(row, true, ct);
                if (status is null || JsonSerializer.SerializeToElement(projected,
                    new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("status").GetString() == status)
                    results.Add(projected);
            }
            return Reply(new { requests = results, pendingCount = rows.Count(r => r.Decision == RequestDecision.Pending) });
        });
        foreach (var action in new[] { "approve", "decline", "retry" })
        {
            var command = action;
            owner.MapPost("/{id}/" + action, async (string id, HttpContext http, RequestService service, CancellationToken ct) =>
            {
                string? reason = null;
                if (command == "decline" && http.Request.ContentLength is > 0)
                {
                    if (http.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
                    {
                        var body = await http.Request.ReadFromJsonAsync<JsonElement>(ct);
                        reason = body.TryGetProperty("reason", out var r) ? r.GetString() : null;
                    }
                    else reason = await new StreamReader(http.Request.Body).ReadToEndAsync(ct);
                    if (reason?.Length > 500) throw new ArgumentException("Keep the reason under 500 characters.");
                }
                await RequestService.Gate.WaitAsync(ct);
                try
                {
                    var row = await service.Decide(id, AccessIdentity.UserId(http), command, reason, ct);
                    var projected = JsonSerializer.SerializeToElement(await service.Project(row, true, ct),
                        new JsonSerializerOptions(JsonSerializerDefaults.Web));
                    return Reply(new { ok = true, status = projected.GetProperty("status").GetString(),
                        message = command == "decline" ? "Request declined." : "Request queued." });
                }
                finally { RequestService.Gate.Release(); }
            });
        }
        // Requesters have no mutation actions after creation, including the legacy cancel route.
        requester.MapPost("/requests/{id}/cancel", () => Results.Json(
            new { error = "Request details are read-only. Ask the owner to change this request.", code = "read_only" }, statusCode: 403));
        owner.MapPost("/{id}/pick", Pick);
    }

    private sealed record ReleaseChoice(string WorkId, string Hash, int? Season, int? Episode, DateTimeOffset ExpiresAt);

    private static async Task<IResult> Pick(string id, HttpContext http, RequestService service,
        TargetPipeline pipeline, IDataProtectionProvider protection, CancellationToken ct)
    {
        var request = (await service.Read<RequestRow>(CatalogState.Query(id), ct)).SingleOrDefault()
            ?? throw new KeyNotFoundException("Request not found.");
        if (!http.Request.HasJsonContentType() || http.Request.ContentLength > 16384)
            return Results.BadRequest(new { error = "Choose a release first." });
        var body = await http.Request.ReadFromJsonAsync<JsonElement>(ct);
        if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("token", out var token) ||
            token.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(token.GetString()))
            return Results.BadRequest(new { error = "Choose a release first." });
        ReleaseChoice? choice;
        try
        {
            choice = JsonSerializer.Deserialize<ReleaseChoice>(protection
                .CreateProtector("TorrentFlow.TitleReleaseChoice.v1").Unprotect(token.GetString()!));
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        { return Results.Conflict(new { ok = false, message = "That choice expired. Search again and choose a release." }); }
        if (choice is null || choice.ExpiresAt <= DateTimeOffset.UtcNow || choice.WorkId != request.WorkId)
            return Results.Conflict(new { ok = false, message = "That choice expired. Search again and choose a release." });
        await RequestService.Gate.WaitAsync(ct);
        try
        {
            request = (await service.Read<RequestRow>(CatalogState.Query(id), ct)).SingleOrDefault()
                ?? throw new KeyNotFoundException("Request not found.");
            if (request.Decision != RequestDecision.Approved)
                throw new RequestConflict("not_pending", $"This request is already {request.Decision.ToString().ToLowerInvariant()}.");
            await service.Acquire(request, ct);
            var items = await service.Read<RequestItemRow>(CatalogState.Query() with { RequestId = id }, ct);
            var seasons = await service.Read<SeasonRow>(CatalogState.Query(workId: request.WorkId), ct);
            var episodes = await service.Read<EpisodeRow>(CatalogState.Query(), ct);
            var seasonId = seasons.FirstOrDefault(s => s.Number == choice.Season)?.Id;
            var selected = items.Where(i => i.Settlement == ItemSettlement.Open && i.TargetId is not null &&
                (request.Scope == RequestScope.Film ? choice.Season is null && choice.Episode is null :
                    episodes.Any(e => e.Id == i.EpisodeId && e.SeasonId == seasonId &&
                        (choice.Episode is null || e.Number == choice.Episode)))).ToArray();
            if (selected.Length == 0)
                return Results.Conflict(new { ok = false, message = "Choose an unfinished item from this request." });
            var queued = 0;
            foreach (var targetId in selected.Select(i => i.TargetId!).Distinct())
                queued += (await pipeline.PickAsync(targetId, choice.Hash, ct)).Queued;
            var projected = JsonSerializer.SerializeToElement(await service.Project(request, true, ct), Json);
            return Reply(new { ok = true, status = projected.GetProperty("status").GetString(),
                message = $"{queued} queued", infoHash = choice.Hash });
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        { return Results.Conflict(new { ok = false, message = ex.Message }); }
        finally { RequestService.Gate.Release(); }
    }

    private static async ValueTask<object?> Filter(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        try { return await next(context); }
        catch (RequestConflict ex) { return Results.Json(new { error = ex.Message, code = ex.Code }, statusCode: 409); }
        catch (KeyNotFoundException ex) { return Results.Json(new { error = ex.Message, code = "not_found" }, statusCode: 404); }
        catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message, code = "invalid_request" }); }
        catch (JsonException) { return Results.BadRequest(new { error = "Send valid request JSON.", code = "invalid_request" }); }
        catch (InvalidOperationException ex) { return Results.Json(new { error = ex.Message, code = "conflict" }, statusCode: 409); }
    }

}
