using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Notifications;

public sealed record PushSubscriptionInput(string? Endpoint, string? P256dh, string? Auth);
public sealed record NotificationView(string Id, string Kind, string Title, string? Body, string? Link,
    DateTimeOffset CreatedAt, DateTimeOffset? ReadAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PosterUrl);

public static class NotificationEndpoints
{
    public static void AddNotifications(this IServiceCollection services, string directory)
    {
        services.AddSingleton(new VapidKeyStore(directory));
        services.AddHttpClient("webpush", c => c.Timeout = TimeSpan.FromSeconds(10))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        services.AddSingleton<WebPushSender>();
        services.AddHostedService<NotificationWorker>();
    }

    public static void MapNotifications(this WebApplication app)
    {
        var group = app.MapGroup("/api/notifications");
        group.MapGet("", async (HttpContext http, NotificationRepository db, int? limit, CancellationToken ct) =>
        {
            var user = AccessIdentity.UserId(http);
            var all = (await db.AllAsync<NotificationRow>(ct)).Where(n => n.UserId == user).ToArray();
            var works = (await db.AllAsync<WorkRow>(ct)).ToDictionary(w => w.WorkKey);
            var rows = all.OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id)
                .Take(Math.Clamp(limit ?? 100, 1, 100));
            return Results.Json(new { items = rows.Select(n =>
            {
                var key = n.Link?.StartsWith("/title/", StringComparison.Ordinal) == true
                    ? Uri.UnescapeDataString(n.Link[7..].Split('?', '#')[0]) : null;
                return new NotificationView(n.Id, n.Kind, n.Title, n.Body, n.Link, n.CreatedAt, n.ReadAt,
                    key is not null && works.TryGetValue(key, out var w) ? w.PosterUrl : null);
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
        group.MapGet("/push/public-key", (VapidKeyStore keys) => Results.Ok(new { publicKey = keys.Keys.PublicKey }));
        group.MapPost("/push/subscription", async (HttpContext h, NotificationRepository db, CancellationToken ct) =>
        {
            var input = await InputAsync(h, ct);
            if (input is null || !ValidEndpoint(input.Endpoint) || !ValidKey(input.P256dh, 65) || !ValidKey(input.Auth, 16))
                return Results.BadRequest(new { error = "Invalid browser push subscription." });
            var user = AccessIdentity.UserId(h);
            await db.SubscribeAsync(new PushSubscriptionRow(Guid.NewGuid().ToString("N"), user,
                input.Endpoint!, input.P256dh!, input.Auth!, DateTimeOffset.UtcNow), ct);
            return Results.NoContent();
        });
        group.MapDelete("/push/subscription", async (HttpContext h, NotificationRepository db, CancellationToken ct) =>
        {
            var input = await InputAsync(h, ct);
            if (string.IsNullOrWhiteSpace(input?.Endpoint)) return Results.BadRequest();
            foreach (var row in (await db.AllAsync<PushSubscriptionRow>(ct)).Where(s =>
                s.UserId == AccessIdentity.UserId(h) && s.Endpoint == input.Endpoint)) await db.DeleteAsync(row, ct);
            return Results.NoContent();
        });
    }

    private static async Task<PushSubscriptionInput?> InputAsync(HttpContext http, CancellationToken ct)
    {
        if (!http.Request.HasJsonContentType()) return null;
        var bytes = new byte[8193];
        var length = 0;
        while (length < bytes.Length)
        {
            var read = await http.Request.Body.ReadAsync(bytes.AsMemory(length), ct);
            if (read == 0) break;
            length += read;
        }
        if (length is 0 or > 8192) return null;
        try { return JsonSerializer.Deserialize<PushSubscriptionInput>(bytes.AsSpan(0, length), new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
        catch (JsonException) { return null; }
    }

    internal static bool ValidEndpoint(string? endpoint)
    {
        if (endpoint is null || endpoint.Length > 2048 || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) return false;
        var host = uri.IdnHost;
        return host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com"
            || host.EndsWith(".push.services.mozilla.com", StringComparison.Ordinal)
            || host == "web.push.apple.com" || host.EndsWith(".web.push.apple.com", StringComparison.Ordinal)
            || host.EndsWith(".notify.windows.com", StringComparison.Ordinal);
    }

    private static bool ValidKey(string? key, int size)
    {
        if (string.IsNullOrEmpty(key) || key.Length > 100) return false;
        try
        {
            var normal = key.Replace('-', '+').Replace('_', '/');
            var bytes = Convert.FromBase64String(normal.PadRight((normal.Length + 3) / 4 * 4, '='));
            return bytes.Length == size && (size != 65 || bytes[0] == 4);
        }
        catch (FormatException) { return false; }
    }
}
