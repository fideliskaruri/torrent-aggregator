using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

public sealed record NotificationView(string Id, string Kind, string Title, string? Body, string? Link,
    DateTimeOffset CreatedAt, DateTimeOffset? ReadAt,
    string? PosterUrl);

public static class NotificationEndpoints
{
    public static void MapNotifications(this WebApplication app)
    {
        var group = app.MapGroup("/api/notifications");
        group.MapGet("", async (HttpContext http, NotificationRepository db, DownloadsApi downloads, int? limit, CancellationToken ct) =>
        {
            var user = AccessIdentity.UserId(http);
            var all = (await db.AllAsync<NotificationRow>(ct)).Where(n => n.UserId == user).ToArray();
            var works = (await db.AllAsync<WorkRow>(ct)).ToDictionary(w => w.WorkKey);
            var transfers = JsonSerializer.SerializeToElement(await downloads.ListAsync(ct), CatalogProjection.Json)
                .GetProperty("torrents").EnumerateArray().ToDictionary(
                    t => t.GetProperty("hash").GetString()!, t => t.GetProperty("posterUrl").GetString(),
                    StringComparer.OrdinalIgnoreCase);
            var rows = all.OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
                .Take(Math.Clamp(limit ?? 100, 1, 100));
            return Results.Json(new { items = rows.Select(n =>
            {
                var key = n.Link?.StartsWith("/title/", StringComparison.Ordinal) == true
                    ? Uri.UnescapeDataString(n.Link[7..].Split('?', '#')[0]) : null;
                var poster = key is not null && works.TryGetValue(key, out var w) ? w.PosterUrl : null;
                if (n.Link?.StartsWith("/downloads?hash=", StringComparison.Ordinal) == true)
                    poster = transfers.GetValueOrDefault(Uri.UnescapeDataString(n.Link[16..].Split('&', '#')[0]));
                return new NotificationView(n.Id, n.Kind, n.Title, n.Body, n.Link, n.CreatedAt, n.ReadAt, poster);
            }), unreadCount = all.Count(n => n.ReadAt is null) }, CatalogProjection.Json);
        });
        group.MapPost("/read/{id}", async (HttpContext h, NotificationRepository db, string id, CancellationToken ct) =>
            await db.ReadAsync(AccessIdentity.UserId(h), id, ct) > 0 ? Results.NoContent() : Results.NotFound());
        group.MapPost("/read-all", async (HttpContext h, NotificationRepository db, CancellationToken ct) =>
        {
            await db.ReadAsync(AccessIdentity.UserId(h), null, ct);
            return Results.NoContent();
        });
        group.MapPost("/unread/{id}", async (HttpContext h, NotificationRepository db, string id, CancellationToken ct) =>
            await db.UnreadAsync(AccessIdentity.UserId(h), id, ct) > 0 ? Results.NoContent() : Results.NotFound());
        group.MapDelete("", async (HttpContext h, NotificationRepository db, CancellationToken ct) =>
        {
            foreach (var row in (await db.AllAsync<NotificationRow>(ct)).Where(n => n.UserId == AccessIdentity.UserId(h)))
                await db.DeleteAsync(row, ct);
            return Results.NoContent();
        });
    }
}
