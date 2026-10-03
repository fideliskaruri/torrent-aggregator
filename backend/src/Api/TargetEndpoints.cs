using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class TargetEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) } };

    internal static void MapTargets(this WebApplication app)
    {
        app.MapPut("/api/title/{workKey}/quality", async (string workKey, QualityInput input,
            HttpContext http, TargetPipeline pipeline, CancellationToken ct) =>
        {
            if (AccessIdentity.Role(http) != "owner") return Results.StatusCode(403);
            try { return Results.Json(await pipeline.SetQualityAsync(workKey, input.Resolution, ct), Json); }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        });
        app.MapPut("/api/targets/{id}/quality", async (string id, QualityInput input,
            HttpContext http, TargetPipeline pipeline, CancellationToken ct) =>
        {
            if (AccessIdentity.Role(http) != "owner") return Results.StatusCode(403);
            try { return Results.Json(await pipeline.SetQualityAsync(id, input.Resolution, ct), Json); }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        });
        if (!app.Environment.IsDevelopment()) return;
        var group = app.MapGroup("/api/dev/targets").AddEndpointFilter(async (context, next) =>
        {
            if (!DevFind.Owner(context.HttpContext)) return Results.StatusCode(403);
            try { return await next(context); }
            catch (ArgumentException ex) { return Results.BadRequest(new { message = ex.Message }); }
        });
        group.MapGet("/", async (TargetPipeline pipeline, CancellationToken ct) =>
            Results.Json(await pipeline.ReadAsync(ct), Json));
        group.MapGet("/recovery", async (TargetPipeline pipeline, CancellationToken ct) =>
            Results.Json(await pipeline.RecoverySettingsAsync(ct), Json));
        group.MapPut("/recovery", async (TorrentFlow.Store.RecoverySettings input, TargetPipeline pipeline, CancellationToken ct) =>
            Results.Json(await pipeline.UpdateRecoverySettingsAsync(input, ct), Json));
        group.MapPost("/{id}/swap", async (string id, TargetPipeline pipeline, CancellationToken ct) =>
            Results.Json(await pipeline.FindAnotherAsync(id, ct), Json));
        group.MapPost("/", async (AcquireInput input, HttpContext http, TargetPipeline pipeline, CancellationToken ct) =>
        {
            if (input.WorkKey.Length is < 1 or > 200 || input.Season is < 0 or > 999 ||
                input.Episode is < 1 or > 99999 || input.Quality is < 1 or > 4320)
                return Results.BadRequest(new { message = "Provide a title and valid season, episode and quality." });
            return Results.Json(await pipeline.AcquireAsync(input, AccessIdentity.Actor(http).UserId, ct), Json);
        });
        group.MapDelete("/{id}", async (string id, TargetPipeline pipeline, CancellationToken ct) =>
            Results.Json(await pipeline.ActionAsync(id, TargetAction.Remove, ct), Json));
        group.MapPost("/{id}/{action}", async (string id, string action, TargetPipeline pipeline, CancellationToken ct) =>
        {
            var command = action switch { "pause" => TargetAction.Pause, "resume" => TargetAction.Resume,
                "try" => TargetAction.TryNow, "now" => TargetAction.DownloadNow, _ => (TargetAction?)null };
            return command is null ? Results.BadRequest() :
                Results.Json(await pipeline.ActionAsync(id, command.Value, ct), Json);
        });
    }
    internal sealed record QualityInput(int? Resolution);
}
