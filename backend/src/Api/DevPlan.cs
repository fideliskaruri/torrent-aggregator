using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevPlan
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    internal static void MapDevPlan(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        var group = app.MapGroup("/api/dev/plan-eval").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or JsonException)
            { return Results.BadRequest(new { error = "invalid_input", message = "Provide complete, bounded plan inputs." }); }
        });
        group.MapGet("/metadata", async (string workKey, IMetadata metadata, CancellationToken ct) =>
        {
            if (workKey.Length is < 1 or > 200) return Results.BadRequest();
            return Results.Json(await metadata.GetWorkAsync(workKey, false, ct), Json);
        });
        group.MapPost("/", async (HttpContext http, IMetadata metadata, IPlan plan,
            [Microsoft.Extensions.DependencyInjection.FromKeyedServices("targets")] IStore store,
            CancellationToken ct) =>
        {
            if (http.Request.ContentLength is null or > 8 * 1024 * 1024) return Results.BadRequest();
            var request = await http.Request.ReadFromJsonAsync<Evaluation>(Json, ct);
            if (request?.Input is not { } input || input.Pool.IsDefault || input.Targets.IsDefault ||
                input.Evidence.IsDefault || input.Owned.IsDefault || input.Blocks.IsDefault ||
                input.Pool.Length > 500 || input.Targets.Length > 1000 ||
                input.OwnerSelectedFiles.IsDefault || input.FileMetadata.IsDefault ||
                input.Pool.Any(c => c is null || c.Release is null || c.Release.Parsed is null ||
                    string.IsNullOrWhiteSpace(c.Release.Id) || c.Release.Parsed.Title is null || c.Observations.IsDefault) ||
                input.Targets.Any(t => t is null || string.IsNullOrWhiteSpace(t.Id)) ||
                input.Owned.Any(o => o is null || o.Videos.IsDefault) ||
                input.Blocks.Any(b => b is null || b.Hash is null) ||
                input.Evidence.Any(e => e is null || e.Hash is null) ||
                input.FileMetadata.Any(m => m is null) ||
                input.Pool.Any(c => (c.Release.Files?.Length ?? 0) > 10000) ||
                input.Evidence.Any(e => (e.Files?.Length ?? 0) > 10000))
                return Results.BadRequest(new { error = "invalid_input" });
            if (request.WorkKey is { } key)
            {
                if (key.Length is < 1 or > 200) return Results.BadRequest();
                var resolved = await metadata.GetWorkAsync(key, false, ct);
                if (resolved.Work is null) return Results.NotFound(resolved.Failure);
                input = input with { Work = resolved.Work };
            }
            var qualityRow = (await new CatalogState(store)
                .ReadAsync<SettingRow>(CatalogState.Query("quality"), ct)).SingleOrDefault();
            var audioLanguage = qualityRow is null ? "auto" :
                SettingsCatalog.Read<QualitySettings>(qualityRow).AudioLanguage ?? "auto";
            input = input with
            {
                Targets = [.. input.Targets.Select(t => t with { AudioLanguage = audioLanguage })],
                Preference = input.Preference is { } preference ? preference with { AudioLanguage = null } : null,
            };
            var clock = Stopwatch.StartNew();
            var result = plan.Choose(input);
            return Results.Json(new { result, elapsedMs = clock.Elapsed.TotalMilliseconds, work = input.Work }, Json);
        });
    }

    private sealed record Evaluation(string? WorkKey, PlanInput Input);
}
