using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevDownloadsEndpoints
{
    internal static void MapDevDownloads(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
            { Converters = { new JsonStringEnumConverter() } };
        var group = app.MapGroup("/api/dev/downloads").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidDataException)
            { return Results.BadRequest(new { error = "invalid_input", message = ex.Message }); }
            catch (InvalidOperationException ex)
            { return Results.Conflict(new { error = "download_conflict", message = ex.Message }); }
            catch (IOException ex)
            { return Results.Conflict(new { error = "file_busy", message = ex.Message }); }
        });
        group.MapGet("/", async (RawDownloads downloads, CancellationToken ct) =>
            Results.Json(await downloads.ReadAsync(ct), json));
        group.MapPost("/", async (RawDownloads.Input input, RawDownloads downloads, CancellationToken ct) =>
            Results.Json(await downloads.AddAsync(input, ct), json));
        group.MapPut("/settings", async (RawDownloads.SettingsInput input, RawDownloads downloads, CancellationToken ct) =>
            Results.Json(await downloads.SettingsAsync(input, ct), json));
        group.MapPut("/{hash}/order", async (string hash, RawDownloads.OrderInput input,
            RawDownloads downloads, CancellationToken ct) =>
            Results.Json(await downloads.OrderAsync(MonoTorrentEngine.NormalizeHash(hash), input, ct), json));
        group.MapDelete("/{hash}", async (string hash, bool? data, RawDownloads downloads, CancellationToken ct) =>
            Results.Json(await downloads.RemoveAsync(MonoTorrentEngine.NormalizeHash(hash), data == true, ct), json));
    }
}
