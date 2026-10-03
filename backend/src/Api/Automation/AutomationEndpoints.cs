using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;

namespace TorrentFlow.Api.Automation;

internal static class AutomationEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static IResult Reply(object body) => Results.Json(body, Json);
    internal static IServiceCollection AddAutomation(this IServiceCollection services)
    {
        services.AddSingleton<AutomationRepository>();
        services.AddSingleton<Hunter>();
        services.AddHostedService<HunterScheduler>();
        return services;
    }

    internal static void MapAutomation(this WebApplication app)
    {
        app.MapGet("/api/rules", async (AutomationRepository db, CancellationToken ct) =>
            Reply(new { rules = (await db.ReadAsync<AutoRuleRow>(ct)).OrderByDescending(r => r.UpdatedAt).Select(Project) }));
        app.MapMethods("/api/rules", ["POST", "PATCH"], SaveRule);
        app.MapDelete("/api/rules", async (string? id, AutomationRepository db, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(id) || id.Length > 128) return Results.BadRequest(new { error = "A rule id is required." });
            var row = (await db.ReadAsync<AutoRuleRow>(ct)).FirstOrDefault(r => r.Id == id);
            if (row is not null) await db.DeleteAsync(row, ct);
            return Reply(new { ok = true });
        });
        app.MapPost("/api/rules/run", async (AutomationRepository db, CancellationToken ct) =>
        {
            var rules = (await db.ReadAsync<AutoRuleRow>(ct)).Where(r => r.Enabled);
            return Reply(new { ok = false, offline = false, message = "Automatic downloads are not available yet. Your rules are saved.",
                summary = rules.Select(r => new { id = r.Id, name = r.Name, status = "skipped", message = Hunter.Boundary }) });
        });
        app.MapGet("/api/follows", async (AutomationRepository db, CancellationToken ct) =>
            Results.Ok(new { follows = await db.ReadAsync<FollowRow>(ct) }));
        app.MapPut("/api/follows/{workKey}", SaveFollow);
        app.MapPut("/api/quality-watches/{workKey}", SaveQualityWatch);
        app.MapPost("/api/dev/hunter", async (HttpContext http, Hunter hunter, CancellationToken ct) =>
        {
            if (AccessIdentity.Via(http) != "local" || AccessIdentity.Role(http) != "owner")
                return Results.Json(new { error = "Run automatic checks on the computer running TorrentFlow." }, statusCode: 403);
            return Results.Ok(await hunter.RunAsync(http.Request.Query["probe"] == "true", ct));
        });
    }

    private static object Project(AutoRuleRow r) => new
    {
        r.Id, r.UserId, r.Name, r.Query, r.Category, minSeeders = r.MinListedSeeders,
        maxSizeBytes = r.MaxBytes, resolution = r.ResolutionFloor is { } floor ? $"{floor}p" : null,
        sources = r.SourceIds.IsEmpty ? null : string.Join(',', r.SourceIds), r.Enabled,
        r.LastRunAt, lastMatchTitle = (string?)null, lastMatchMagnet = (string?)null,
        r.MatchCount, r.CreatedAt, r.UpdatedAt,
    };

    private static async Task<IResult> SaveRule(HttpContext http, AutomationRepository db, CancellationToken ct)
    {
        try
        {
            if (http.Request.ContentLength > 16384) return Results.BadRequest(new { error = "The rule is too large." });
            var body = await http.Request.ReadFromJsonAsync<JsonElement>(ct);
            if (body.ValueKind != JsonValueKind.Object) throw new ArgumentException("Enter a rule.");
            var patch = http.Request.Method == "PATCH";
            var id = Text(body, "id");
            var old = patch ? (await db.ReadAsync<AutoRuleRow>(ct)).FirstOrDefault(r => r.Id == id) : null;
            if (patch && old is null) return Results.NotFound(new { error = "Not found" });
            var now = DateTimeOffset.UtcNow;
            var row = old ?? new AutoRuleRow(Guid.NewGuid().ToString("N"), "local", "", "", "all",
                10, null, null, [], true, null, null, 0, now, now, 0);
            var name = body.TryGetProperty("name", out _) ? Text(body, "name") : row.Name;
            var query = body.TryGetProperty("query", out _) ? Text(body, "query") : row.Query;
            if (string.IsNullOrWhiteSpace(name) || name.Length > 200 ||
                string.IsNullOrWhiteSpace(query) || query.Length > 2000)
                throw new ArgumentException("Enter a name (up to 200 characters) and a search query.");
            var category = body.TryGetProperty("category", out _) ? Text(body, "category") : row.Category;
            if (category is not ("all" or "anime" or "movies" or "tv")) throw new ArgumentException("Choose a valid category.");
            var seeds = body.TryGetProperty("minSeeders", out var seed) ? seed.GetInt32() : row.MinListedSeeders;
            if (seeds is < 0 or > 10000000) throw new ArgumentException("Enter a seed count between 0 and 10000000.");
            var max = body.TryGetProperty("maxSizeBytes", out var size)
                ? size.ValueKind == JsonValueKind.Null ? null : (long?)size.GetInt64() : row.MaxBytes;
            if (max is <= 0 or > 9007199254740991) throw new ArgumentException("Enter a positive maximum size.");
            int? resolution = row.ResolutionFloor;
            if (body.TryGetProperty("resolution", out _))
                resolution = Text(body, "resolution") switch
                {
                    null => null, "480p" => 480, "720p" => 720, "1080p" => 1080, "2160p" => 2160,
                    _ => throw new ArgumentException("Choose a valid resolution."),
                };
            var sources = row.SourceIds;
            if (body.TryGetProperty("sources", out _))
            {
                var raw = Text(body, "sources");
                sources = raw is null ? [] : [.. raw.Split(',').Select(s => s.Trim()).Distinct()];
                if (sources.Length > 7 || sources.Any(s => s is not ("nyaa" or "1337x" or "apibay" or "torrentscsv" or "yts" or "archive" or "torznab")))
                    throw new ArgumentException("Choose supported rule sources.");
            }
            var enabled = body.TryGetProperty("enabled", out var flag) ? flag.GetBoolean() : row.Enabled;
            row = row with { Name = name.Trim(), Query = query.Trim(), Category = category,
                MinListedSeeders = seeds, MaxBytes = max, ResolutionFloor = resolution,
                SourceIds = sources, Enabled = enabled, UpdatedAt = now, Version = row.Version + 1 };
            await db.SaveAsync(row, old?.Version, ct);
            return Reply(new { rule = Project(row), runResult = (object?)null });
        }
        catch (Exception ex) when (ex is ArgumentException or JsonException or InvalidOperationException or FormatException)
        { return Results.BadRequest(new { error = ex.Message }); }
    }

    private static async Task<IResult> SaveFollow(string workKey, JsonElement body, IMetadata metadata,
        AutomationRepository db, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object)
            return Results.BadRequest(new { error = "Choose whether to follow this series." });
        var result = await metadata.GetWorkAsync(workKey, true, ct);
        if (result.Work is not { } work || work.Work.Kind != WorkKind.Series)
            return Results.BadRequest(new { error = "Open a series before following it." });
        if (!body.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Results.BadRequest(new { error = "Choose whether to follow this series." });
        var old = (await db.ReadAsync<FollowRow>(ct)).FirstOrDefault(f => f.WorkId == work.Work.Id);
        var now = DateTimeOffset.UtcNow;
        var row = old is null ? new FollowRow("follow:" + work.Work.Id, work.Work.Id, value.GetBoolean(),
            null, DateTimeOffset.UnixEpoch, null, now, now, 1)
            : old with { Enabled = value.GetBoolean(), UpdatedAt = now, Version = old.Version + 1 };
        await db.SaveAsync(row, old?.Version, ct);
        return Results.Ok(new { follow = row });
    }

    private static async Task<IResult> SaveQualityWatch(string workKey, JsonElement body,
        IMetadata metadata, AutomationRepository db, CancellationToken ct)
    {
        if (body.ValueKind != JsonValueKind.Object)
            return Results.BadRequest(new { error = "Choose a resolution and whether to watch for it." });
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        if (work is null) return Results.NotFound(new { error = "Open the title before setting a quality watch." });
        if (!body.TryGetProperty("enabled", out var enabled) || enabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !body.TryGetProperty("resolution", out var resolution) || resolution.ValueKind != JsonValueKind.Number ||
            !resolution.TryGetInt32(out var floor) ||
            floor is not (480 or 720 or 1080 or 2160))
            return Results.BadRequest(new { error = "Choose a resolution and whether to watch for it." });
        var old = (await db.ReadAsync<WatchItemRow>(ct)).FirstOrDefault(w => w.WorkId == work.Work.Id && w.UserId == "local");
        var now = DateTimeOffset.UtcNow;
        var row = old is null ? new WatchItemRow("watch:" + work.Work.Id, "local", work.Work.Id,
            WatchStatus.Planned, enabled.GetBoolean(), now, now, 1)
            : old with { UpgradeWatch = enabled.GetBoolean(), UpdatedAt = now, Version = old.Version + 1 };
        var preference = (await db.ReadAsync<WorkPreferenceRow>(ct)).FirstOrDefault(p => p.WorkId == work.Work.Id);
        var next = preference is null ? new WorkPreferenceRow("preference:" + work.Work.Id,
            work.Work.Id, null, floor, null, null, null, now, 1)
            : preference with { PreferredResolution = floor, UpdatedAt = now, Version = preference.Version + 1 };
        await db.SaveAsync([new(row, old?.Version, null), new(next, preference?.Version, null)], ct);
        return Results.Ok(new { watch = row, resolution = floor, notificationOnly = true });
    }

    private static string? Text(JsonElement body, string key) =>
        body.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetString() : null;
}
