using System.Text.Json;
using TorrentFlow.Requests;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

internal static class ActivityEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static void MapActivity(this WebApplication app)
    {
        app.MapGet("/api/activity", async (NotificationRepository db, string? filter, string? limit,
            string? cursor, CancellationToken ct) => Results.Json(
                await NotificationReadModels.PageAsync(db, filter, limit, cursor, ct), Json));
        app.MapGet("/api/activity/unread", async (NotificationRepository db, string? since,
            CancellationToken ct) => Results.Ok(
                await NotificationReadModels.UnreadCountAsync(db, since, ct)));
    }
}
