using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;
using TorrentFlow.Api;
using Microsoft.AspNetCore.DataProtection;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal static class TitleReleases
{
    private sealed record Choice(string WorkId, string Hash, int? Season, int? Episode, DateTimeOffset ExpiresAt);

    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/title/{workKey}/releases", Search);
        app.MapPost("/api/title/{workKey}/releases", Pick);
    }

    private static IDataProtector Protector(IDataProtectionProvider provider) =>
        provider.CreateProtector("TorrentFlow.TitleReleaseChoice.v1");

    private static async Task<IResult> Search(string workKey, HttpContext http, IMetadata metadata,
        IFind find, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (AccessIdentity.Role(http) != "owner")
            return Results.Json(new { error = "Only the owner can pick a release." }, statusCode: 403);
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        var query = http.Request.Query["q"].ToString().Trim();
        if (work is null) return Results.Ok(new { query = query.Length > 0 ? query : workKey, releases = Array.Empty<object>() });
        int? season = int.TryParse(http.Request.Query["season"], out var s) && s > 0 ? s : null;
        int? episode = int.TryParse(http.Request.Query["episode"], out var e) && e > 0 ? e : null;
        if (work.Work.Kind == WorkKind.Film) season = episode = null;
        var seasonId = work.Seasons.FirstOrDefault(row => row.Number == season)?.Id;
        var episodes = work.Episodes.Where(row => row.SeasonId == seasonId &&
            (episode is null || row.Number == episode)).Select(row => row.Id).ToImmutableArray();
        var scope = new TargetScope(work.Work.Id, episodes, work.Work.Kind == WorkKind.Film);
        var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope,
            new(null, null, null, null, null), PriorityLane.Owner, SearchNamePhase.English, [], 0, 0);
        ImmutableArray<Candidate> pool = [];
        if (query.Length > 0)
        {
            if (query.Length > 200) return Results.BadRequest(new { error = "Search is too long. Use fewer than 201 characters." });
            var raw = await find.SearchRawAsync(new(AccessIdentity.Actor(http), query,
                scope.Film ? "movies" : "tv", [], 1, 50, 50, false, false,
                new(null, null, null, null, null, null, null, null, null, null)), ct);
            var projected = ImmutableArray.CreateBuilder<Candidate>();
            foreach (var candidate in raw.Pool)
            {
                var scoped = (await find.SelectAsync(request, candidate.Release.Id, ct)).Candidates.FirstOrDefault();
                projected.Add(scoped ?? candidate);
            }
            pool = projected.ToImmutable();
        }
        else
        {
            query = CatalogProjection.Title(work);
            if (!scope.Film && (episodes.IsEmpty || work.Episodes.Any(row => episodes.Contains(row.Id) &&
                row.MappingStatus != MappingStatus.Confirmed)))
                return Results.Ok(new { query, releases = Array.Empty<object>() });
            var feedback = Channel.CreateUnbounded<SearchFeedback>();
            feedback.Writer.Complete();
            await foreach (var batch in find.SearchAsync(request, feedback.Reader.ReadAllAsync(ct), ct))
            {
                pool = batch.Candidates;
                query = batch.Queries.FirstOrDefault()?.Query ?? query;
            }
        }
        var protector = Protector(protection);
        return Results.Json(new { query, releases = pool.Select(candidate => new
        {
            token = protector.Protect(JsonSerializer.Serialize(new Choice(work.Work.Id, candidate.Release.Id,
                season, episode, DateTimeOffset.UtcNow.AddMinutes(15)))),
            hash = candidate.Release.Id, title = candidate.Release.Name,
            seeders = candidate.TrustedSeeders ?? 0,
            peers = candidate.Observations.Select(o => o.ListedLeechers).DefaultIfEmpty().Max() ?? 0,
            sizeBytes = candidate.Release.TotalBytes, quality = candidate.Release.Parsed.Quality.Resolution,
            source = candidate.Observations.FirstOrDefault()?.SourceId ?? "",
            language = candidate.Release.Parsed.LanguageMarkers.IsEmpty ? "Language not stated" :
                string.Join(", ", candidate.Release.Parsed.LanguageMarkers),
            languageFit = candidate.Release.Parsed.ClearlyForeign ? "clash" : "neutral",
            languages = new
            {
                audio = Array.Empty<string>(),
                subtitles = Array.Empty<string>(), subtitleState = "unknown",
                fit = candidate.Release.Parsed.ClearlyForeign ? "clash" : "neutral",
                basis = candidate.Release.Parsed.LanguageMarkers.IsEmpty ? "none" : "name",
                confidence = candidate.Release.Parsed.LanguageMarkers.IsEmpty ? "low" : "medium",
                label = candidate.Release.Parsed.LanguageMarkers.IsEmpty ? "Language not stated" :
                    string.Join(", ", candidate.Release.Parsed.LanguageMarkers),
                english = candidate.Release.Parsed.ClearlyForeign ? "fail" : "unknown",
                englishReason = candidate.Release.Parsed.ClearlyForeign ?
                    "This release is labelled in another language." : "Language not stated",
            },
            fits = scope.Film ? candidate.CoversFilm : !episodes.IsEmpty &&
                episodes.All(id => candidate.CoveredEpisodeIds.Contains(id)),
            why = candidate.Release.Parsed.ClearlyForeign ? "This release is labelled in another language." :
                candidate.Release.Parsed.Unsafe ? "This release is not safe to download." : "Found for this title.",
        }) }, CatalogProjection.Json);
    }

    private static async Task<IResult> Pick(string workKey, HttpContext http, IMetadata metadata,
        TargetPipeline targets, IFind find, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (AccessIdentity.Role(http) != "owner")
            return Results.Json(new { error = "Only the owner can pick a release." }, statusCode: 403);
        if (!http.Request.HasJsonContentType() || http.Request.ContentLength is > 16384)
            return Results.BadRequest(new { ok = false, message = "Choose a release first." });
        JsonElement input;
        try { input = await http.Request.ReadFromJsonAsync<JsonElement>(ct); }
        catch (JsonException) { return Results.BadRequest(new { ok = false, message = "Choose a release first." }); }
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty("token", out var token) ||
            token.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(token.GetString()))
            return Results.BadRequest(new { ok = false, message = "Choose a release first." });
        string? replaceTransferId = null;
        if (input.TryGetProperty("replaceTransferId", out var replace) && replace.ValueKind != JsonValueKind.Null)
        {
            if (replace.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(replace.GetString()))
                return Results.BadRequest(new { ok = false, message = "Choose a download to replace." });
            replaceTransferId = replace.GetString();
        }
        Choice? choice;
        try { choice = JsonSerializer.Deserialize<Choice>(Protector(protection).Unprotect(token.GetString()!)); }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        { return Results.BadRequest(new { ok = false, message = "That choice is invalid. Search again and choose a release." }); }
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        if (choice is null || choice.ExpiresAt <= DateTimeOffset.UtcNow || choice.WorkId != work?.Work.Id)
            return Results.Conflict(new { ok = false, message = "That choice expired. Search again and choose a release." });
        try
        {
            var seasonId = work!.Seasons.FirstOrDefault(row => row.Number == choice.Season)?.Id;
            var episodes = work.Episodes.Where(row => row.SeasonId == seasonId &&
                (choice.Episode is null || row.Number == choice.Episode)).Select(row => row.Id).ToImmutableArray();
            var scope = new TargetScope(work.Work.Id, episodes, work.Work.Kind == WorkKind.Film);
            var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope,
                new(null, null, null, null, null), PriorityLane.Owner, SearchNamePhase.English, [], 0, 0);
            var selected = (await find.SelectAsync(request, choice.Hash, ct)).Candidates.FirstOrDefault();
            if (selected is null || selected.Release.Parsed.Unsafe || selected.Release.Parsed.Cam ||
                selected.Release.Parsed.Sample || selected.Release.Parsed.ClearlyForeign ||
                (scope.Film ? !selected.CoversFilm : episodes.IsEmpty ||
                    !episodes.All(id => selected.CoveredEpisodeIds.Contains(id))))
                return Results.Conflict(new { ok = false, message = "That release doesn't match this title. Search again and choose another." });
            if (replaceTransferId is not null)
            {
                if (!ReleaseReplacementEndpoints.TryParseTransferId(replaceTransferId, out var currentHash))
                    return Results.Conflict(new { ok = false, message = "Download not found." });
                var currentTarget = await ReleaseReplacementEndpoints.CurrentTarget(targets, currentHash, ct);
                if (currentTarget is null)
                    return Results.Conflict(new { ok = false, message = "Download not found." });
                if (currentTarget.WorkId != work!.Work.Id)
                    return Results.Conflict(new { ok = false, message = "That download does not belong to this title." });
                var replaced = await targets.FindAnotherAsync(currentTarget.Id, choice.Hash, ct);
                return Results.Json(new { ok = replaced.Accepted, message = replaced.Message,
                    title = CatalogProjection.Title(work!), infoHash = choice.Hash, queued = replaced.Queued > 0 },
                    statusCode: replaced.Accepted ? 200 : 409);
            }
            var accepted = await targets.AcquireAsync(new(workKey, choice.Season, choice.Episode),
                AccessIdentity.UserId(http), ct);
            if (!accepted.Accepted || accepted.TargetIds.IsEmpty)
                return Results.Conflict(new { ok = false, message = accepted.Message });
            var queued = 0;
            foreach (var id in accepted.TargetIds)
            {
                var picked = await targets.PickAsync(id, choice.Hash, ct);
                if (!picked.Accepted)
                    return Results.Conflict(new { ok = false, message = picked.Message });
                queued += picked.Queued;
            }
            return Results.Ok(new { ok = true, message = $"{queued} queued", title = CatalogProjection.Title(work!),
                infoHash = choice.Hash, queued = queued > 0 });
        }
        catch (ArgumentException ex) { return Results.Conflict(new { ok = false, message = ex.Message }); }
        catch (InvalidOperationException ex) { return Results.Conflict(new { ok = false, message = ex.Message }); }
    }
}
