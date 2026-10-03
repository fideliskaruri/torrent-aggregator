using System.Text.Json;
using System.Text.Json.Nodes;

namespace TorrentFlow.Api.Access;

public sealed class RequesterCatalogGuard(RequestDelegate next)
{
    private static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
    {
        "magnet", "magneturi", "infohash", "hash", "path", "filepath", "savepath", "folder", "folders",
        "releases", "torrents", "candidates", "trackers", "streamurl", "progress", "progressfraction",
        "downloadfraction", "resume", "transfer", "transfers", "seasontransfers", "episodetransfers",
        "pack", "watchlistitemid", "acquisitiontargetid", "file", "peers", "seeders", "speed",
        "torrentstatus", "playable", "streamable", "canstream", "canstreamtransfer",
    };

    public async Task InvokeAsync(HttpContext http)
    {
        var path = http.Request.Path.Value ?? "";
        if (AccessIdentity.Role(http) != "requester" || !(path.StartsWith("/api/title/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/api/search/titles", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/api/suggest", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/api/browse", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/api/recommendations", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/api/artwork", StringComparison.OrdinalIgnoreCase)))
        { await next(http); return; }
        var original = http.Response.Body;
        await using var buffer = new MemoryStream();
        http.Response.Body = buffer;
        try
        {
            await next(http);
            buffer.Position = 0;
            if (buffer.Length == 0 || http.Response.StatusCode is < 200 or >= 300)
            {
                http.Response.Body = original;
                await buffer.CopyToAsync(original, http.RequestAborted);
                return;
            }
            // Fail closed: a successful catalog response must be parseable JSON before a requester sees it.
            var root = await JsonNode.ParseAsync(buffer, cancellationToken: http.RequestAborted);
            if (root is not null) Strip(root);
            http.Response.Body = original;
            http.Response.ContentLength = null;
            await http.Response.WriteAsJsonAsync(root, AccessState.Json, http.RequestAborted);
        }
        finally { http.Response.Body = original; }
    }

    private static void Strip(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Select(x => x.Key).ToArray())
            {
                if (Forbidden.Contains(key) || key.Contains("magnet", StringComparison.OrdinalIgnoreCase)
                    || key.Contains("infohash", StringComparison.OrdinalIgnoreCase)
                    || key.EndsWith("Path", StringComparison.OrdinalIgnoreCase))
                    obj.Remove(key);
                else if (obj[key] is JsonValue value && value.TryGetValue<string>(out var text) && Sensitive(text))
                    obj[key] = null;
                else if (obj[key] is { } child) Strip(child);
            }
        }
        else if (node is JsonArray array)
        {
            for (var i = 0; i < array.Count; i++)
                if (array[i] is JsonValue value && value.TryGetValue<string>(out var text) && Sensitive(text)) array[i] = null;
                else if (array[i] is { } child) Strip(child);
        }
    }

    private static bool Sensitive(string text) => text.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase)
        || text.Length >= 3 && text[1] == ':' && text[2] == '\\'
        || text.StartsWith("\\\\", StringComparison.Ordinal)
        || text.StartsWith('/') && !text.StartsWith("/title", StringComparison.OrdinalIgnoreCase)
            && !text.StartsWith("/api", StringComparison.OrdinalIgnoreCase)
            && (text.Contains("/media", StringComparison.OrdinalIgnoreCase)
                || text.Contains("/downloads", StringComparison.OrdinalIgnoreCase)
                || text.EndsWith(".mkv", StringComparison.OrdinalIgnoreCase)
                || text.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase));
}
