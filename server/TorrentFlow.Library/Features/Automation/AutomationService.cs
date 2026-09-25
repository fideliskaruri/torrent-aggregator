using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

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
    ITorrentEngine engine, GrabService grabs)
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
                                Purpose = "keep", ExpectedSizeBytes = candidate.SizeBytes }, ct);
                            message = send.Message;
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
    public async Task<Dictionary<string, object?>> Run(CancellationToken ct)
    {
        var token = await Lock("automation", ct);
        if (token == null) return Summary([], 0, 0, 0, 0, 0, "Automation is already running — ignored this request");
        try
        {
            var rules = await Rules(ct);
            await using var db = await factory.CreateDbContextAsync(ct);
            var items = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.Monitored == true &&
                (x.Status == "watching" || x.Status == "planned")).OrderBy(x => x.LastChecked).ToListAsync(ct);
            int checkedCount = 0, sent = 0, skipped = 0, failed = 0, deferred = 0;
            foreach (var item in items)
            {
                var elapsed = DateTime.UtcNow - item.LastChecked;
                if (elapsed >= TimeSpan.Zero && elapsed < EpisodeCursor.Backoff(item.CursorMisses)) { deferred++; continue; }
                checkedCount++;
                var cursor = EpisodeCursor.Resolve(item);
                try
                {
                    var result = await grabs.Grab(new(item.Title, item.MediaType, cursor, item.Id, item.WorkId, item.PreferredResolution, Background: true), ct);
                    if (result.Ok) sent++;
                    else if (result.Skipped) skipped++;
                    else failed++;
                    if (result.HuntMiss)
                    {
                        var next = cursor?.AfterMiss(item.CursorMisses);
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
                }
                catch (Exception) when (!ct.IsCancellationRequested) { failed++; }
            }
            return Summary(rules, checkedCount, sent, skipped, failed, deferred,
                $"Rules: {rules.Count} ran, {rules.Count(x => x.Matched)} matched. Library: {checkedCount} checked, {sent} sent, {skipped} skipped, {failed} failed" +
                (deferred > 0 ? $", {deferred} waiting (repeated misses)" : ""));
        }
        finally { await Unlock(token); }
    }
    private static Dictionary<string, object?> Summary(IReadOnlyList<RuleRunResult> rules, int checkedCount, int sent, int skipped, int failed, int deferred, string message) =>
        LibraryJson.Object(("rules", new { ran = rules.Count, matched = rules.Count(x => x.Matched), messages = rules.Select(x => new { x.RuleId, x.Matched, x.Title, x.Message, x.Status }) }),
            ("library", new { @checked = checkedCount, sent, skipped, failed, deferred }), ("offline", false), ("message", message));
}
