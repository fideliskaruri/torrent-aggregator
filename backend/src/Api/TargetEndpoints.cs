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
    }
    internal sealed record RankInput(System.Collections.Immutable.ImmutableArray<string> TargetIds);
    internal sealed record QualityInput(int? Resolution);
}
