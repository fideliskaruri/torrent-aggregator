using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Library.Features.Storage;
using TorrentFlow.Library.Features.Automation;
using System.Text.Json;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record GrabInput(string Title, string MediaType, EpisodeCursor? Cursor = null,
    string? WatchListItemId = null, string? WorkId = null, int? PreferredResolution = null,
    string Retention = "keep", bool OverrideStorageCap = false, IReadOnlyList<string>? Aliases = null,
    bool Background = false, int? Year = null, string? WorkKey = null, string? Lane = null,
    string? Provider = null, string? ProviderId = null, AnimeEpisodeMapping? EpisodeMapping = null)
{
    /// <summary>Background hunts are automation; anything the owner pressed is the owner's lane unless named.</summary>
    public string QueueLane => Lane ?? (Background ? TorrentLane.Automation : TorrentLane.Owner);
}

/// <summary>What one ladder rung fetched and how much survived each filter (TS RungDiagnostic).</summary>
public sealed class RungDiagnostic
{
    public required string Kind { get; init; }
    public required string Query { get; init; }
    public required string Category { get; init; }
    public long? MinSeeders { get; init; }
    public int Fetched { get; init; }
    public int WorkEligible { get; init; }
    public int QualityEligible { get; init; }
    public int EpisodeEligible { get; init; }
    public int Attempted { get; set; }
    public IReadOnlyList<SourceStatus> Sources { get; init; } = [];
    public IReadOnlyList<CandidateRejection> Candidates { get; set; } = [];
}

public sealed class GrabService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search, ITorrentEngine engine,
    IOptions<AutomationOptions> automationOptions, ILibraryAnimeLookup anime, ILogger<GrabService>? logger = null)
{
    public async Task<GrabResult> Grab(GrabInput input, CancellationToken ct, Func<Task>? beforeSend = null)
    {
        var query = input.Cursor?.Query(input.Title) ?? input.Title;
        await using var db = await factory.CreateDbContextAsync(ct);
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        if (settings == null) return new(false, "No torrent client configured") { Query = query };
        if (input.Cursor != null)
        {
            var work = input.WorkId == null ? null : await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.Id == input.WorkId, ct);
            IReadOnlyList<string> savedAliases = [];
            try { savedAliases = JsonSerializer.Deserialize<string[]>(work?.AliasesJson ?? "[]") ?? []; }
            catch (JsonException) { }
            input = input with { Aliases = (input.Aliases ?? []).Concat(savedAliases).Distinct(StringComparer.OrdinalIgnoreCase).ToArray() };
            var provider = input.Provider ?? work?.Provider;
            var providerId = input.ProviderId ?? work?.ProviderId;
            if (provider == "anilist" && providerId != null && input.Cursor is { Season: 1 } && input.EpisodeMapping == null)
            {
                try { input = input with { EpisodeMapping = await anime.GetEpisodeMappingAsync(providerId, ct) }; }
                catch (Exception) when (!ct.IsCancellationRequested) { }
            }
            if (input.EpisodeMapping is { } mapping)
                input = input with { Aliases = (input.Aliases ?? []).Concat(mapping.EntryTitles).Concat(mapping.FranchiseTitles)
                    .Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray() };
            if (work != null && input.Aliases is { Count: > 0 })
            {
                var aliasesJson = JsonSerializer.Serialize(input.Aliases);
                await db.Works.Where(w => w.Id == work.Id).ExecuteUpdateAsync(s =>
                    s.SetProperty(w => w.AliasesJson, aliasesJson), ct);
            }
        }
        int? floor = input.Retention == "stream" ? null : input.PreferredResolution ?? settings.PreferredResolution ?? 1080;
        if (input.Background) return await Hunt(db, settings, input, query, floor, ct);
        if (input.Cursor is { } cursor) return await Episode(db, settings, input, cursor, query, floor, beforeSend, ct);
        return await Film(db, settings, input, floor, beforeSend, ct);
    }

    /// <summary>Port of grabSingleEpisode's ladder: each rung is searched once, and the first working send wins.</summary>
    private async Task<GrabResult> Episode(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, EpisodeCursor cursor,
        string query, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var rungs = EpisodeLadder.BuildEpisodeRungs(input.Title, cursor, input.MediaType, input.Aliases, floor, input.EpisodeMapping,
            preferRequestedQuality: input.QueueLane == TorrentLane.Request);
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        var memo = new Dictionary<string, SearchResponse>(StringComparer.Ordinal);
        var attempted = new HashSet<string>(StringComparer.Ordinal);
        var diagnostics = new List<RungDiagnostic>();
        var decisions = new Dictionary<string, CandidateRejection>(StringComparer.Ordinal);
        var searchFailed = false;
        GrabResult? lastFailure = null;
        foreach (var rung in rungs)
        {
            var queryFailed = false;
            if (!memo.TryGetValue(rung.SearchKey, out var raw))
            {
                // `Limit` caps what is fetched and `PageSize` what is returned; both must be 40 or the single is paged away.
                try
                {
                    raw = await search.SearchAsync(new() { Query = rung.Query, Category = rung.Category, Limit = EpisodeLadder.SearchLimit,
                        PageSize = EpisodeLadder.SearchLimit, TargetResolution = floor ?? input.PreferredResolution, Enrich = false,
                        SkipCache = true, Background = false, Filters = rung.Filters, IncludeRejectedResults = true }, ct);
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    queryFailed = true;
                    raw = new() { Query = rung.Query, Sources = [new("search", 0, error.Message)] };
                }
                memo[rung.SearchKey] = raw;
            }
            searchFailed |= raw.Sources.Any(s => s.Error != null);
            var work = raw.Results.Where(x => EpisodeLadder.ReleaseMatchesWork(x, accepted, PremiereYear(input))).ToList();
            var quality = floor == null ? work : work.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor)).ToList();
            if (input.QueueLane == TorrentLane.Request && floor != null)
                quality = PreferRequestedQuality(quality, floor.Value).ToList();
            var rungCandidates = new Dictionary<string, CandidateRejection>(StringComparer.Ordinal);
            foreach (var row in raw.RejectedResults.Concat(raw.Results.Select(r => new SearchRejectedResult(r, ""))))
            {
                var key = EpisodeLadder.CandidateKey(row.Result);
                var decision = attempted.Contains(key) && decisions.TryGetValue(key, out var previous)
                    ? previous : EpisodeRejections.Explain(row.Result, accepted, cursor, input.EpisodeMapping, floor, rung.Relaxed,
                        row.Reason.Length > 0 ? row.Reason : null, PremiereYear(input));
                rungCandidates[key] = decisions[key] = decision;
            }
            var diagnostic = new RungDiagnostic { Kind = rung.Kind, Query = rung.Query, Category = rung.Category, MinSeeders = rung.Filters.MinSeeders,
                Fetched = raw.Results.Count, WorkEligible = work.Count, QualityEligible = quality.Count,
                EpisodeEligible = quality.Count(r => EpisodeLadder.MatchesTargetEpisode(r, cursor, input.EpisodeMapping)),
                Sources = raw.Sources, Candidates = rungCandidates.Values.ToArray() };
            diagnostics.Add(diagnostic);
            if (logger?.IsEnabled(LogLevel.Debug) == true)
                logger.LogDebug("Episode search rung: {Diagnostic}", JsonSerializer.Serialize(diagnostic));
            while (EpisodeLadder.Select(rung, quality, cursor, attempted, input.EpisodeMapping) is { } candidate)
            {
                attempted.Add(EpisodeLadder.CandidateKey(candidate));
                diagnostic.Attempted++;
                var result = await Send(db, settings, input, query, candidate, beforeSend, rung.Relaxed, ct);
                if (result.Ok) return result;
                var key = EpisodeLadder.CandidateKey(candidate);
                rungCandidates[key] = decisions[key] = new(candidate.Title, candidate.Source, ["send_failed"]);
                diagnostic.Candidates = rungCandidates.Values.ToArray();
                // One bad pick no longer ends the attempt: fall through to the next candidate, then the next rung.
                lastFailure = result;
            }
            if (queryFailed) break;
        }
        var searches = memo.Count;
        object Report(string reason) => new { reason, searches, triedSeasonPacks = false, manualSearchQuery = query,
            mapping = input.EpisodeMapping, candidates = decisions.Values.ToArray(), rungs = diagnostics };
        var message = EpisodeRejections.Message(cursor, floor, decisions.Values, searchFailed);
        if (lastFailure != null)
        {
            if (lastFailure.Storage != null) return lastFailure with { NoReleaseFound = Report("send_failed") };
            await LogSkip(db, input, query, message, ct);
            return lastFailure with { Message = message, NoReleaseFound = Report("send_failed") };
        }
        await LogSkip(db, input, query, message, ct);
        return new(false, message) { Query = query, Skipped = true, NoReleaseFound = Report(searchFailed ? "search_incomplete" : "no_release") };
    }

    private static int? PremiereYear(GrabInput input) => input.Cursor is { Season: 1 }
        && input.EpisodeMapping is not { IsSequel: true }
        && input.EpisodeMapping?.AbsoluteOffset is not > 0
        && input.EpisodeMapping?.FranchiseSeason is not > 1 ? input.Year : null;

    /// <summary>Port of the title page's grabWholeWork: one search, identity-checked first survivor, one send.</summary>
    private async Task<GrabResult> Film(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var title = input.Title.Trim();
        if (title.Length == 0) return new(false, "Nothing to search for") { Query = title };
        // A wrong category guess returns nothing; an unfiltered search still finds it and identity still rejects other works.
        var category = EpisodeLadder.SearchCategory(input.MediaType) ?? "all";
        var response = await search.SearchAsync(new() { Query = title, Category = category, Limit = 20, TargetResolution = floor ?? input.PreferredResolution,
            Enrich = false, SkipCache = true, Background = false, Filters = new() { HasMagnet = true, MinSeeders = 1 } }, ct);
        var key = input.WorkKey ?? ReleaseNames.WorkKeyFor(title, input.Year);
        var releases = input.QueueLane == TorrentLane.Request && floor != null
            ? PreferRequestedQuality(response.Results, floor.Value).ToArray() : response.Results;
        var candidate = FilmSelection.Select(releases, key, floor);
        if (candidate == null)
        {
            var message = FilmSelection.NoMatchMessage(title, floor, response.Results.Count, response.Sources, FilmSelection.Summarize(response.Results, key, floor));
            await LogSkip(db, input, title, message, ct);
            return new(false, message) { Query = title, Skipped = true };
        }
        return await Send(db, settings, input, title, candidate, beforeSend, false, ct);
    }

    private async Task<SearchResponse> SearchAnimeHunt(GrabInput input, EpisodeCursor cursor, string query, string category,
        SearchFilters filters, int? floor, CancellationToken ct)
    {
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToArray();
        var rungs = new[] { new LadderRung("hunt", query, category, filters) }
            .Concat(EpisodeLadder.BuildEpisodeRungs(input.Title, cursor, input.MediaType, input.Aliases, floor, input.EpisodeMapping))
            .Select(r => r with { Filters = r.Filters with { MinSeeders = null } })
            .DistinctBy(r => r.SearchKey);
        var all = new SearchResponse { Query = query };
        foreach (var rung in rungs)
        {
            SearchResponse response;
            try
            {
                response = await search.SearchAsync(new()
                {
                    Query = rung.Query, Category = rung.Category, Limit = EpisodeLadder.SearchLimit, PageSize = EpisodeLadder.SearchLimit,
                    TargetResolution = floor, Enrich = false, SkipCache = true, Background = true,
                    IncludeRejectedResults = true, Filters = rung.Filters
                }, ct);
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                return all with { Sources = all.Sources.Concat([new SourceStatus("search", 0, error.Message)]).ToArray() };
            }
            all = all with
            {
                Results = all.Results.Concat(response.Results).DistinctBy(EpisodeLadder.CandidateKey).ToArray(),
                RejectedResults = all.RejectedResults.Concat(response.RejectedResults).DistinctBy(r => EpisodeLadder.CandidateKey(r.Result)).ToArray(),
                Sources = all.Sources.Concat(response.Sources).ToArray()
            };
            var matching = response.Results.Where(r => EpisodeLadder.ReleaseMatchesWork(r, accepted, PremiereYear(input))).ToArray();
            var eligible = matching.Where(r => ReleaseSelection.MeetsFloor(r.Title, floor) &&
                EpisodeLadder.MatchesTargetEpisode(r, cursor, input.EpisodeMapping)).ToArray();
            if (logger?.IsEnabled(LogLevel.Debug) == true)
                logger.LogDebug("Episode search rung: {Diagnostic}", JsonSerializer.Serialize(new RungDiagnostic
                {
                    Kind = "hunt-" + rung.Kind, Query = rung.Query, Category = rung.Category, Fetched = response.Results.Count,
                    WorkEligible = matching.Length, QualityEligible = matching.Count(r => ReleaseSelection.MeetsFloor(r.Title, floor)),
                    EpisodeEligible = eligible.Length, Sources = response.Sources,
                    Candidates = response.RejectedResults.Concat(response.Results.Select(r => new SearchRejectedResult(r, "")))
                        .Select(r => EpisodeRejections.Explain(r.Result, accepted, cursor, input.EpisodeMapping, floor, true,
                            r.Reason.Length > 0 ? r.Reason : null, PremiereYear(input))).ToArray()
                }));
            // Keep zero-seeder candidates: Hunt, not the query ladder, owns their wait/grace policy.
            if (eligible.Length > 0 || response.Sources.Count > 0 && response.Sources.All(s => s.Error != null)) break;
        }
        return all;
    }

    /// <summary>Background acquisition with the same anime query ladder and automation's seeder-wait grace.</summary>
    private async Task<GrabResult> Hunt(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, string query, int? floor, CancellationToken ct)
    {
        var options = automationOptions.Value;
        // Unknown media type falls back to "all": a library row can be a film as well as a series.
        var category = EpisodeLadder.SearchCategory(input.MediaType) ?? "all";
        // Deliberately no seeder floor: a brand-new episode sits at 0 seeders; the wait below owns that decision.
        var huntQuery = query;
        var huntSeason = input.Cursor?.Season;
        var huntEpisode = input.Cursor?.Episode;
        if (input.Cursor is { Season: 1 } local && input.EpisodeMapping is { } mapping)
        {
            var name = EpisodeLadder.RankAliases(mapping.FranchiseTitles.Take(2)).FirstOrDefault() ?? input.Title;
            if (mapping.FranchiseSeason is { } sceneSeason)
            {
                huntSeason = sceneSeason;
                huntEpisode = local.Episode + mapping.SeasonEpisodeOffset;
                huntQuery = new EpisodeCursor(sceneSeason, huntEpisode.Value).Query(name);
            }
            else if (mapping.AbsoluteOffset is { } offset)
            {
                huntSeason = null;
                huntEpisode = offset + local.Episode;
                huntQuery = $"{name} - {huntEpisode:00}";
            }
        }
        var huntFilters = new SearchFilters { HasMagnet = true, Season = huntSeason, Episode = huntEpisode };
        var response = input.MediaType == "anime" && input.Cursor is { } animeCursor
            ? await SearchAnimeHunt(input, animeCursor, huntQuery, category, huntFilters, floor, ct)
            : await search.SearchAsync(new() { Query = huntQuery, Category = category, Limit = 15, TargetResolution = floor, Enrich = false,
            SkipCache = true, Background = true, IncludeRejectedResults = input.Cursor != null,
            Filters = huntFilters }, ct);
        var acceptedNames = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToArray();
        var eligible = response.Results.Where(x => input.Cursor != null
            ? EpisodeLadder.ReleaseMatchesWork(x, acceptedNames, PremiereYear(input))
            : ReleaseSelection.SameWork(x, input.Title, input.Aliases ?? [])).ToList();
        bool Exact(TorrentResult r) => input.Cursor == null || EpisodeLadder.MatchesTargetEpisode(r, input.Cursor.Value, input.EpisodeMapping);
        var exactBeforeQuality = eligible.Count(Exact);
        var quality = eligible.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor)).ToList();
        var candidates = PreferRequestedQuality(quality.Where(x => input.Cursor == null ? !EpisodeCursor.IsSeries(x.Metadata?.MediaType) && EpisodeCursor.Parse(x.Title) == null &&
                (input.Year == null || ReleaseSelection.Year(x.Title) == null || ReleaseSelection.Year(x.Title) == input.Year) :
                Exact(x))
            .Where(x => x.Magnet != null || x.TorrentUrl != null || x.InfoHash != null), floor ?? 1080)
            .OrderByDescending(x => x.Seeders >= Math.Max(1, options.MinimumSeeders)).ToList();
        var attempts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? lastError = null;
        foreach (var candidate in candidates)
        {
            var identity = LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet) ?? candidate.TorrentUrl ?? candidate.Id;
            if (!attempts.Add(identity)) continue;
            if (input.WatchListItemId != null)
            {
                var watch = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == input.WatchListItemId, ct);
                if (watch != null)
                {
                    if (watch.LatestReleaseMagnet == candidate.Magnet && candidate.Magnet != null ||
                        await db.EngineTorrents.AnyAsync(x => x.UserId == LocalUser.Id && x.Hash == identity && x.Status != "removed", ct))
                    {
                        if (input.Cursor != null) await Advance(db, watch.Id, input.Cursor.Value, candidate.Title, ct);
                        await LogSkip(db, input, query, "Already sent this release", ct);
                        return new(false, "Already sent this release") { Query = query, Skipped = true };
                    }
                    var since = watch.SeederWaitSince ?? DateTime.UtcNow;
                    if (candidate.Seeders < options.MinimumSeeders && CheckSchedule.WaitingForSeeders(since, DateTime.UtcNow, options))
                    {
                        var minutes = Math.Max(1, Math.Ceiling(options.SeederWaitTimeoutMinutes - (DateTime.UtcNow - since).TotalMinutes));
                        var message = $"Waiting for seeders ({candidate.Seeders} of {options.MinimumSeeders}) — grabbing anyway in ~{minutes}m if no peers arrive";
                        var next = CheckSchedule.Next(DateTime.UtcNow, null, watch.CursorMisses, since, settings.AutomationIntervalMinutes ?? 15, options);
                        await db.WatchListItems.Where(x => x.Id == watch.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.SeederWaitSince, since)
                            .SetProperty(w => w.NextCheckAt, next.At).SetProperty(w => w.NextCheckReason, next.Reason)
                            .SetProperty(w => w.LastChecked, DateTime.UtcNow), ct);
                        await LogSkip(db, input, query, message, ct);
                        return new(false, message) { Query = query, Skipped = true };
                    }
                }
            }
            var result = await Send(db, settings, input, query, candidate, null, false, ct);
            if (result.Ok || result.Storage != null) return result;
            lastError = result.Message;
        }
        var label = input.Cursor?.Label ?? input.Title;
        var qualityLabel = floor == null ? "" : $" at {floor}p or higher";
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToArray();
        var decisions = input.Cursor is { } target
            ? response.RejectedResults.Concat(response.Results.Select(r => new SearchRejectedResult(r, "")))
                .DistinctBy(r => EpisodeLadder.CandidateKey(r.Result))
                .Select(r =>
                {
                    var decision = EpisodeRejections.Explain(r.Result, accepted, target, input.EpisodeMapping, floor, true,
                        r.Reason.Length > 0 ? r.Reason : null, PremiereYear(input));
                    var identity = LibraryJson.Hash(r.Result.InfoHash) ?? LibraryJson.Hash(r.Result.Magnet) ?? r.Result.TorrentUrl ?? r.Result.Id;
                    return lastError != null && attempts.Contains(identity)
                        ? decision with { Reasons = ["send_failed"] } : decision;
                }).ToArray() : [];
        var noRelease = input.Cursor is { } episode
            ? EpisodeRejections.Message(episode, floor, decisions, response.Sources.Any(s => s.Error != null))
            : $"Couldn't find a release for {label}{qualityLabel}. Try again later.";
        var finalMessage = input.Cursor != null ? noRelease : lastError ?? noRelease;
        await LogSkip(db, input, query, finalMessage, ct);
        var rungs = new[] { new RungDiagnostic { Kind = "exact", Query = huntQuery, Category = category, Fetched = response.Results.Count,
            WorkEligible = eligible.Count, QualityEligible = quality.Count, EpisodeEligible = quality.Count(Exact),
            Attempted = attempts.Count, Sources = response.Sources, Candidates = decisions } };
        return new(false, finalMessage) { Query = query, HuntMiss = lastError == null && exactBeforeQuality == 0 && !response.Sources.Any(s => s.Error != null), Skipped = lastError == null,
            NoReleaseFound = new { reason = lastError != null ? "send_failed" : response.Sources.Any(s => s.Error != null) ? "search_incomplete" : "no_release",
                searches = 1, triedSeasonPacks = false, manualSearchQuery = query, rungs } };
    }

    /// <summary>Sends one pinned candidate and records the attempt; the recorded query stays the canonical one.</summary>
    private async Task<GrabResult> Send(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, string query, TorrentResult candidate,
        Func<Task>? beforeSend, bool relaxed, CancellationToken ct)
    {
        if (beforeSend != null) await beforeSend();
        EngineAddResult result;
        try
        {
            result = await engine.AddAsync(new() { Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
                InfoHash = candidate.InfoHash, Name = candidate.Title, Purpose = input.Retention,
                Source = candidate.Source, SearchCategory = EpisodeLadder.SearchCategory(input.MediaType) ?? "all",
                Metadata = CatalogMetadata(input.MediaType, input.Title, input.Year),
                QueueKey = input.Cursor?.QueueKey, WorkId = input.WorkId, ExpectedSizeBytes = candidate.SizeBytes,
                OverrideStorageCap = input.OverrideStorageCap, Lane = input.QueueLane }, ct);
            result = EngineAddMessages.WithFormattedMessage(result);
        }
        catch (Exception error) when (!ct.IsCancellationRequested) { result = new(false, error.Message); }
        var hash = LibraryJson.Hash(result.Hash) ?? LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet);
        var queued = result.Details?.Action == EngineAddDetails.Queued;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = DateTime.UtcNow;
        db.GrabJobs.Add(new GrabJob { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title, Query = query,
            Status = result.Ok ? "sent" : "failed", Message = result.Message, Magnet = candidate.Magnet, InfoHash = hash,
            Source = candidate.Source, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, Retention = input.Retention,
            CreatedAt = now, UpdatedAt = now });
        db.DownloadHistories.Add(new DownloadHistory { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title,
            Status = result.Ok ? "sent" : "failed", Message = result.Message, Magnet = candidate.Magnet, TorrentUrl = candidate.TorrentUrl,
            InfoHash = hash, Source = candidate.Source, WorkId = input.WorkId, Retention = input.Retention, Context = "ondemand",
            ClientType = "builtin", SendKind = candidate.Magnet != null ? "magnet" : "torrent", CreatedAt = now });
        var advanced = false;
        if (result.Ok && input.WatchListItemId != null && input.Cursor != null)
            advanced = await Advance(db, input.WatchListItemId, input.Cursor.Value, candidate.Title, ct);
        if (result.Ok && input.Background && input.WatchListItemId != null)
            await db.WatchListItems.Where(x => x.Id == input.WatchListItemId).ExecuteUpdateAsync(x =>
                x.SetProperty(w => w.LatestReleaseMagnet, candidate.Magnet).SetProperty(w => w.CursorMisses, 0)
                    .SetProperty(w => w.SeederWaitSince, (DateTime?)null).SetProperty(w => w.NextCheckAt, (DateTime?)null)
                    .SetProperty(w => w.NextCheckReason, (string?)null), ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        if (!result.Ok)
        {
            var storage = result.StorageLimit == null ? null : StorageFacts.Refusal(settings, result.StorageLimit, result.Message,
                candidate.SizeBytes, await engine.QueuedReservedBytesAsync(ct));
            return new(false, result.Message) { Query = query, Title = candidate.Title, Magnet = candidate.Magnet, Storage = storage };
        }
        // Honestly label the provenance when the ladder had to relax to win.
        var notes = new List<string>();
        if (advanced && !input.Background) notes.Add($"advanced past {input.Cursor?.Label}");
        if (relaxed) notes.Add("low-seed release");
        var next = input.Cursor?.Next();
        // The engine picks the smart target on add; report where the transfer actually lives.
        var savePath = hash == null ? null : (await engine.GetAsync(hash, ct))?.SavePath;
        return new(true, notes.Count == 0 ? result.Message : $"{result.Message} · {string.Join(" · ", notes)}") { Query = query, Title = candidate.Title,
            Magnet = candidate.Magnet, InfoHash = hash, Queued = queued, QueuePosition = result.Details?.QueuePosition, Advanced = advanced,
            SavePath = savePath,
            LastEpisode = advanced ? input.Cursor?.Label : null, CursorSeason = advanced ? next?.Season : null,
            CursorEpisode = advanced ? next?.Episode : null, NextEpisodeHint = advanced ? next?.Query(input.Title) : null };
    }

    /// <summary>catalogMetadata({ mediaType, title }) as grab.ts passes it to resolveSmartSendTarget.</summary>
    private static TorrentFlow.Core.Contracts.Metadata.MediaMetadata? CatalogMetadata(string? mediaType, string? title, int? year = null)
    {
        var type = (mediaType ?? "").Trim().ToLowerInvariant();
        var name = (title ?? "").Trim();
        if (type is not ("anime" or "movie" or "tv") || name.Length == 0) return null;
        return new() { Source = type == "anime" ? "anilist" : "tmdb", MediaType = type, ExternalId = "", Title = name, Year = year };
    }

    private static async Task LogSkip(TorrentFlowDbContext db, GrabInput input, string query, string message, CancellationToken ct)
    {
        db.GrabJobs.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = input.Title, Query = query, Status = "skipped",
            Message = message, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }

    internal static IOrderedEnumerable<TorrentResult> PreferRequestedQuality(IEnumerable<TorrentResult> releases, int floor) =>
        releases.OrderBy(r => r.Seeders > 0 ? 0 : 1)
            .ThenBy(r => ReleaseSelection.Resolution(r.Title) is { } resolution ? Math.Abs(resolution - floor) : int.MaxValue)
            .ThenBy(r => System.Text.RegularExpressions.Regex.IsMatch(r.Title, @"\bremux\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant,
                TimeSpan.FromSeconds(1)) ? 1 : 0)
            .ThenBy(r => r.SizeBytes is > 0 ? r.SizeBytes : long.MaxValue)
            .ThenByDescending(r => r.Seeders);

    internal static async Task<bool> Advance(TorrentFlowDbContext db, string id, EpisodeCursor grabbed, string title, CancellationToken ct)
    {
        var item = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.UserId == LocalUser.Id, ct);
        if (item == null || EpisodeCursor.Resolve(item) != grabbed) return false;
        var next = grabbed.Next();
        var now = DateTime.UtcNow;
        var moved = await db.WatchListItems.Where(x => x.Id == id && x.CursorSeason == item.CursorSeason && x.CursorEpisode == item.CursorEpisode)
            .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorSeason, next.Season).SetProperty(w => w.CursorEpisode, next.Episode)
                .SetProperty(w => w.LastEpisode, grabbed.Label).SetProperty(w => w.NextEpisodeHint, next.Query(item.Title))
                .SetProperty(w => w.CursorMisses, 0).SetProperty(w => w.SeederWaitSince, (DateTime?)null)
                .SetProperty(w => w.NextCheckAt, (DateTime?)null).SetProperty(w => w.NextCheckReason, (string?)null)
                .SetProperty(w => w.LastChecked, now).SetProperty(w => w.UpdatedAt, now)
                .SetProperty(w => w.LatestReleaseTitle, title).SetProperty(w => w.LatestReleaseAt, now)
                .SetProperty(w => w.FromSeason, item.FromSeason ?? grabbed.Season).SetProperty(w => w.FromEpisode, item.FromSeason == null ? grabbed.Episode : item.FromEpisode), ct);
        return moved > 0;
    }
}
