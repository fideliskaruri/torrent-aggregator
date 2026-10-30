using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;

namespace TorrentFlow.Api;

internal static class WatchLaterEndpoints
{
    internal static void MapWatchLater(this WebApplication app)
    {
        app.MapGet("/api/watch-later", async (HttpContext http, WatchLaterReadService watchLater,
            CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            var result = await watchLater.ReadAsync(AccessIdentity.UserId(http), ct);
            return Results.Json(new { items = result.Items, jellyfinStale = result.JellyfinStale },
                CatalogProjection.Json);
        });
    }
}
