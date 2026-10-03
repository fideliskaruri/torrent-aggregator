using TorrentFlow.Api.Access;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal static class UpgradeEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapPost("/api/title/{workKey}/check-again", async (string workKey, UpgradeScope input,
            HttpContext http, TargetPipeline pipeline, CancellationToken ct) =>
        {
            if (AccessIdentity.Role(http) != "owner") return Results.StatusCode(403);
            try
            {
                return Results.Json(new { items = await pipeline.CheckQualityAsync(
                    new(workKey, input.Season, input.Episode), ct) }, CatalogProjection.Json);
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        });
        app.MapPost("/api/title/{workKey}/upgrade", async (string workKey, UpgradeScope input,
            HttpContext http, TargetPipeline pipeline, CancellationToken ct) =>
        {
            if (AccessIdentity.Role(http) != "owner") return Results.StatusCode(403);
            try
            {
                return Results.Json(await pipeline.UpgradeAsync(new(workKey, input.Season, input.Episode),
                    AccessIdentity.Actor(http).UserId, ct), CatalogProjection.Json);
            }
            catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
        });
    }

    internal sealed record UpgradeScope(int? Season = null, int? Episode = null);
}
