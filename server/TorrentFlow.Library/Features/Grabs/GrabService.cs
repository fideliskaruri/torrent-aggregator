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
    string? Provider = null, string? ProviderId = null, AnimeEpisodeMapping? EpisodeMapping = null,
    SearchFilters? Constraints = null, string[]? Sources = null)
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
    IOptions<AutomationOptions> automationOptions, ILibraryAnimeLookup anime, ILogger<GrabService>? logger = null,
    EpisodeSearchIdentity? searchIdentity = null)
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
            var identity = await (searchIdentity ?? new EpisodeSearchIdentity(anime)).ResolveAsync(input.Title,
                input.Year ?? work?.Year, work?.MediaType == "anime" ? "anime" : input.MediaType, input.Aliases, ct,
                input.Provider ?? work?.Provider, input.ProviderId ?? work?.ProviderId);
            input = input with { MediaType = identity.MediaType, Aliases = identity.Aliases };
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
            if (work != null && (input.Aliases is { Count: > 0 } || work.MediaType != input.MediaType))
            {
                var aliasesJson = JsonSerializer.Serialize(input.Aliases);
                await db.Works.Where(w => w.Id == work.Id).ExecuteUpdateAsync(s =>
                    s.SetProperty(w => w.AliasesJson, aliasesJson).SetProperty(w => w.MediaType, input.MediaType), ct);
            }
        }
        int? floor = input.Retention == "stream" ? null : input.PreferredResolution ?? settings.PreferredResolution ?? 1080;
        if (input.Cursor is { } cursor) return await Episode(db, settings, input, cursor, query, floor, beforeSend, ct);
        return await Film(db, settings, input, floor, beforeSend, ct);
    }

    /// <summary>Port of grabSingleEpisode's ladder: each rung is searched once, and the first working send wins.</summary>
    private async Task<GrabResult> Episode(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, EpisodeCursor cursor,
        string query, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var rungs = EpisodeLadder.BuildEpisodeRungs(input.Title, cursor, input.MediaType, input.Aliases, floor, input.EpisodeMapping,
            preferRequestedQuality: true);
        if (input.Background)
            rungs = rungs.Select(r => r with { Filters = r.Filters with { MinSeeders = null }, Relaxed = true }).DistinctBy(r => r.SearchKey).ToArray();
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
                        SkipCache = true, Background = input.Background, WaitForBudget = true, Sources = input.Sources,
                        Filters = rung.Filters with { MinSeeders = input.Constraints?.MinSeeders ?? rung.Filters.MinSeeders,
                            MaxSizeBytes = input.Constraints?.MaxSizeBytes, Resolution = input.Constraints?.Resolution },
                        IncludeRejectedResults = true }, ct);
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
            var quality = work.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor) &&
                AnimeAudio.Allowed(x.Title, input.MediaType, automationOptions.Value.PreferAnimeDub) &&
                (input.Sources == null || input.Sources.Contains(x.Source)) &&
                (input.Constraints?.MinSeeders == null || x.Seeders >= input.Constraints.MinSeeders) &&
                (input.Constraints?.MaxSizeBytes == null || x.SizeBytes <= input.Constraints.MaxSizeBytes) &&
                (input.Constraints?.Resolution == null || ReleaseSelection.Resolution(x.Title) is { } r && $"{r}p" == input.Constraints.Resolution)).ToList();
            if (floor != null)
                quality = PreferRequestedQuality(quality, floor.Value).ToList();
            if (input.MediaType == "anime")
                quality = quality.OrderBy(x => AnimeAudio.Preference(x.Title, automationOptions.Value.PreferAnimeDub)).ToList();
            var rungCandidates = new Dictionary<string, CandidateRejection>(StringComparer.Ordinal);
            foreach (var row in raw.RejectedResults.Concat(raw.Results.Select(r => new SearchRejectedResult(r, ""))))
            {
                var key = EpisodeLadder.CandidateKey(row.Result);
                var decision = attempted.Contains(key) && decisions.TryGetValue(key, out var previous)
                    ? previous : EpisodeRejections.Explain(row.Result, accepted, cursor, input.EpisodeMapping, floor, rung.Relaxed,
                        row.Reason.Length > 0 ? row.Reason : null, PremiereYear(input));
                if (!AnimeAudio.Allowed(row.Result.Title, input.MediaType, automationOptions.Value.PreferAnimeDub))
                    decision = decision with { Reasons = decision.Reasons.Concat(["dub_not_preferred"]).ToArray() };
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
                if (input.Background && await BackgroundPolicy(db, settings, input, query, candidate, ct) is { } waiting)
                    return waiting;
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
        return new(false, message) { Query = query, Skipped = true,
            HuntMiss = input.Background && !searchFailed && !decisions.Values.Any(d =>
                !d.Reasons.Contains("other_work") && !d.Reasons.Contains("different_episode") && !d.Reasons.Contains("unknown_episode") && !d.Reasons.Contains("pack")),
            NoReleaseFound = Report(searchFailed ? "search_incomplete" : "no_release") };
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
            Enrich = false, SkipCache = true, Background = input.Background, WaitForBudget = true, Filters = new() { HasMagnet = true, MinSeeders = input.Background ? null : 1 } }, ct);
        var key = input.WorkKey ?? ReleaseNames.WorkKeyFor(title, input.Year);
        var releases = (floor != null
            ? PreferRequestedQuality(response.Results, floor.Value) : response.Results.AsEnumerable()).ToList();
        GrabResult? lastFailure = null;
        while (FilmSelection.Select(releases, key, floor) is { } candidate)
        {
            if (input.Background && await BackgroundPolicy(db, settings, input, title, candidate, ct) is { } waiting)
                return waiting;
            var result = await Send(db, settings, input, title, candidate, beforeSend, false, ct);
            if (result.Ok) return result;
            lastFailure = result;
            releases.Remove(candidate);
        }
        if (lastFailure != null) return lastFailure;
        var message = FilmSelection.NoMatchMessage(title, floor, response.Results.Count, response.Sources, FilmSelection.Summarize(response.Results, key, floor));
        await LogSkip(db, input, title, message, ct);
        return new(false, message) { Query = title, Skipped = true };
    }

    private async Task<GrabResult?> BackgroundPolicy(TorrentFlowDbContext db, ClientSetting settings, GrabInput input,
        string query, TorrentResult candidate, CancellationToken ct)
    {
        var options = automationOptions.Value;
        var identity = LibraryJson.Hash(candidate.InfoHash) ?? LibraryJson.Hash(candidate.Magnet) ?? candidate.TorrentUrl ?? candidate.Id;
        if (input.WatchListItemId != null)
        {
            var watch = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.Id == input.WatchListItemId, ct);
            if (watch != null)
            {
                if (watch.LatestReleaseMagnet == candidate.Magnet && candidate.Magnet != null ||
                    await db.EngineTorrents.AnyAsync(x => x.UserId == LocalUser.Id && x.Hash == identity && x.Status != "removed" && x.Status != "error", ct))
                {
                    if (input.Cursor != null) await Advance(db, watch.Id, input.Cursor.Value, candidate.Title, ct);
                    await LogSkip(db, input, query, "Already sent this release", ct);
                    return new(false, "Already sent this release") { Query = query, Skipped = true };
                }
                var since = watch.SeederWaitSince ?? DateTime.UtcNow;
                if (candidate.Seeders < options.MinimumSeeders && CheckSchedule.WaitingForSeeders(since, DateTime.UtcNow, options))
                {
                    var minutes = Math.Max(1, Math.Ceiling(options.SeederWaitTimeoutMinutes - (DateTime.UtcNow - since).TotalMinutes));
                    var message = $"Waiting for seeders ({candidate.Seeders} of {options.MinimumSeeders}) — retrying in ~{minutes}m";
                    var next = CheckSchedule.Next(DateTime.UtcNow, null, watch.CursorMisses, since, settings.AutomationIntervalMinutes ?? 15, options);
                    await db.WatchListItems.Where(x => x.Id == watch.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.SeederWaitSince, since)
                        .SetProperty(w => w.NextCheckAt, next.At).SetProperty(w => w.NextCheckReason, next.Reason)
                        .SetProperty(w => w.LastChecked, DateTime.UtcNow), ct);
                    await LogSkip(db, input, query, message, ct);
                    return new(false, message) { Query = query, Skipped = true };
                }
            }
        }
        return null;
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
                OverrideStorageCap = input.OverrideStorageCap, Lane = input.QueueLane, RequireMetadata = true }, ct);
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
            return new(false, result.Message) { Query = query, Title = candidate.Title, Magnet = candidate.Magnet, Source = candidate.Source, Storage = storage };
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
            SavePath = savePath, Source = candidate.Source,
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
