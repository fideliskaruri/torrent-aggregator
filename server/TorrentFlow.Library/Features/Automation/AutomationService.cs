using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Core.Scheduling;

namespace TorrentFlow.Library.Features.Automation;

public sealed record RuleRunResult(string RuleId, bool Matched, string Message, string Status)
{
    public string? Title { get; init; }
    public string? Magnet { get; init; }
    public string? InfoHash { get; init; }
    public string? Source { get; init; }
    public string? SavePath { get; init; }
    public string? Category { get; init; }
}

public sealed class AutomationService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentSearchService search,
    ITorrentEngine engine, GrabService grabs, IAirDateLookup airDates, IOptions<AutomationOptions> options)
{
    private async Task<string?> Lock(string scope, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var expired = DateTime.UtcNow.AddMinutes(-15);
        await db.RunLocks.Where(x => x.UserId == LocalUser.Id && x.Scope == scope && x.AcquiredAt < expired).ExecuteDeleteAsync(ct);
        var id = Ids.New();
        db.RunLocks.Add(new() { Id = id, UserId = LocalUser.Id, Scope = scope, AcquiredAt = DateTime.UtcNow });
        try { await db.SaveChangesAsync(ct); return id; }
        catch (DbUpdateException) { return null; }
    }
    private async Task Unlock(string id)
    {
        await using var db = await factory.CreateDbContextAsync();
        await db.RunLocks.Where(x => x.Id == id).ExecuteDeleteAsync();
    }
    public static bool MatchesCategory(TorrentResult result, string category)
    {
        var kind = result.Metadata?.MediaType ?? (result.Source == "nyaa" ? "anime" : EpisodeCursor.Parse(result.Title) != null ? "tv" : result.Source == "yts" ? "movie" : null);
        return category switch { "anime" => kind == "anime", "movies" => kind == "movie", "tv" => kind is "tv" or "anime", _ => true };
    }
    public async Task<IReadOnlyList<RuleRunResult>> Rules(CancellationToken ct)
    {
        var token = await Lock("rules", ct);
        if (token == null) return [];
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var rules = await db.AutoRules.Where(x => x.UserId == LocalUser.Id && x.Enabled == true).ToListAsync(ct);
            var summary = new List<RuleRunResult>();
            foreach (var rule in rules)
            {
                TorrentResult? candidate = null;
                EngineAddResult? send = null;
                var message = "No matching torrents";
                var status = "skipped";
                try
                {
                    var response = await search.SearchAsync(new() { Query = rule.Query, Category = rule.Category, Limit = 15,
                        Sources = rule.Sources?.Split(','), Enrich = true, SkipCache = true, Background = true,
                        Filters = new() { MinSeeders = rule.MinSeeders, MaxSizeBytes = rule.MaxSizeBytes, Resolution = rule.Resolution, HasMagnet = true } }, ct);
                    candidate = response.Results.FirstOrDefault(x => x.Magnet != null && MatchesCategory(x, rule.Category) &&
                        x.Seeders >= rule.MinSeeders && (rule.MaxSizeBytes == null || x.SizeBytes <= rule.MaxSizeBytes) &&
                        (rule.Resolution == null || ReleaseSelection.Resolution(x.Title)?.ToString() + "p" == rule.Resolution));
                    if (candidate != null)
                    {
                        if (candidate.Magnet == rule.LastMatchMagnet) message = "Already sent this release";
                        else
                        {
                            send = await engine.AddAsync(new() { Magnet = candidate.Magnet, InfoHash = candidate.InfoHash, Name = candidate.Title,
                                Source = candidate.Source, SearchCategory = rule.Category, Metadata = candidate.Metadata,
                                Purpose = "keep", ExpectedSizeBytes = candidate.SizeBytes, Lane = TorrentLane.Automation }, ct);
                            message = EngineAddMessages.Format(send);
                            status = send.Ok ? "sent" : "failed";
                            if (send.Ok)
                            {
                                rule.LastMatchTitle = candidate.Title; rule.LastMatchMagnet = candidate.Magnet; rule.MatchCount++;
                                db.DownloadHistories.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate.Title, Magnet = candidate.Magnet,
                                    InfoHash = send.Hash, Source = candidate.Source, Status = status, Message = message, CreatedAt = DateTime.UtcNow,
                                    Context = $"Auto-rule: {rule.Name}", ClientType = "builtin", SendKind = "magnet", Retention = "keep" });
                            }
                        }
                    }
                    else if (response.Results.Count > 0) message = $"No {rule.Category} releases in {response.Results.Count} results";
                }
                catch (Exception error) when (!ct.IsCancellationRequested) { status = "failed"; message = error.Message; }
                rule.LastRunAt = rule.UpdatedAt = DateTime.UtcNow;
                var result = new RuleRunResult(rule.Id, status is "sent" or "failed" && candidate != null, message, status)
                { Title = candidate?.Title, Magnet = candidate?.Magnet, InfoHash = send?.Hash ?? candidate?.InfoHash, Source = candidate?.Source };
                summary.Add(result);
                db.GrabJobs.Add(new() { Id = Ids.New(), UserId = LocalUser.Id, Title = candidate?.Title ?? rule.Query, Query = rule.Query,
                    Status = status, Message = message, Magnet = candidate?.Magnet, InfoHash = result.InfoHash, Source = candidate?.Source,
                    Kind = "rule", ExternalId = rule.Id, Retention = "keep", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
                await db.SaveChangesAsync(ct);
            }
            return summary;
        }
        finally { await Unlock(token); }
    }
    public Task<Dictionary<string, object?>> Run(CancellationToken ct) => RunCore(null, true, ct);

    public Task<Dictionary<string, object?>> Run(IReadOnlyCollection<string> itemIds, CancellationToken ct, bool includeRules = false) =>
        RunCore(itemIds, includeRules, ct);

    private async Task<Dictionary<string, object?>> RunCore(IReadOnlyCollection<string>? itemIds, bool includeRules, CancellationToken ct)
    {
        var token = await Lock("automation", ct);
        if (token == null) return Summary([], 0, 0, 0, 0, 0, "Automation is already running — ignored this request");
        try
        {
            IReadOnlyList<RuleRunResult> rules = includeRules ? await Rules(ct) : [];
            await using var db = await factory.CreateDbContextAsync(ct);
            var query = db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Monitored == true &&
                (x.Status == "watching" || x.Status == "planned"));
            if (itemIds != null) query = query.Where(x => itemIds.Contains(x.Id));
            var items = await query.OrderBy(x => x.NextCheckAt).ThenBy(x => x.LastChecked).ToListAsync(ct);
            var interval = await db.ClientSettings.Where(x => x.UserId == LocalUser.Id)
                .Select(x => x.AutomationIntervalMinutes).FirstOrDefaultAsync(ct) ?? 15;
            int checkedCount = 0, sent = 0, skipped = 0, failed = 0, deferred = 0;
            var searched = false;
            foreach (var item in items)
            {
                var now = DateTime.UtcNow;
                if (itemIds != null && WaitReasonService.IsFuture(item.NextCheckAt, now)) { deferred++; continue; }
                var cursor = EpisodeCursor.Resolve(item);
                DateTime? airDate = null;
                try
                {
                    airDate = await AirDate(item, cursor, ct);
                    if (WaitReasonService.IsFuture(airDate, now))
                    {
                        await SaveSchedule(db, item, CheckSchedule.Next(now, airDate, item.CursorMisses, null, interval, options.Value), ct);
                        deferred++; continue;
                    }
                    var elapsed = now - item.LastChecked;
                    if (item.NextCheckAt == null && !CheckSchedule.FreshlyAired(airDate, now) &&
                        !CheckSchedule.WaitingForSeeders(item.SeederWaitSince, now, options.Value) &&
                        elapsed >= TimeSpan.Zero && elapsed < EpisodeCursor.Backoff(item.CursorMisses))
                    {
                        var at = item.LastChecked + EpisodeCursor.Backoff(item.CursorMisses);
                        await SaveSchedule(db, item, new(at, "next check"), ct);
                        deferred++; continue;
                    }
                    if (searched) await Task.Delay(options.Value.ItemSpacingMilliseconds, ct);
                    searched = true;
                    checkedCount++;
                    var result = await grabs.Grab(new(item.Title, item.MediaType, cursor, item.Id, item.WorkId, item.PreferredResolution, Background: true), ct);
                    if (result.Ok) sent++;
                    else if (result.Skipped) skipped++;
                    else failed++;
                    if (result.HuntMiss)
                    {
                        var next = CheckSchedule.FreshlyAired(airDate, now) ? null : cursor?.AfterMiss(item.CursorMisses);
                        var misses = next?.Misses ?? item.CursorMisses + 1;
                        await db.WatchListItems.Where(x => x.Id == item.Id && x.CursorSeason == item.CursorSeason && x.CursorEpisode == item.CursorEpisode)
                            .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorMisses, misses), ct);
                        if (next != null && next.Value.Cursor != cursor)
                        {
                            var moved = next.Value.Cursor;
                            await db.WatchListItems.Where(x => x.Id == item.Id && x.CursorSeason == item.CursorSeason && x.CursorEpisode == item.CursorEpisode)
                                .ExecuteUpdateAsync(x => x.SetProperty(w => w.CursorSeason, moved.Season).SetProperty(w => w.CursorEpisode, moved.Episode)
                                    .SetProperty(w => w.NextEpisodeHint, moved.Label).SetProperty(w => w.SeederWaitSince, (DateTime?)null), ct);
                        }
                    }
                    await db.WatchListItems.Where(x => x.Id == item.Id).ExecuteUpdateAsync(x => x.SetProperty(w => w.LastChecked, DateTime.UtcNow), ct);
                    var current = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == item.Id, ct);
                    if (current != null)
                    {
                        if (EpisodeCursor.Resolve(current) != cursor) airDate = await AirDate(current, EpisodeCursor.Resolve(current), ct);
                        await SaveSchedule(db, current, CheckSchedule.Next(DateTime.UtcNow, airDate, current.CursorMisses,
                            current.SeederWaitSince, interval, options.Value), ct);
                    }
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    failed++;
                    var current = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(x => x.Id == item.Id, ct);
                    if (current != null && EpisodeCursor.Resolve(current) == cursor)
                        await SaveSchedule(db, current, CheckSchedule.Next(DateTime.UtcNow, airDate, current.CursorMisses,
                            current.SeederWaitSince, interval, options.Value), ct);
                }
            }
            return Summary(rules, checkedCount, sent, skipped, failed, deferred,
                $"Rules: {rules.Count} ran, {rules.Count(x => x.Matched)} matched. Library: {checkedCount} checked, {sent} sent, {skipped} skipped, {failed} failed" +
                (deferred > 0 ? $", {deferred} waiting for their next check" : ""));
        }
        finally { await Unlock(token); }
    }

    private async Task<DateTime?> AirDate(WatchListItem item, EpisodeCursor? cursor, CancellationToken ct)
    {
        if (cursor == null) return null;
        try { return await airDates.GetAirDateAsync(item.Title, item.MediaType, item.ExternalId, cursor.Value.Season, cursor.Value.Episode, ct); }
        catch (Exception) when (!ct.IsCancellationRequested) { return null; }
    }

    private static Task<int> SaveSchedule(TorrentFlowDbContext db, WatchListItem item, CheckSchedule next, CancellationToken ct) =>
        db.WatchListItems.Where(x => x.Id == item.Id && x.UpdatedAt == item.UpdatedAt && x.Monitored == true &&
            (x.Status == "watching" || x.Status == "planned"))
            .ExecuteUpdateAsync(x => x.SetProperty(w => w.NextCheckAt, next.At).SetProperty(w => w.NextCheckReason, next.Reason), ct);
    private static Dictionary<string, object?> Summary(IReadOnlyList<RuleRunResult> rules, int checkedCount, int sent, int skipped, int failed, int deferred, string message) =>
        LibraryJson.Object(("rules", new { ran = rules.Count, matched = rules.Count(x => x.Matched), messages = rules.Select(x => new { x.RuleId, x.Matched, x.Title, x.Message, x.Status }) }),
            ("library", new { @checked = checkedCount, sent, skipped, failed, deferred }), ("offline", false), ("message", message));
}
