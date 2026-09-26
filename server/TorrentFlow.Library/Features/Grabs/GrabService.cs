using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Library.Features.Storage;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record GrabInput(string Title, string MediaType, EpisodeCursor? Cursor = null,
    string? WatchListItemId = null, string? WorkId = null, int? PreferredResolution = null,
    string Retention = "keep", bool OverrideStorageCap = false, IReadOnlyList<string>? Aliases = null,
    bool Background = false, int? Year = null, string? WorkKey = null, string? Lane = null)
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
    public int Attempted { get; set; }
}

public sealed class GrabService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search, ITorrentEngine engine)
{
    public async Task<GrabResult> Grab(GrabInput input, CancellationToken ct, Func<Task>? beforeSend = null)
    {
        var query = input.Cursor?.Query(input.Title) ?? input.Title;
        await using var db = await factory.CreateDbContextAsync(ct);
        var settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == LocalUser.Id, ct);
        if (settings == null) return new(false, "No torrent client configured") { Query = query };
        int? floor = input.Retention == "stream" ? null : input.PreferredResolution ?? settings.PreferredResolution ?? 1080;
        if (input.Background) return await Hunt(db, settings, input, query, floor, ct);
        if (input.Cursor is { } cursor) return await Episode(db, settings, input, cursor, query, floor, beforeSend, ct);
        return await Film(db, settings, input, floor, beforeSend, ct);
    }

    /// <summary>Port of grabSingleEpisode's ladder: each rung is searched once, and the first working send wins.</summary>
    private async Task<GrabResult> Episode(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, EpisodeCursor cursor,
        string query, int? floor, Func<Task>? beforeSend, CancellationToken ct)
    {
        var rungs = EpisodeLadder.BuildEpisodeRungs(input.Title, cursor, input.MediaType, input.Aliases, floor);
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        var memo = new Dictionary<string, SearchResponse>(StringComparer.Ordinal);
        var attempted = new HashSet<string>(StringComparer.Ordinal);
        var diagnostics = new List<RungDiagnostic>();
        GrabResult? lastFailure = null;
        foreach (var rung in rungs)
        {
            if (!memo.TryGetValue(rung.SearchKey, out var raw))
            {
                // `Limit` caps what is fetched and `PageSize` what is returned; both must be 40 or the single is paged away.
                raw = await search.SearchAsync(new() { Query = rung.Query, Category = rung.Category, Limit = EpisodeLadder.SearchLimit,
                    PageSize = EpisodeLadder.SearchLimit, TargetResolution = floor ?? input.PreferredResolution, Enrich = false,
                    SkipCache = true, Background = false, Filters = rung.Filters }, ct);
                memo[rung.SearchKey] = raw;
            }
            var work = raw.Results.Where(x => EpisodeLadder.ReleaseMatchesWork(x, accepted)).ToList();
            var quality = floor == null ? work : work.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor)).ToList();
            var diagnostic = new RungDiagnostic { Kind = rung.Kind, Query = rung.Query, Category = rung.Category, MinSeeders = rung.Filters.MinSeeders,
                Fetched = raw.Results.Count, WorkEligible = work.Count, QualityEligible = quality.Count };
            diagnostics.Add(diagnostic);
            while (EpisodeLadder.Select(rung, quality, cursor, attempted) is { } candidate)
            {
                attempted.Add(EpisodeLadder.CandidateKey(candidate));
                diagnostic.Attempted++;
                var result = await Send(db, settings, input, query, candidate, beforeSend, rung.Relaxed, ct);
                if (result.Ok) return result;
                // One bad pick no longer ends the attempt: fall through to the next candidate, then the next rung.
                lastFailure = result;
            }
        }
        var searches = memo.Count;
        object Report(string reason) => new { reason, searches, triedSeasonPacks = false, manualSearchQuery = query, rungs = diagnostics };
        if (lastFailure != null) return lastFailure with { NoReleaseFound = Report("send_failed") };
        var qualityLabel = floor == null ? "" : $" at {floor}p or higher";
        var message = $"Couldn't find a working release for {cursor.Label}{qualityLabel} after {searches} distinct query shape{(searches == 1 ? "" : "s")}. Try again in a bit — another eligible release may show up.";
        await LogSkip(db, input, query, message, ct);
        return new(false, message) { Query = query, Skipped = true, NoReleaseFound = Report("no_release") };
    }

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
        var candidate = FilmSelection.Select(response.Results, key, floor);
        if (candidate == null)
        {
            var message = FilmSelection.NoMatchMessage(title, floor, response.Results.Count, response.Sources, FilmSelection.Summarize(response.Results, key, floor));
            await LogSkip(db, input, title, message, ct);
            return new(false, message) { Query = title, Skipped = true };
        }
        return await Send(db, settings, input, title, candidate, beforeSend, false, ct);
    }

    /// <summary>Automation's single background search (TS automation runner), with its seeder-wait grace.</summary>
    private async Task<GrabResult> Hunt(TorrentFlowDbContext db, ClientSetting settings, GrabInput input, string query, int? floor, CancellationToken ct)
    {
        // Unknown media type falls back to "all": a library row can be a film as well as a series.
        var category = EpisodeLadder.SearchCategory(input.MediaType) ?? "all";
        // Deliberately no seeder floor: a brand-new episode sits at 0 seeders; the wait below owns that decision.
        var response = await search.SearchAsync(new() { Query = query, Category = category, Limit = 15, TargetResolution = floor, Enrich = false,
            SkipCache = true, Background = true, Filters = new() { HasMagnet = true, Season = input.Cursor?.Season, Episode = input.Cursor?.Episode } }, ct);
        var eligible = response.Results.Where(x => ReleaseSelection.SameWork(x, input.Title, input.Aliases ?? [])).ToList();
        var exactBeforeQuality = eligible.Count(x => input.Cursor == null || ReleaseSelection.ExactEpisode(x, input.Cursor.Value));
        var quality = eligible.Where(x => ReleaseSelection.MeetsFloor(x.Title, floor)).ToList();
        var candidates = quality.Where(x => input.Cursor == null ? !EpisodeCursor.IsSeries(x.Metadata?.MediaType) && EpisodeCursor.Parse(x.Title) == null &&
                (input.Year == null || ReleaseSelection.Year(x.Title) == null || ReleaseSelection.Year(x.Title) == input.Year) :
                ReleaseSelection.ExactEpisode(x, input.Cursor.Value))
            .Where(x => x.Magnet != null || x.TorrentUrl != null || x.InfoHash != null)
            .OrderByDescending(x => x.Seeders >= 3).ThenByDescending(x => ReleaseSelection.Resolution(x.Title) == floor).ThenByDescending(x => x.Score ?? x.Seeders).ToList();
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
                    if (candidate.Seeders < 3 && DateTime.UtcNow - since < TimeSpan.FromHours(6))
                    {
                        var hours = Math.Max(1, Math.Floor(6 - (DateTime.UtcNow - since).TotalHours + .5));
                        var message = $"Waiting for seeders ({candidate.Seeders} of 3) — grabbing anyway in ~{hours}h if no peers arrive";
                        await db.WatchListItems.Where(x => x.Id == watch.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.SeederWaitSince, since)
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
        var noRelease = $"Couldn't find a working release for {label}{qualityLabel} after 1 distinct query shape. Try again in a bit — another eligible release may show up.";
        if (lastError == null) await LogSkip(db, input, query, noRelease, ct);
        var rungs = new[] { new RungDiagnostic { Kind = "exact", Query = query, Category = category, Fetched = response.Results.Count,
            WorkEligible = eligible.Count, QualityEligible = quality.Count, Attempted = attempts.Count } };
        return new(false, lastError ?? noRelease) { Query = query, HuntMiss = lastError == null && exactBeforeQuality == 0, Skipped = lastError == null,
            NoReleaseFound = new { reason = lastError == null ? "no_release" : "send_failed", searches = 1, triedSeasonPacks = false, manualSearchQuery = query, rungs } };
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
                Metadata = CatalogMetadata(input.MediaType, input.Title),
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
                    .SetProperty(w => w.SeederWaitSince, (DateTime?)null), ct);
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
    private static TorrentFlow.Core.Contracts.Metadata.MediaMetadata? CatalogMetadata(string? mediaType, string? title)
    {
        var type = (mediaType ?? "").Trim().ToLowerInvariant();
        var name = (title ?? "").Trim();
        if (type is not ("anime" or "movie" or "tv") || name.Length == 0) return null;
        return new() { Source = type == "anime" ? "anilist" : "tmdb", MediaType = type, ExternalId = "", Title = name };
    }

    private static async Task LogSkip(TorrentFlowDbContext db, GrabInput input, string query, string message, CancellationToken ct)
    {
        db.GrabJobs.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = input.Title, Query = query, Status = "skipped",
            Message = message, Kind = input.Background ? "library" : "ondemand", ExternalId = input.WatchListItemId, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }

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
                .SetProperty(w => w.LastChecked, now).SetProperty(w => w.UpdatedAt, now)
                .SetProperty(w => w.LatestReleaseTitle, title).SetProperty(w => w.LatestReleaseAt, now)
                .SetProperty(w => w.FromSeason, item.FromSeason ?? grabbed.Season).SetProperty(w => w.FromEpisode, item.FromSeason == null ? grabbed.Episode : item.FromEpisode), ct);
        return moved > 0;
    }
}
