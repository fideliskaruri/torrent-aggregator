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
                    await http.Response.WriteAsync(JsonSerializer.Serialize(batch, options) + "\n", ct);
                    await http.Response.Body.FlushAsync(ct);
                }
                return Results.Empty;
            }
            return Results.Json(await sources.SearchAsync(id, query, ct), options);
        });
    }
}
