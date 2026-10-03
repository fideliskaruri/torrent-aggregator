using System.Text.Json;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class TorrentSendEndpoints
{
    internal static void Map(RouteGroupBuilder group)
    {
        group.MapPost("/torrent/send", async (JsonElement input, HttpContext http,
            RawDownloads downloads, CancellationToken ct) =>
        {
            IResult Invalid(string message, string field) => Results.BadRequest(new
                { ok = false, error = message, message, field });
            if (input.ValueKind != JsonValueKind.Object) return Invalid("Provide a torrent or magnet.", "magnet");
            foreach (var (field, max) in new[] { ("magnet", 8192), ("torrentUrl", 2048),
                ("name", 500), ("infoHash", 64), ("target", 20), ("retention", 20), ("scope", 20) })
                if (input.TryGetProperty(field, out var value) && value.ValueKind != JsonValueKind.Null &&
                    (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > max))
                    return Invalid($"{field} must be a string of at most {max} characters.", field);
            string? Text(string key) => input.TryGetProperty(key, out var value) &&
                value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() : null;
            var target = Text("target") ?? "primary";
            if (target is not ("primary" or "external")) return Invalid("Choose primary or external.", "target");
            if (target == "external") return Results.BadRequest(new { ok = false, offline = false,
                error = "No external client", message = "Configure an external torrent client in Settings first." });
            var magnet = Text("magnet");
            var url = Text("torrentUrl");
            var hash = Text("infoHash");
            if (!string.IsNullOrEmpty(magnet))
            {
                try { _ = MonoTorrentEngine.NormalizeHash(magnet); }
                catch (Exception ex) when (ex is ArgumentException or FormatException)
                { return Invalid("magnet must contain a valid BitTorrent info hash.", "magnet"); }
            }
            if (!string.IsNullOrEmpty(hash))
            {
                try { hash = MonoTorrentEngine.NormalizeHash(hash); }
                catch (Exception ex) when (ex is ArgumentException or FormatException)
                { return Invalid("infoHash must contain a valid BitTorrent info hash.", "infoHash"); }
            }
            if (!string.IsNullOrEmpty(url) && (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                uri.Scheme is not ("http" or "https")))
                return Invalid("torrentUrl must use http or https.", "torrentUrl");
            if (Text("retention") is { } retention && retention is not ("keep" or "stream"))
                return Invalid("Choose keep or stream.", "retention");
            if (string.IsNullOrEmpty(magnet) && string.IsNullOrEmpty(url))
            {
                if (hash is not null && Text("retention") is "keep" or "stream")
                {
                    if (Text("scope") is "episode" or "season")
                        return Invalid("Episode and season downloads must use their title page.", "scope");
                    return Results.Ok(new { ok = true, message = "Kept in your library.",
                        clientType = "builtin", sendTarget = target, retentionState = "kept" });
                }
                return Invalid("magnet or torrentUrl is required (or infoHash with retention).", "magnet");
            }
            try
            {
                var now = input.TryGetProperty("forced", out var forced) && forced.ValueKind == JsonValueKind.True;
                var result = await downloads.SendAsync(magnet, url, Text("name"),
                    AccessIdentity.Actor(http).UserId, now, ct);
                return Results.Json(new { ok = result.Accepted,
                    message = result.Accepted ? "Added to downloads." : result.Failure?.Message,
                    offline = false, clientType = "builtin", sendTarget = target,
                    retentionState = "kept", hash = result.Snapshot?.Hash },
                    new JsonSerializerOptions(JsonSerializerDefaults.Web), statusCode: result.Accepted ? 200 : 502);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException ||
                ex is OperationCanceledException && !ct.IsCancellationRequested)
            {
                return Results.Json(new { ok = false, offline = false,
                    message = "The torrent could not be read. Check its link and the download folder, then try again." },
                    statusCode: 502);
            }
        });
    }
}
