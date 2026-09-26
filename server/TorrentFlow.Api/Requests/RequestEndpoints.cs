using System.Text.Json;
using TorrentFlow.Api.RemoteAccess;
using TorrentFlow.Metadata;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Api.Requests;

/// <summary>
/// <c>/api/requester/*</c> is the only API a requester can reach (besides <c>/api/me</c>, <c>/api/health</c> and
/// <c>/api/features</c>); <c>/api/requests</c> is the owner's read-only list.
/// </summary>
public static class RequestEndpoints
{
    private const int MaxBodyBytes = 16 * 1024;

    public static IEndpointRouteBuilder MapRequestEndpoints(this IEndpointRouteBuilder app)
    {
        var requester = app.MapGroup("/api/requester").AllowRequesters().AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            http.Response.Headers.CacheControl = "no-store";
            if (!RemoteAccessClaims.IsRequester(http.User) || RemoteAccessClaims.UserIdOf(http.User) is null)
                return Error(403, "Only people you share TorrentFlow with use these; the owner adds titles directly.", "requester_only");
            return await next(context);
        });

        requester.MapGet("/titles", async (HttpContext http, MediaRequestService service, RateLimiter limiter, string? q, string? category) =>
        {
            if (!limiter.Allow($"requester-search:{EmailOf(http)}", service.Options.SearchesPerMinute))
                return Error(429, "Too many searches. Wait a minute and try again.", "rate_limited");
            var query = q?.Trim() ?? "";
            if (query.Length == 0) return Error(400, "Type a title to search for.");
            if (query.Length > 200) return Error(400, "That search is too long.");
            try
            {
                var (results, partial) = await service.SearchAsync(UserIdOf(http), WorkSearchService.ParseScope(category), query, http.RequestAborted);
                return Results.Json(new { results, partial });
            }
            catch (Exception) when (!http.RequestAborted.IsCancellationRequested)
            {
                return Error(502, "Title search isn't available right now. Try again in a moment.", "search_failed");
            }
        });

        requester.MapGet("/seasons", async (HttpContext http, MediaRequestService service, RateLimiter limiter,
            string? provider, string? providerId, string? mediaType, string? title, int? year) =>
        {
            if (!limiter.Allow($"requester-search:{EmailOf(http)}", service.Options.SearchesPerMinute))
                return Error(429, "Too many lookups. Wait a minute and try again.", "rate_limited");
            var (work, problem) = RequestRules.Validate(provider, providerId, mediaType, title, year, null, MediaRequestScope.Series, null, null);
            if (problem is not null) return Error(400, problem);
            try
            {
                var seasons = await service.SeasonsAsync(work!, http.RequestAborted);
                return Results.Json(new { seasons });
            }
            catch (Exception) when (!http.RequestAborted.IsCancellationRequested)
            {
                return Error(502, "The season list isn't available right now. Ask for the whole series, or try again.", "seasons_failed");
            }
        });

        requester.MapGet("/requests", async (HttpContext http, MediaRequestService service) =>
            Results.Json(new { requests = await service.MineAsync(UserIdOf(http), http.RequestAborted) }));

        requester.MapPost("/requests", async (HttpContext http, MediaRequestService service, RateLimiter limiter, Microsoft.Extensions.Options.IOptions<MetadataOptions> metadata) =>
        {
            if (!limiter.Allow($"requester-create:{EmailOf(http)}", service.Options.CreatesPerMinute))
                return Error(429, "You're sending requests too quickly. Wait a minute and try again.", "rate_limited");
            var (body, readError) = await ReadObjectAsync(http);
            if (readError is not null) return readError;
            var (fields, fieldError) = CreateFields.Parse(body);
            if (fieldError is not null) return Error(400, fieldError);
            var tmdbImageHost = Uri.TryCreate(metadata.Value.TmdbImageBaseUrl, UriKind.Absolute, out var img) ? img.Host : null;
            var (draft, problem) = RequestRules.Validate(fields!.Provider, fields.ProviderId, fields.MediaType, fields.Title, fields.Year,
                fields.PosterUrl, fields.Scope, fields.Seasons, fields.Note, tmdbImageHost);
            if (problem is not null) return Error(400, problem);
            var (outcome, created) = await service.CreateAsync(UserIdOf(http), draft!, http.RequestAborted);
            return outcome switch
            {
                CreateOutcome.Created => Results.Json(new { request = created }, statusCode: 201),
                CreateOutcome.InLibrary => Error(409, $"{draft!.Title} is already in the library.", "in_library"),
                CreateOutcome.Duplicate => Error(409, "You've already asked for this.", "duplicate"),
                CreateOutcome.TooManyOpen => Error(409, $"You have {service.Options.MaxOpenPerUser} open requests. Wait for some to be handled, or cancel one.", "too_many_open"),
                _ => throw new InvalidOperationException($"Unhandled create outcome {outcome}"),
            };
        });

        requester.MapPost("/requests/{id}/cancel", async (HttpContext http, MediaRequestService service, string id) =>
        {
            if (id.Length > 64) return Error(404, "Request not found.", "not_found");
            var (found, cancelled, request) = await service.CancelAsync(UserIdOf(http), id, http.RequestAborted);
            if (!found) return Error(404, "Request not found.", "not_found");
            if (!cancelled) return Error(409, "Only a request that is still waiting can be cancelled.", "not_pending");
            return Results.Json(new { request });
        });

        // Owner only: carries no requester metadata, so the authorization layer refuses requesters.
        app.MapGet("/api/requests", async (HttpContext http, MediaRequestService service, string? status) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            var wanted = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
            if (wanted is not null && !MediaRequestStatus.All.Contains(wanted))
                return Error(400, "status must be one of " + string.Join(", ", MediaRequestStatus.All));
            var requests = await service.AllAsync(wanted, http.RequestAborted);
            return Results.Json(new { requests, pendingCount = await service.PendingCountAsync(http.RequestAborted) });
        });

        return app;
    }

    private static string UserIdOf(HttpContext http) => RemoteAccessClaims.UserIdOf(http.User)!;

    private static string EmailOf(HttpContext http) => http.User.FindFirst(RemoteAccessClaims.Email)?.Value ?? "unknown";

    private static IResult Error(int status, string message, string? code = null) =>
        Results.Json(new { error = message, code }, statusCode: status);

    private static async Task<(JsonElement Body, IResult? Error)> ReadObjectAsync(HttpContext http)
    {
        if (http.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true)
            return (default, Error(415, "Content-Type must be application/json"));
        if (http.Request.ContentLength > MaxBodyBytes) return (default, Error(413, "Request body is too large"));
        try
        {
            var buffer = new byte[MaxBodyBytes + 1];
            var length = 0;
            int read;
            while (length < buffer.Length && (read = await http.Request.Body.ReadAsync(buffer.AsMemory(length), http.RequestAborted)) > 0)
                length += read;
            if (length > MaxBodyBytes) return (default, Error(413, "Request body is too large"));
            if (length == 0) return (default, Error(400, "JSON body is required"));
            using var doc = JsonDocument.Parse(buffer.AsMemory(0, length));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return (default, Error(400, "JSON body must be an object"));
            return (doc.RootElement.Clone(), null);
        }
        catch (JsonException) { return (default, Error(400, "Request body is not valid JSON")); }
        catch (Exception ex) when (ex is IOException or BadHttpRequestException && !http.RequestAborted.IsCancellationRequested)
        {
            return (default, Error(400, "The request body could not be read"));
        }
    }

    private sealed record CreateFields(string? Provider, string? ProviderId, string? MediaType, string? Title, int? Year,
        string? PosterUrl, string? Scope, List<int>? Seasons, string? Note)
    {
        public static (CreateFields? Fields, string? Error) Parse(JsonElement body)
        {
            string? provider = null, providerId = null, mediaType = null, title = null, poster = null, scope = null, note = null;
            int? year = null;
            List<int>? seasons = null;
            foreach (var p in body.EnumerateObject())
            {
                var v = p.Value;
                switch (p.Name)
                {
                    case "provider": if (!Str(v, out provider)) return (null, "provider must be a string"); break;
                    case "providerId":
                        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) providerId = n.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        else if (!Str(v, out providerId)) return (null, "providerId must be a string");
                        break;
                    case "mediaType": if (!Str(v, out mediaType)) return (null, "mediaType must be a string"); break;
                    case "title": if (!Str(v, out title)) return (null, "title must be a string"); break;
                    case "posterUrl": if (!Str(v, out poster)) return (null, "posterUrl must be a string"); break;
                    case "scope": if (!Str(v, out scope)) return (null, "scope must be a string"); break;
                    case "note": if (!Str(v, out note)) return (null, "note must be a string"); break;
                    case "year":
                        if (v.ValueKind == JsonValueKind.Null) break;
                        if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var y)) return (null, "year must be a whole number");
                        year = y;
                        break;
                    case "seasons":
                        if (v.ValueKind == JsonValueKind.Null) break;
                        if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() > RequestRules.MaxSeasons) return (null, $"seasons must be a list of at most {RequestRules.MaxSeasons} numbers");
                        seasons = [];
                        foreach (var s in v.EnumerateArray())
                        {
                            if (s.ValueKind != JsonValueKind.Number || !s.TryGetInt32(out var season)) return (null, "seasons must contain whole numbers");
                            seasons.Add(season);
                        }
                        break;
                    default: return (null, $"Unknown field `{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}`");
                }
            }
            return (new CreateFields(provider, providerId, mediaType, title, year, poster, scope, seasons, note), null);
        }

        private static bool Str(JsonElement v, out string? value)
        {
            value = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return v.ValueKind is JsonValueKind.String or JsonValueKind.Null;
        }
    }
}
