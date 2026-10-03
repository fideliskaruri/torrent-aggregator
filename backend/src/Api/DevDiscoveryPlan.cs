using System.Collections.Immutable;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevDiscoveryPlan
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };

    internal static void MapDevDiscoveryPlan(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        app.MapGet("/api/dev/plan", async (HttpContext http, IMetadata metadata,
            DiscoveryPlan discovery, [Microsoft.Extensions.DependencyInjection.FromKeyedServices("targets")] IStore store,
            CancellationToken ct) =>
        {
            if (!DevFind.Owner(http)) return Results.StatusCode(403);
            var query = http.Request.Query;
            var key = query["workKey"].ToString();
            if (key.Length == 0) key = query["workId"].ToString();
            var kind = query["kind"].ToString();
            var scopeName = query["scope"].ToString();
            var lane = query["lane"].ToString();
            var exhaust = query["exhaust"].ToString();
            int? Number(string name) => int.TryParse(query[name], out var n) ? n : null;
            var season = Number("season");
            var episode = Number("episode");
            var quality = Number("preferredQuality") ?? Number("quality") ?? 1080;
            var floor = Number("qualityFloor") ??
                (query.ContainsKey("preferredQuality") || query.ContainsKey("quality") ? quality : (int?)null);
            if (key.Length is < 1 or > 200 || lane is not ("" or "owner" or "background") ||
                kind is not ("" or "film" or "movie" or "series" or "anime") ||
                scopeName is not ("" or "film" or "season" or "episode") ||
                exhaust is not ("" or "true" or "false") || quality is < 1 or > 4320 ||
                floor is < 1 or > 4320 ||
                new[] { "season", "episode", "quality", "preferredQuality", "qualityFloor" }
                    .Any(name => query.ContainsKey(name) && Number(name) is null))
                return Results.BadRequest(new { error = "invalid_input", message = "Provide a work, scope, quality and owner or background lane." });
            var clock = Stopwatch.StartNew();
            var resolved = await metadata.GetWorkAsync(key, false, ct);
            if (resolved.Work is not { } work) return Results.NotFound(resolved.Failure);
            var film = work.Work.Kind == WorkKind.Film;
            if (film && (season is not null || episode is not null || scopeName is "season" or "episode" || kind == "series") ||
                !film && (season is null or < 0 or > 999 || scopeName == "film" || kind is "film" or "movie") ||
                episode is < 1 or > 99999 || scopeName == "episode" && episode is null ||
                scopeName == "season" && episode is not null)
                return Results.BadRequest(new { error = "invalid_scope", message = "Films have no season; series need a season and episodes need an episode number." });
            var seasonRow = work.Seasons.FirstOrDefault(s => s.Number == season);
            var episodes = work.Episodes.Where(e => e.SeasonId == seasonRow?.Id &&
                (episode is null || e.Number == episode)).ToImmutableArray();
            if (!film && (seasonRow?.MappingStatus != MappingStatus.Confirmed || episodes.IsEmpty ||
                episodes.Any(e => e.MappingStatus != MappingStatus.Confirmed)))
                return Results.Json(new { error = "numbering_unconfirmed",
                    message = "Refresh the catalog to confirm this season's episode numbering." }, statusCode: 409);
            var metadataMs = clock.Elapsed.TotalMilliseconds;
            var qualityRow = (await new CatalogState(store)
                .ReadAsync<SettingRow>(CatalogState.Query("quality"), ct)).SingleOrDefault();
            var audioLanguage = qualityRow is null ? "auto" :
                SettingsCatalog.Read<QualitySettings>(qualityRow).AudioLanguage ?? "auto";
            var result = await discovery.RunAsync(work, new(work.Work.Id, [.. episodes.Select(e => e.Id)], film),
                new(floor, quality, audioLanguage, null, null, 0),
                lane == "background" ? PriorityLane.Background : PriorityLane.Owner, exhaust == "true", ct);
            var evidence = result.Evidence.ToDictionary(e => e.Hash, StringComparer.OrdinalIgnoreCase);
            return Results.Json(new
            {
                workKey = work.Work.WorkKey, workId = work.Work.Id, kind = work.Work.Kind,
                scope = scopeName.Length > 0 ? scopeName : film ? "film" : episode is null ? "season" : "episode",
                lane = lane.Length == 0 ? "owner" : lane, preferredQuality = quality, qualityFloor = floor, audioLanguage,
                metadataMs, timeline = result.Timeline, totalMs = clock.Elapsed.TotalMilliseconds,
                sourceRequests = result.Find.SourceRequests, result.Find.WindowSourceRequests,
                result.Find.RequestLimit, result.Find.RequestBudgetExhausted, result.Find.EarlyStopped,
                result.Probes, result.Submissions, result.VerdictCacheHits,
                probeBudget = DiscoveryPlan.ProbeBudget, result.StopReason,
                result.Find.CachedPool,
                sourceCacheHits = result.Find.Queries.Count(q => q.CacheHit),
                verdictCounts = result.Evidence.GroupBy(e => e.Band).ToDictionary(g => g.Key.ToString(), g => g.Count()),
                targets = result.Targets.Select(t => new { t.Id, t.EpisodeId }),
                candidates = result.Find.Candidates.Select(c => new
                {
                    hash = c.Release.Id, name = c.Release.Name, source = c.Observations.Select(o => o.SourceId).Distinct(),
                    seeds = c.TrustedSeeders, c.ConservativeListedSeeders, parse = c.Release.Parsed,
                    bytes = c.Release.TotalBytes, c.CoversFilm, c.CoveredEpisodeIds,
                    verdict = evidence.GetValueOrDefault(c.Release.Id)?.Band ?? HealthBand.Unknown,
                    metrics = evidence.GetValueOrDefault(c.Release.Id),
                    checkedSwarm = evidence.ContainsKey(c.Release.Id),
                    checkReason = evidence.GetValueOrDefault(c.Release.Id)?.Reason ??
                        result.StopReason ?? "This candidate did not need a probe."
                }),
                plan = result.Plan,
                rejections = result.Find.Rejections.Select(r => new
                    { stage = "Find", r.Hash, TargetId = (string?)null, r.Code, r.Explanation, Name = (string?)r.Name, SourceId = (string?)r.SourceId })
                    .Concat(result.Plan.Rejections.Select(r => new
                    { stage = "Plan", r.Hash, r.TargetId, r.Code, r.Explanation, Name = (string?)null, SourceId = (string?)null })),
                queries = result.Find.Queries.Select(q => new
                { q.Query, q.SourceId, q.NamePhase, q.Tier, q.CacheHit, q.Result.Outcome, q.Result.Diagnostics })
            }, Json);
        });
    }
}
