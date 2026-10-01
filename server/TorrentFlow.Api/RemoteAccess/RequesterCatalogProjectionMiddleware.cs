using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using TorrentFlow.Api.Requests;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>
/// For requester principals on catalog endpoints: strip owner-only engine/path/torrent fields and annotate the
/// caller's own request state. Owner responses pass through unchanged (same bytes the action wrote).
/// </summary>
public sealed class RequesterCatalogProjectionMiddleware(RequestDelegate next)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        // Keep null requestStatus/requestId so the UI can distinguish "unknown" from "omitted".
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private static readonly HashSet<string> ForbiddenNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "magnet", "magneturi", "infohash", "hash", "path", "filepath", "savepath", "folder", "folders",
        "releases", "torrents", "candidates", "trackers", "streamurl", "progress", "progressfraction",
        "downloadfraction", "resume", "transfer", "transfers", "seasontransfers", "episodetransfers",
        "pack", "watchlistitemid", "acquisitiontargetid", "file", "peers", "seeders", "speed",
        "torrentstatus", "playable", "streamable", "canstream", "canstreamtransfer",
    };

    public async Task InvokeAsync(HttpContext context, MediaRequestService requests)
    {
        if (!RemoteAccessClaims.IsRequester(context.User) || !IsCatalogPath(context.Request.Method, context.Request.Path))
        {
            await next(context);
            return;
        }

        var original = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next(context);
            if (buffer.Length == 0 || context.Response.StatusCode is < 200 or >= 300)
            {
                buffer.Position = 0;
                context.Response.Body = original;
                if (buffer.Length > 0) await buffer.CopyToAsync(original, context.RequestAborted);
                return;
            }

            buffer.Position = 0;
            JsonNode? root;
            try { root = await JsonNode.ParseAsync(buffer, cancellationToken: context.RequestAborted); }
            catch (JsonException)
            {
                buffer.Position = 0;
                context.Response.Body = original;
                await buffer.CopyToAsync(original, context.RequestAborted);
                return;
            }

            if (root is null)
            {
                context.Response.Body = original;
                return;
            }

            var userId = RemoteAccessClaims.UserIdOf(context.User) ?? "";
            var path = context.Request.Path.Value ?? "";
            if (path.Contains("/search/titles", StringComparison.OrdinalIgnoreCase))
                root = await ProjectSearchAsync(root, userId, requests, context.RequestAborted);
            else if (IsTitleDetailPath(path))
                root = await ProjectTitleDetailAsync(root, userId, requests, context.RequestAborted);
            else if (path.StartsWith("/api/browse", StringComparison.OrdinalIgnoreCase))
                root = StripForbidden(ProjectBrowse(root));
            else
                root = StripForbidden(root);

            var bytes = Encoding.UTF8.GetBytes(root.ToJsonString(JsonOptions));
            context.Response.Body = original;
            context.Response.ContentLength = bytes.Length;
            context.Response.ContentType = "application/json; charset=utf-8";
            await original.WriteAsync(bytes, context.RequestAborted);
        }
        finally
        {
            context.Response.Body = original;
        }
    }

    private static bool IsCatalogPath(string method, PathString path)
    {
        var m = method.ToUpperInvariant();
        if (m is not ("GET" or "HEAD" or "POST")) return false;
        var p = path.Value ?? "";
        if (m == "POST") return p.Equals("/api/artwork", StringComparison.OrdinalIgnoreCase);
        return p.StartsWith("/api/search/titles", StringComparison.OrdinalIgnoreCase)
            || p.StartsWith("/api/suggest", StringComparison.OrdinalIgnoreCase)
            || p.StartsWith("/api/browse", StringComparison.OrdinalIgnoreCase)
            || p.StartsWith("/api/recommendations", StringComparison.OrdinalIgnoreCase)
            || (p.StartsWith("/api/title/", StringComparison.OrdinalIgnoreCase)
                && !p.Contains("/progress", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsTitleDetailPath(string path)
    {
        // /api/title/{workKey} exactly — not /extras or /progress
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 3
            && parts[0].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[1].Equals("title", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<JsonNode> ProjectSearchAsync(JsonNode root, string userId, MediaRequestService requests, CancellationToken ct)
    {
        if (root is not JsonObject obj || obj["results"] is not JsonArray results) return StripForbidden(root);

        var keys = new List<(string WorkKey, string MediaType, string? ProviderId, string Provider)>();
        foreach (var item in results.OfType<JsonObject>())
        {
            keys.Add((
                item["workKey"]?.GetValue<string>() ?? item["key"]?.GetValue<string>() ?? "",
                item["mediaType"]?.GetValue<string>() ?? "movie",
                item["providerId"]?.GetValue<string>(),
                item["provider"]?.GetValue<string>() ?? "tmdb"));
        }

        var states = await requests.AnnotateCatalogAsync(userId, keys, ct);
        var projectedResults = new JsonArray();
        for (var i = 0; i < results.Count; i++)
        {
            if (results[i] is not JsonObject item)
            {
                projectedResults.Add(results[i]?.DeepClone());
                continue;
            }
            var state = i < states.Count ? states[i] : new CatalogRequestState(false, null, null);
            projectedResults.Add(ProjectSearchItem(item, state));
        }
        obj["results"] = projectedResults;
        return StripForbidden(obj);
    }

    private static JsonObject ProjectSearchItem(JsonObject item, CatalogRequestState state)
    {
        // Explicit allow-list of catalog fields — never pass through unknown owner-only keys.
        string[] keep =
        [
            "workKey", "title", "year", "category", "provider", "providerId", "aliases", "mediaType",
            "titleMediaType", "isSeries", "format", "posterUrl", "overview", "releaseDate", "href", "externalIds",
        ];
        var next = new JsonObject();
        foreach (var name in keep)
        {
            if (item.TryGetPropertyValue(name, out var value) && value is not null)
                next[name] = value.DeepClone();
        }
        AddState(next, state);
        return next;
    }

    /// <summary>The caller's own state for one title: the derived request phase and counts, never transfer detail.</summary>
    private static void AddState(JsonObject next, CatalogRequestState state)
    {
        next["inLibrary"] = state.InLibrary;
        next["requestStatus"] = state.RequestStatus is null ? null : JsonValue.Create(state.RequestStatus);
        next["requestId"] = state.RequestId is null ? null : JsonValue.Create(state.RequestId);
        next["availableSeasons"] = new JsonArray((state.AvailableSeasons ?? []).Select(s => (JsonNode?)JsonValue.Create(s)).ToArray());
        next["requestDone"] = state.Done;
        next["requestTotal"] = state.Total;
    }

    /// <summary>
    /// Browse cards for a requester: a card is either in the library ("ready") or not. The owner's file quality and
    /// episode counts (the Downloaded rail's subtitle) and the indexer check states never reach them.
    /// </summary>
    private static JsonNode ProjectBrowse(JsonNode root)
    {
        foreach (var rail in (root["rails"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var downloaded = string.Equals(rail["id"]?.GetValue<string>(), TorrentFlow.Metadata.Browse.BrowseService.YourLibraryRailId,
                StringComparison.Ordinal);
            foreach (var item in (rail["items"] as JsonArray ?? []).OfType<JsonObject>())
            {
                if (downloaded) item["subtitle"] = null;
                if (item["availability"]?.GetValue<string>() is not "ready") item["availability"] = null;
            }
        }
        return root;
    }

    private static async Task<JsonNode> ProjectTitleDetailAsync(JsonNode root, string userId, MediaRequestService requests, CancellationToken ct)
    {
        if (root is not JsonObject obj) return StripForbidden(root);

        var workKey = obj["workKey"]?.GetValue<string>() ?? "";
        var mediaType = obj["mediaType"]?.GetValue<string>() ?? ((obj["isSeries"]?.GetValue<bool>() ?? false) ? "tv" : "movie");
        // The title payload names the one provider identity the page requests with (TitleService.Detail).
        var provider = obj["provider"]?.GetValue<string>() ?? "";
        var providerId = obj["providerId"]?.GetValue<string>();

        var state = (await requests.AnnotateCatalogAsync(userId, [(workKey, mediaType, providerId, provider)], ct)).FirstOrDefault()
            ?? new CatalogRequestState(false, null, null);

        var next = new JsonObject
        {
            ["workKey"] = workKey,
            ["title"] = obj["title"]?.DeepClone(),
            ["aliases"] = obj["aliases"]?.DeepClone() ?? new JsonArray(),
            ["provider"] = obj["provider"]?.DeepClone(),
            ["providerId"] = obj["providerId"]?.DeepClone(),
            ["year"] = obj["year"]?.DeepClone(),
            ["mediaType"] = obj["mediaType"]?.DeepClone(),
            ["isSeries"] = obj["isSeries"]?.DeepClone(),
            ["overview"] = obj["overview"]?.DeepClone(),
            ["rating"] = obj["rating"]?.DeepClone(),
            ["ratingSource"] = obj["ratingSource"]?.DeepClone(),
            ["posterUrl"] = obj["posterUrl"]?.DeepClone(),
            ["backdropUrl"] = obj["backdropUrl"]?.DeepClone(),
            ["releaseDate"] = obj["releaseDate"]?.DeepClone(),
            ["season"] = obj["season"]?.DeepClone(),
            ["episodesTruncated"] = obj["episodesTruncated"]?.DeepClone(),
            ["known"] = obj["known"]?.DeepClone(),
            ["generatedAt"] = obj["generatedAt"]?.DeepClone(),
        };
        AddState(next, state);

        if (obj["seasons"] is JsonArray seasons)
        {
            var projected = new JsonArray();
            foreach (var s in seasons.OfType<JsonObject>())
            {
                projected.Add(new JsonObject
                {
                    ["season"] = s["season"]?.DeepClone(),
                    ["knownEpisodes"] = s["knownEpisodes"]?.DeepClone(),
                    ["downloadedEpisodes"] = s["downloadedEpisodes"]?.DeepClone(),
                });
            }
            next["seasons"] = projected;
        }

        if (obj["episodes"] is JsonArray episodes)
        {
            var projected = new JsonArray();
            foreach (var e in episodes.OfType<JsonObject>())
            {
                var availability = e["availability"]?.GetValue<string>();
                var available = string.Equals(availability, "ready", StringComparison.OrdinalIgnoreCase);
                projected.Add(new JsonObject
                {
                    ["season"] = e["season"]?.DeepClone(),
                    ["episode"] = e["episode"]?.DeepClone(),
                    ["label"] = e["label"]?.DeepClone(),
                    ["available"] = available,
                    // Role-aware redaction of the owner's transfer: the plain state only, never its queue position or wait reason.
                    ["state"] = (e["transfer"] as JsonObject)?["state"]?.DeepClone(),
                });
            }
            next["episodes"] = projected;
        }

        return next;
    }

    private static JsonNode StripForbidden(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
            {
                var keys = obj.Select(p => p.Key).ToList();
                foreach (var key in keys)
                {
                    if (ForbiddenNames.Contains(key) || IsForbiddenName(key))
                    {
                        obj.Remove(key);
                        continue;
                    }
                    if (obj[key] is JsonValue value && value.TryGetValue<string>(out var s) && LooksSensitive(s))
                        obj[key] = null;
                    else if (obj[key] is { } child)
                        StripForbidden(child); // mutate in place — reassigning the same node throws
                }
                return obj;
            }
            case JsonArray arr:
            {
                for (var i = 0; i < arr.Count; i++)
                {
                    if (arr[i] is JsonValue value && value.TryGetValue<string>(out var s) && LooksSensitive(s))
                        arr[i] = null;
                    else if (arr[i] is { } child)
                        StripForbidden(child);
                }
                return arr;
            }
            default:
                return node;
        }
    }

    private static bool IsForbiddenName(string key) =>
        key.Contains("magnet", StringComparison.OrdinalIgnoreCase)
        || key.Contains("infoHash", StringComparison.OrdinalIgnoreCase)
        || key.EndsWith("Path", StringComparison.OrdinalIgnoreCase)
        || key.Equals("hash", StringComparison.OrdinalIgnoreCase);

    private static bool LooksSensitive(string s)
    {
        if (s.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase)) return true;
        if (s.Length >= 3 && (s[1] == ':' && s[2] == '\\')) return true; // Windows path
        if (s.StartsWith('/') && s.Contains('/') && (s.Contains('.') || s.Contains("home", StringComparison.OrdinalIgnoreCase)))
        {
            // Unix-ish media paths; keep plain URLs and SPA hrefs.
            if (s.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return false;
            if (s.StartsWith("/title", StringComparison.OrdinalIgnoreCase) || s.StartsWith("/api", StringComparison.OrdinalIgnoreCase)) return false;
            if (s.Contains("/media", StringComparison.OrdinalIgnoreCase) || s.Contains("/downloads", StringComparison.OrdinalIgnoreCase)
                || s.EndsWith(".mkv", StringComparison.OrdinalIgnoreCase) || s.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }
}
