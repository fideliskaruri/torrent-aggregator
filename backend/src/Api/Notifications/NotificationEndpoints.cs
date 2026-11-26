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
        group.MapGet("/unread-count", async (HttpContext http, NotificationRepository db, CancellationToken ct) =>
            Results.Json(new { unreadCount = await db.CountUnreadAsync(AccessIdentity.UserId(http), ct) }));
        group.MapGet("", async (HttpContext http, NotificationRepository db, int? limit, CancellationToken ct) =>
        {
            var user = AccessIdentity.UserId(http);
            var rows = await db.PageAsync(user, Math.Clamp(limit ?? 100, 1, 100), ct);
            static string? Key(NotificationRow row) => row.Link?.StartsWith("/title/", StringComparison.Ordinal) == true
                ? Uri.UnescapeDataString(row.Link[7..].Split('?', '#')[0]) : null;
            static string? Hash(NotificationRow row) => row.Link?.StartsWith("/downloads?hash=", StringComparison.Ordinal) == true
                ? Uri.UnescapeDataString(row.Link[16..].Split('&', '#')[0]).ToLowerInvariant() : null;
            var posters = await db.PostersAsync(rows.Select(Key).OfType<string>().Distinct().ToArray(),
                rows.Select(Hash).OfType<string>().Distinct().ToArray(), ct);
            return Results.Json(new { items = rows.Select(n => new NotificationView(n.Id, n.Kind, n.Title, n.Body,
                n.Link, n.CreatedAt, n.ReadAt, posters.GetValueOrDefault(Key(n) ?? "hash:" + Hash(n)))),
                unreadCount = await db.CountUnreadAsync(user, ct) }, CatalogProjection.Json);
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
