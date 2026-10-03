using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;

namespace TorrentFlow.Api;

internal static class DevFind
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { Converters = { new JsonStringEnumConverter() } };
    private static readonly ConcurrentDictionary<string, Channel<SearchFeedback>> Sessions = new();

    internal static void MapDevFind(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        app.MapGet("/api/dev/find", SearchAsync);
        app.MapPost("/api/dev/find/{sessionId}/feedback", async (string sessionId, HttpContext http, CancellationToken ct) =>
        {
            if (!Owner(http)) return Results.StatusCode(403);
            if (!Sessions.TryGetValue(sessionId, out var channel)) return Results.NotFound();
            if (http.Request.ContentLength is null or > 65536) return Results.BadRequest();
            SearchFeedback? feedback;
            try { feedback = await http.Request.ReadFromJsonAsync<SearchFeedback>(ct); }
            catch (JsonException) { return Results.BadRequest(); }
            return feedback is not null && channel.Writer.TryWrite(feedback) ? Results.Accepted() : Results.BadRequest();
        });
    }

    private static async Task<IResult> SearchAsync(HttpContext http, IMetadata metadata, IFind find,
        DiscoveryPlan discovery, CancellationToken ct)
    {
        if (!Owner(http)) return Results.StatusCode(403);
        var key = http.Request.Query["workKey"].ToString();
        var lane = http.Request.Query["lane"].ToString();
        var seasonText = http.Request.Query["season"].ToString();
        var episodeText = http.Request.Query["episode"].ToString();
        var exhaustText = http.Request.Query["exhaust"].ToString();
        int? season = int.TryParse(seasonText, out var s) ? s : null;
        int? episode = int.TryParse(episodeText, out var e) ? e : null;
        if (key.Length is < 1 or > 200 || lane is not ("" or "owner" or "background") ||
            exhaustText is not ("" or "true" or "false") ||
            seasonText.Length > 0 && (season is null or < 0 or > 999) ||
            episodeText.Length > 0 && (episode is null or < 1 or > 99999) ||
            episode is not null && season is null)
            return Results.BadRequest(new { error = "invalid_scope", message = "Provide workKey and a valid season/episode scope." });
        var total = Stopwatch.StartNew();
        var resolved = await metadata.GetWorkAsync(key, false, ct);
        if (resolved.Work is not { } work)
            return Results.Json(new { error = resolved.Failure?.Code ?? "not_found",
                message = resolved.Failure?.Message ?? "Search for this title in the catalog first." }, statusCode: 404);
        var film = work.Work.Kind == WorkKind.Film;
        if (film && (season is not null || episode is not null) || !film && season is null)
            return Results.BadRequest(new { error = "invalid_scope", message = "Films have no season; series need a season." });
        var seasonRow = work.Seasons.FirstOrDefault(row => row.Number == season);
        var episodes = work.Episodes.Where(row => row.SeasonId == seasonRow?.Id &&
            (episode is null || row.Number == episode)).ToImmutableArray();
        if (!film && (seasonRow is null || seasonRow.MappingStatus != MappingStatus.Confirmed || episodes.IsEmpty ||
            episodes.Any(row => row.MappingStatus != MappingStatus.Confirmed)))
            return Results.Json(new { error = "numbering_unconfirmed",
                message = "The catalog has not confirmed this season's episode numbering. Refresh the title before searching." }, statusCode: 409);
        var metadataMs = total.Elapsed.TotalMilliseconds;
        var scope = new TargetScope(work.Work.Id, [.. episodes.Select(row => row.Id)], film);
        var stream = http.Request.Query["stream"] == "true";
        var suppliedFeedback = http.Request.Query["feedback"] == "true";
        var exhaust = exhaustText == "true";
        var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope,
            new(null, null, null, null, null, 0), lane == "background" ? PriorityLane.Background : PriorityLane.Owner,
            SearchNamePhase.English, [], 0, 0)
            { Exhaust = exhaust };
        CandidateBatch? last = null;
        if (suppliedFeedback && !stream) return Results.BadRequest(new { error = "feedback_requires_stream" });
        if (stream) http.Response.ContentType = "application/x-ndjson";
        var channel = suppliedFeedback ? Channel.CreateBounded<SearchFeedback>(128) : null;
        if (channel is not null) Sessions[request.SessionId] = channel;
        try
        {
            if (!suppliedFeedback)
            {
                var measured = await discovery.RunAsync(work, scope, request.Policy, request.Lane, exhaust, ct,
                    stream ? WriteBatch : null);
                last = measured.Find;
            }
            else
            {
                await foreach (var batch in find.SearchAsync(request, channel!.Reader.ReadAllAsync(ct), ct))
                {
                    last = batch;
                    await WriteBatch(batch);
                }
            }
        }
        finally
        {
            Sessions.TryRemove(request.SessionId, out _);
            channel?.Writer.TryComplete();
        }
        return stream ? Results.Empty : Results.Json(new
        {
            workKey = work.Work.WorkKey, workId = work.Work.Id, names = work.Names.Select(n => new { n.Value, n.Label }),
            scope, result = last is null ? null : Project(last),
            timings = new { metadataMs, firstCandidateMs = last?.FirstCandidateAt?.TotalMilliseconds,
                findCompleteMs = last?.Elapsed.TotalMilliseconds, totalMs = total.Elapsed.TotalMilliseconds },
            cacheHit = last?.Queries.Any(q => q.CacheHit) == true,
            allCacheHit = last?.Queries.Length > 0 && last.Queries.All(q => q.CacheHit),
            sharedInFlight = last?.Queries.Any(q => q.SharedInFlight) == true,
            sourceRequests = last?.SourceRequests, windowSourceRequests = last?.WindowSourceRequests,
            requestLimit = last?.RequestLimit, cachedPool = last?.CachedPool,
            health = suppliedFeedback ? "Check and Plan eligibility is supplied by the diagnostic caller."
                : "Measured by Check and gated by Plan. Only preferred Good coverage stops later tiers."
        }, Json);

        async Task WriteBatch(CandidateBatch batch)
        {
            await http.Response.WriteAsync(JsonSerializer.Serialize(Project(batch), Json) + "\n", ct);
            await http.Response.Body.FlushAsync(ct);
        }
    }

    private static object Project(CandidateBatch batch) => new
    {
        batch.SessionId, batch.PoolRevision, batch.Complete, batch.NamePhase, batch.Tier,
        batch.EarlyStopped, batch.EnglishLabelMissing, firstCandidateMs = batch.FirstCandidateAt?.TotalMilliseconds,
        batch.ProvisionalStopped, batch.CachedPool, batch.SourceRequests, batch.WindowSourceRequests,
        batch.RequestLimit, batch.RequestBudgetExhausted,
        elapsedMs = batch.Elapsed.TotalMilliseconds,
        candidates = batch.Candidates.OrderByDescending(c => c.TrustedSeeders ?? -1).Select(c => new
        {
            hash = c.Release.Id, name = c.Release.Name, parse = c.Release.Parsed,
            sources = c.Observations.Select(o => new { o.SourceId, o.Query, o.ListedSeeders, o.ListedLeechers, o.UploadedAt }),
            trustedSeeds = c.TrustedSeeders, c.ConservativeListedSeeders, c.ScrapedSeeders, bytes = c.Release.TotalBytes,
            coverage = new { c.CoversFilm, episodeIds = c.CoveredEpisodeIds }
        }),
        batch.Rejections,
        queries = batch.Queries.Select(q => new
        {
            q.Query, q.SourceId, q.NamePhase, q.Tier, q.CacheHit, q.SharedInFlight,
            q.Result.Outcome, q.Result.Complete, q.Result.Error, q.Result.RetryAt,
            elapsedMs = q.Result.Elapsed.TotalMilliseconds, returned = q.Result.Results.Length, q.Result.Diagnostics
        }),
        cacheHit = batch.Queries.Any(q => q.CacheHit),
        allCacheHit = batch.Queries.Length > 0 && batch.Queries.All(q => q.CacheHit),
        sharedInFlight = batch.Queries.Any(q => q.SharedInFlight)
    };

    internal static bool Owner(HttpContext http)
    {
        var actor = AccessIdentity.Actor(http);
        return actor.Role == UserRole.Owner && actor.TrustedLocal &&
            http.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip);
    }

}
