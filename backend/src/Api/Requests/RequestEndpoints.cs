using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
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
        services.AddScoped(sp => new RequestService(sp.GetRequiredKeyedService<IStore>("targets"),
            sp.GetRequiredService<IMetadata>(), sp.GetRequiredService<TargetPipeline>()));
        services.AddHostedService<RequestReconciler>();
    }

    internal static void MapRequests(this WebApplication app)
    {
        var requester = app.MapGroup("/api/requester");
        var owner = app.MapGroup("/api/requests");
        requester.AddEndpointFilter(async (context, next) => AccessIdentity.Role(context.HttpContext) == "requester"
            ? await Filter(context, next) : Results.StatusCode(403));
        owner.AddEndpointFilter(async (context, next) => AccessIdentity.Role(context.HttpContext) == "owner"
            ? await Filter(context, next) : Results.StatusCode(403));
        requester.MapGet("/seasons", async (string provider, string providerId, string mediaType,
            string? title, int? year, IMetadata metadata, CancellationToken ct) =>
        {
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
        requester.MapGet("/calendar", async (HttpContext http, RequestService service, CancellationToken ct) =>
        {
            var rows = await service.Read<RequestRow>(CatalogState.Query(userId: AccessIdentity.UserId(http)), ct);
            var results = new List<object>();
            var entries = new List<object>();
            var open = rows.Where(r => r.Decision is RequestDecision.Pending or RequestDecision.Approved).ToArray();
            var targets = open.Length == 0 ? [] : await service.Read<TargetRow>(CatalogState.Query(), ct);
            var episodes = open.Length == 0 ? [] : await service.Read<EpisodeRow>(CatalogState.Query(), ct);
            foreach (var row in open)
            {
                results.Add(await service.Project(row, false, ct));
                var work = (await service.Read<WorkRow>(CatalogState.Query(row.WorkId), ct)).Single();
                var name = (await service.Read<WorkNameRow>(CatalogState.Query(workId: work.Id), ct))
                    .OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? work.WorkKey;
                var mine = targets.Where(t => t.WorkId == work.Id && t.Origin == IntentOrigin.Request).ToArray();
                var expected = mine.Select(t => t.ExpectedAt ?? episodes.FirstOrDefault(e => e.Id == t.EpisodeId)?.AirAt)
                    .Where(d => d is not null).Min() ?? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt;
                var state = row.Decision == RequestDecision.Pending ? "pending" :
                    mine.Length > 0 && mine.All(t => t.State == TargetState.Done) ? "in_library" :
                    mine.Any(t => t.State is TargetState.Fetching or TargetState.Filing) ? "downloading" :
                    mine.Any(t => t.ChosenReleaseHash is not null) ? "found" :
                    expected > DateTimeOffset.UtcNow ? "expected" : "searching";
                entries.Add(new { id = row.Id, title = name, posterUrl = work.PosterUrl, at = expected, state,
                    mediaType = work.Kind == WorkKind.Film ? "movie" : "tv" });
            }
            return Reply(new { items = results, entries });
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
        owner.MapGet("/auto-approve", async (RequestService service, CancellationToken ct) => Reply(await AutoConfig(service, ct)));
        owner.MapPut("/auto-approve", async (RequestService service, HttpContext http, CancellationToken ct) =>
        {
            if (http.Request.ContentLength is > 65536) return Results.StatusCode(413);
            var input = await http.Request.ReadFromJsonAsync<AutoConfigInput>(ct) ??
                throw new ArgumentException("Send an auto-approve rule list.");
            if (input.Rules.IsDefault || input.Rules.Length > 200) throw new ArgumentException("Provide at most 200 auto-approve rules.");
            if (input.Rules.Any(r => r is null || string.IsNullOrWhiteSpace(r.Email)))
                throw new ArgumentException("Provide an email for each auto-approve rule.");
            var normalized = input.Rules.Select(r => r with { Email = r.Email.Trim().ToLowerInvariant() }).ToArray();
            if (normalized.Any(r => r.Email.Length > 320 || !r.Email.Contains('@') ||
                r.Mode is not ("none" or "moviesOnly" or "everything")) ||
                normalized.Select(r => r.Email).Distinct().Count() != normalized.Length)
                throw new ArgumentException("Use one valid email and mode per rule.");
            await RequestService.Gate.WaitAsync(ct);
            try
            {
                var existing = await service.Read<AutoApproveRuleRow>(CatalogState.Query(), ct);
                var now = DateTimeOffset.UtcNow;
                var writes = normalized.Where(r => r.Mode != "none").Select(r =>
                {
                    var old = existing.FirstOrDefault(e => e.NormalizedEmail == r.Email);
                    var mode = r.Mode == "moviesOnly" ? AutoApproveMode.MoviesOnly : AutoApproveMode.Everything;
                    return new RowWrite(new AutoApproveRuleRow(old?.Id ?? Guid.NewGuid().ToString("N"),
                        r.Email, mode, old?.CreatedAt ?? now, now, old is null ? 1 : old.Version + 1), old?.Version, null);
                }).ToArray();
                var deletes = existing.Where(e => normalized.All(r => r.Email != e.NormalizedEmail || r.Mode == "none"))
                    .Select(e => new RowDelete(StoreTable.AutoApproveRule, e.Id, e.Version, null));
                await service.Commit(AccessIdentity.UserId(http), writes, ct, deletes);
                return Reply(await AutoConfig(service, ct));
            }
            finally { RequestService.Gate.Release(); }
        });
        // Requesters have no mutation actions after creation, including the legacy cancel route.
        requester.MapPost("/requests/{id}/cancel", () => Results.Json(
            new { error = "Request details are read-only. Ask the owner to change this request.", code = "read_only" }, statusCode: 403));
        owner.MapPost("/{id}/pick", () => Results.Json(new { ok = false,
            message = "Manual release picking is not available in the target API yet. Retry automatic selection." }, statusCode: 409));
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

    private static async Task<object> AutoConfig(RequestService service, CancellationToken ct)
    {
        var rules = await service.Read<AutoApproveRuleRow>(CatalogState.Query(), ct);
        var users = await service.Read<UserRow>(CatalogState.Query(), ct);
        return new
        {
            rules = rules.Select(r => new { email = r.NormalizedEmail,
                mode = r.Mode == AutoApproveMode.MoviesOnly ? "moviesOnly" : r.Mode == AutoApproveMode.Everything ? "everything" : "none" }),
            knownEmails = users.Select(u => u.NormalizedEmail).Concat(rules.Select(r => r.NormalizedEmail))
                .Where(e => e is not null).Distinct().Order(),
        };
    }
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    internal sealed record AutoConfigInput(ImmutableArray<AutoRuleInput> Rules);
    [JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
    internal sealed record AutoRuleInput(string Email, string Mode);
}
