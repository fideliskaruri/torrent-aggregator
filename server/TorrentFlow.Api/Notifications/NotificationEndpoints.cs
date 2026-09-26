using System.Text.Json;
using TorrentFlow.Api.RemoteAccess;

namespace TorrentFlow.Api.Notifications;

public static class NotificationEndpoints
{
    public static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/notifications").AllowRequesters();
        group.AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            if (NotificationRecipient.Of(context.HttpContext) is null) return Results.Unauthorized();
            return await next(context);
        });
        group.MapGet("", async (HttpContext http, NotificationService service, int? limit) =>
            Results.Json(new
            {
                items = await service.ListAsync(NotificationRecipient.Of(http)!, limit ?? 100, http.RequestAborted),
                unreadCount = await service.UnreadCountAsync(NotificationRecipient.Of(http)!, http.RequestAborted),
            }));
        group.MapPost("/read/{id}", async (HttpContext http, NotificationService service, string id) =>
            await service.MarkReadAsync(NotificationRecipient.Of(http)!, id, http.RequestAborted)
                ? Results.NoContent() : Results.NotFound());
        group.MapPost("/read-all", async (HttpContext http, NotificationService service) =>
        {
            await service.MarkAllReadAsync(NotificationRecipient.Of(http)!, http.RequestAborted);
            return Results.NoContent();
        });
        group.MapGet("/push/public-key", (VapidKeyStore keys) => Results.Json(new { publicKey = keys.Keys.PublicKey }));
        group.MapPost("/push/subscription", async (HttpContext http, NotificationService service) =>
        {
            var body = await ReadInputAsync(http);
            if (body is null || !ValidSubscription(body)) return Results.BadRequest(new { error = "Invalid browser push subscription." });
            await service.SubscribeAsync(NotificationRecipient.Of(http)!, body, http.RequestAborted);
            return Results.NoContent();
        });
        group.MapDelete("/push/subscription", async (HttpContext http, NotificationService service) =>
        {
            var body = await ReadInputAsync(http);
            if (body is null || string.IsNullOrWhiteSpace(body.Endpoint)) return Results.BadRequest();
            await service.UnsubscribeAsync(NotificationRecipient.Of(http)!, body.Endpoint, http.RequestAborted);
            return Results.NoContent();
        });
        return app;
    }

    private static async Task<PushSubscriptionInput?> ReadInputAsync(HttpContext http)
    {
        if (!http.Request.HasJsonContentType()) return null;
        var buffer = new byte[8193];
        var length = 0;
        while (length < buffer.Length)
        {
            var read = await http.Request.Body.ReadAsync(buffer.AsMemory(length), http.RequestAborted);
            if (read == 0) break;
            length += read;
        }
        if (length == 0 || length > 8192) return null;
        try { return JsonSerializer.Deserialize<PushSubscriptionInput>(buffer.AsSpan(0, length), new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
        catch (JsonException) { return null; }
    }

    internal static bool ValidSubscription(PushSubscriptionInput input) =>
        ValidEndpoint(input.Endpoint) && ValidKey(input.P256dh, 65) && ValidKey(input.Auth, 16);

    // Capability URLs come from browsers, not arbitrary user-selected HTTP servers.
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

    private static bool ValidKey(string? key, int length)
    {
        if (string.IsNullOrEmpty(key) || key.Length > 100) return false;
        try
        {
            var normalized = key.Replace('-', '+').Replace('_', '/');
            var bytes = Convert.FromBase64String(normalized.PadRight((normalized.Length + 3) / 4 * 4, '='));
            return bytes.Length == length && (length != 65 || bytes[0] == 4);
        }
        catch (FormatException) { return false; }
    }
}
