using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using TorrentFlow.Api;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Catalog;

internal static class TitleReleases
{
    private sealed record Choice(string WorkId, string Hash, int? Season, int? Episode, DateTimeOffset ExpiresAt);
    private sealed record PickerRelease(string Token, string Hash, string Title, int Seeders, int Peers,
        long? SizeBytes, int? Quality, string Source, string Language, string LanguageFit, object Languages,
        bool Fits, string Why,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? State = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? UsedAt = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Blocked = null);

    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/title/{workKey}/releases", Search);
        app.MapGet("/api/title/{workKey}/releases/previous", Previous);
        app.MapPost("/api/title/{workKey}/releases", Pick);
    }

    private static IDataProtector Protector(IDataProtectionProvider provider) =>
        provider.CreateProtector("TorrentFlow.TitleReleaseChoice.v1");

    private static async Task<IResult> Search(string workKey, HttpContext http, IMetadata metadata,
        IFind find, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (AccessIdentity.Role(http) != "owner")
            return Results.Json(new { error = "Only the owner can pick a source." }, statusCode: 403);
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
        return Results.Json(new { query, releases = pool.Select(candidate =>
            Project(candidate, scope, episodes, work.Work.Id, season, episode, protector)) }, CatalogProjection.Json);
    }

    private static async Task<IResult> Previous(string workKey, HttpContext http, IMetadata metadata,
        IFind find, IDataProtectionProvider protection, IServiceScopeFactory scopes, CancellationToken ct)
    {
        if (AccessIdentity.Role(http) != "owner")
            return Results.Json(new { error = "Only the owner can pick a source." }, statusCode: 403);
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        if (work is null) return Results.Json(new { sources = Array.Empty<object>() }, CatalogProjection.Json);
        int? season = int.TryParse(http.Request.Query["season"], out var s) && s > 0 ? s : null;
        int? episode = int.TryParse(http.Request.Query["episode"], out var e) && e > 0 ? e : null;
        if (work.Work.Kind == WorkKind.Film) season = episode = null;
        var seasonId = work.Seasons.FirstOrDefault(row => row.Number == season)?.Id;
        var episodes = work.Episodes.Where(row => row.SeasonId == seasonId &&
            (episode is null || row.Number == episode)).Select(row => row.Id).ToImmutableArray();
        var scope = new TargetScope(work.Work.Id, episodes, work.Work.Kind == WorkKind.Film);
        var request = new SearchRequest(Guid.NewGuid().ToString("N"), work, scope,
            new(null, null, null, null, null), PriorityLane.Owner, SearchNamePhase.English, [], 0, 0);

        await using var serviceScope = scopes.CreateAsyncScope();
        var store = serviceScope.ServiceProvider.GetRequiredService<TargetStore>();
        var allTargets = await store.ListAsync<TargetRow>(row => row.WorkId == work.Work.Id, ct);
        var wholeWork = work.Work.Kind == WorkKind.Film || season is null;
        var targets = allTargets.Where(row => wholeWork ||
            (row.EpisodeId is not null && episodes.Contains(row.EpisodeId))).ToArray();
        var targetIds = targets.Select(row => row.Id).ToHashSet(StringComparer.Ordinal);
        var attempts = targetIds.Count == 0 ? [] : await store.ListAsync<AttemptRow>(row =>
            row.TargetId != null && targetIds.Contains(row.TargetId) && row.ReleaseHash != null &&
            (row.Kind == AttemptKind.Fetch || row.Kind == AttemptKind.Plan || row.Kind == AttemptKind.Swap), ct);
        var links = targetIds.Count == 0 ? [] : await store.ListAsync<DownloadTargetRow>(
            row => targetIds.Contains(row.TargetId), ct);
        var downloadIds = links.Select(row => row.DownloadId).ToHashSet(StringComparer.Ordinal);
        var downloads = downloadIds.Count == 0 ? [] : await store.ListAsync<DownloadRow>(
            row => downloadIds.Contains(row.Id), ct);
        var otherHashes = targets.SelectMany(row => new[] { row.ChosenReleaseHash, row.PickedReleaseHash })
            .OfType<string>().Concat(attempts.Select(row => row.ReleaseHash).OfType<string>())
            .Concat(downloads.Select(row => row.Hash)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var now = DateTimeOffset.UtcNow;
        var activeBlocks = await store.ListAsync<BlockRow>(row =>
            (row.WorkKey == null || row.WorkKey == workKey) && (row.Until == null || row.Until > now), ct);
        var blocks = activeBlocks.Where(row => otherHashes.Contains(row.Hash) || wholeWork).ToArray();
        var hashes = otherHashes.Concat(blocks.Select(row => row.Hash))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (hashes.Count == 0) return Results.Json(new { sources = Array.Empty<object>() }, CatalogProjection.Json);

        var releases = await store.ListAsync<ReleaseRow>(row => hashes.Contains(row.Id), ct);
        var observations = await store.ListAsync<ReleaseObservationRow>(row => hashes.Contains(row.Hash), ct);
        var protector = Protector(protection);
        var previous = new List<(PickerRelease Item, DateTimeOffset? UsedAt)>();
        foreach (var release in releases)
        {
            var hash = release.Id;
            var candidate = (await find.SelectAsync(request, hash, ct)).Candidates.FirstOrDefault();
            if (candidate is null) continue;
            var sourceObservations = observations.Where(row => row.Hash == hash).ToArray();
            var latestObservation = sourceObservations.OrderByDescending(row => row.ObservedAt).FirstOrDefault();
            var sourceDownloads = downloads.Where(row => row.Hash == hash).ToArray();
            var sourceAttempts = attempts.Where(row => row.ReleaseHash == hash).ToArray();
            var sourceBlocks = blocks.Where(row => row.Hash == hash)
                .OrderByDescending(row => row.CreatedAt).ToArray();
            var blocked = sourceBlocks.FirstOrDefault();
            var inUse = targets.Any(row => row.ChosenReleaseHash == hash && row.State != TargetState.Removed) &&
                sourceDownloads.Any(row => row.FinishedAt is null);
            var finished = sourceDownloads.Any(row => row.FinishedAt is not null) && blocked is null;
            var state = inUse ? "in_use" : finished ? "finished" : "dropped";
            // A source picked back by hand keeps its block for automatic picks, but it is not dropped.
            var blockedInfo = blocked is null || inUse ? null : new
            {
                reason = "replaced",
                at = blocked.CreatedAt.ToString("O"),
                message = $"You switched away from this source on {blocked.CreatedAt.ToString("MMM d, yyyy", System.Globalization.CultureInfo.InvariantCulture)}.",
            };
            var usedAt = sourceDownloads.Select(row => (DateTimeOffset?)row.AddedAt)
                .Concat(sourceAttempts.Select(row => (DateTimeOffset?)row.StartedAt))
                .Concat(sourceBlocks.Select(row => (DateTimeOffset?)row.CreatedAt))
                .Max() ?? targets.Where(row => row.ChosenReleaseHash == hash || row.PickedReleaseHash == hash)
                    .Select(row => (DateTimeOffset?)row.UpdatedAt).Max();
            var fits = scope.Film ? candidate.CoversFilm : !episodes.IsEmpty &&
                episodes.All(id => candidate.CoveredEpisodeIds.Contains(id));
            var why = state switch
            {
                "in_use" => "Downloading now.",
                "finished" => "Downloaded before.",
                _ => blockedInfo?.message ?? "Used before.",
            };
            previous.Add((Project(candidate, scope, episodes, work.Work.Id, season, episode, protector,
                latestObservation is null ? null : latestObservation.ListedSeeders ?? 0,
                latestObservation?.SourceId, fits, why, state,
                usedAt?.ToString("O"), blockedInfo), usedAt));
        }
        return Results.Json(new { sources = previous.OrderByDescending(row => row.UsedAt)
            .Select(row => row.Item) }, CatalogProjection.Json);
    }

    private static PickerRelease Project(Candidate candidate, TargetScope scope, ImmutableArray<string> episodes,
        string workId, int? season, int? episode, IDataProtector protector, int? seeders = null,
        string? source = null, bool? fits = null, string? why = null, string? state = null,
        string? usedAt = null, object? blocked = null)
    {
        var parsed = candidate.Release.Parsed;
        var language = parsed.LanguageMarkers.IsEmpty ? "Language not stated" :
            string.Join(", ", parsed.LanguageMarkers);
        return new(protector.Protect(JsonSerializer.Serialize(new Choice(workId, candidate.Release.Id,
                season, episode, DateTimeOffset.UtcNow.AddMinutes(15)))),
            candidate.Release.Id, candidate.Release.Name, seeders ?? candidate.TrustedSeeders ?? 0,
            candidate.Observations.Select(row => row.ListedLeechers).DefaultIfEmpty().Max() ?? 0,
            candidate.Release.TotalBytes, parsed.Quality.Resolution,
            source ?? candidate.Observations.FirstOrDefault()?.SourceId ?? "",
            language, parsed.ClearlyForeign ? "clash" : "neutral",
            new
            {
                audio = Array.Empty<string>(),
                subtitles = Array.Empty<string>(), subtitleState = "unknown",
                fit = parsed.ClearlyForeign ? "clash" : "neutral",
                basis = parsed.LanguageMarkers.IsEmpty ? "none" : "name",
                confidence = parsed.LanguageMarkers.IsEmpty ? "low" : "medium",
                label = language,
                english = parsed.ClearlyForeign ? "fail" : "unknown",
                englishReason = parsed.ClearlyForeign ?
                    "This source is labelled in another language." : "Language not stated",
            },
            fits ?? (scope.Film ? candidate.CoversFilm : !episodes.IsEmpty &&
                episodes.All(id => candidate.CoveredEpisodeIds.Contains(id))),
            why ?? (parsed.ClearlyForeign ? "This source is labelled in another language." :
                parsed.Unsafe ? "This source is not safe to download." : "Found for this title."),
            state, usedAt, blocked);
    }

    private static async Task<IResult> Pick(string workKey, HttpContext http, IMetadata metadata,
        TargetPipeline targets, IFind find, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (AccessIdentity.Role(http) != "owner")
            return Results.Json(new { error = "Only the owner can pick a source." }, statusCode: 403);
        if (!http.Request.HasJsonContentType() || http.Request.ContentLength is > 16384)
            return Results.BadRequest(new { ok = false, message = "Choose a source first." });
        JsonElement input;
        try { input = await http.Request.ReadFromJsonAsync<JsonElement>(ct); }
        catch (JsonException) { return Results.BadRequest(new { ok = false, message = "Choose a source first." }); }
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty("token", out var token) ||
            token.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(token.GetString()))
            return Results.BadRequest(new { ok = false, message = "Choose a source first." });
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
        { return Results.BadRequest(new { ok = false, message = "That choice is invalid. Search again and choose a source." }); }
        var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
        if (choice is null || choice.ExpiresAt <= DateTimeOffset.UtcNow || choice.WorkId != work?.Work.Id)
            return Results.Conflict(new { ok = false, message = "That choice expired. Search again and choose a source." });
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
                return Results.Conflict(new { ok = false, message = "That source doesn't match this title. Search again and choose another." });
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
