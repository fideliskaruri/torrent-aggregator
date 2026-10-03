using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevSources
{
    internal static IServiceCollection AddDevSources(this IServiceCollection services) => services.AddSourceModules();

    internal static void MapDevSources(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        app.MapGet("/api/dev/sources/search", async (HttpContext http, ISources sources, CancellationToken ct) =>
        {
            if (AccessIdentity.Actor(http).Role != UserRole.Owner ||
                !AccessIdentity.Actor(http).TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            var q = http.Request.Query["q"].ToString();
            var id = http.Request.Query["source"].ToString();
            var category = http.Request.Query["category"].ToString();
            var laneText = http.Request.Query["lane"].ToString();
            if (string.IsNullOrWhiteSpace(q) || q.Length > 512 || string.IsNullOrWhiteSpace(id) ||
                laneText is not ("" or "owner" or "background"))
                return Results.BadRequest(new { error = "invalid_query", message = "Provide q, source, and owner or background lane." });
            if (category.Length == 0) category = "all";
            var imdb = http.Request.Query["imdb"].ToString();
            var query = new SourceQuery(q, category, imdb.Length == 0 ? null : new("imdb", imdb, "series"),
                laneText == "background" ? PriorityLane.Background : PriorityLane.Owner, 80,
                DateTimeOffset.UtcNow.AddSeconds(6), 0, 0);
            var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            options.Converters.Add(new JsonStringEnumConverter());
            if (http.Request.Query["stream"] == "true")
            {
                http.Response.ContentType = "application/x-ndjson";
                await foreach (var batch in sources.SearchStreamAsync(id, query, ct))
                {
                    await http.Response.WriteAsync(JsonSerializer.Serialize(Public(batch), options) + "\n", ct);
                    await http.Response.Body.FlushAsync(ct);
                }
                return Results.Empty;
            }
            return Results.Json(Public(await sources.SearchAsync(id, query, ct)), options);
        });
    }

    private static SourceResult Public(SourceResult result) => result with
    {
        Results = [.. result.Results.Select(release => release with
        {
            Magnet = Redact(release.Magnet), TorrentUri = Redact(release.TorrentUri),
            SourceItemId = Redact(release.SourceItemId), WebSeeds = [.. release.WebSeeds.Select(s => Redact(s)!)]
        })]
    };

    private static string? Redact(string? uri, int depth = 0)
    {
        if (uri is null) return null;
        if (depth > 2) return "[redacted]";
        if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && parsed.UserInfo.Length > 0)
            uri = new UriBuilder(parsed) { UserName = "", Password = "" }.Uri.AbsoluteUri;
        var start = uri.IndexOf('?');
        if (start < 0) return uri;
        var parts = uri[(start + 1)..].Split('&');
        for (var i = 0; i < parts.Length; i++)
        {
            var split = parts[i].IndexOf('=');
            if (split < 0) continue;
            var key = Uri.UnescapeDataString(parts[i][..split]).ToLowerInvariant();
            if (key is "apikey" or "api_key" or "passkey" or "password" or "token")
                parts[i] = parts[i][..(split + 1)] + "%5Bredacted%5D";
            else if (key is "tr" or "ws")
                parts[i] = parts[i][..(split + 1)] + Uri.EscapeDataString(Redact(Uri.UnescapeDataString(parts[i][(split + 1)..]), depth + 1)!);
        }
        return uri[..(start + 1)] + string.Join('&', parts);
    }
}
