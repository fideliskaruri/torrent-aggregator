using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Scheduling;
using TorrentFlow.Data;
using TorrentFlow.Engine;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Api.Timeline;

public sealed record TimelineEntry(string Id, string Kind, string Title, string? Episode, string? PosterUrl,
    DateTime? At, string? Lane, WaitReason WaitReason, int? QueuePosition = null)
{
    public DateTime? NextCheckAt => Kind == "check" ? At : null;
}

public sealed record TimelineResponse(IReadOnlyList<TimelineEntry> Entries, bool AirTimesUnavailable);

public sealed class TimelineService(IDbContextFactory<TorrentFlowDbContext> factory, IAirDateLookup airDates,
    DownloadLimits limits, IOptionsMonitor<EngineOptions> engineOptions, IOptions<AutomationOptions> automationOptions,
    TimeProvider time, IConfiguration configuration)
{
    public static IReadOnlyList<TimelineEntry> Order(IEnumerable<TimelineEntry> entries) =>
        entries.OrderBy(e => e.At ?? DateTime.MaxValue).ThenBy(e => e.QueuePosition ?? int.MaxValue)
            .ThenBy(e => e.Id, StringComparer.Ordinal).ToList();

    public async Task<TimelineResponse> Get(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        await using var db = await factory.CreateDbContextAsync(ct);
        var monitored = await db.WatchListItems.AsNoTracking().Where(w => w.UserId == LocalUser.Id &&
            w.Monitored == true && (w.Status == "watching" || w.Status == "planned")).ToListAsync(ct);
        var torrents = await db.EngineTorrents.AsNoTracking().Include(t => t.Work)
            .Where(t => t.UserId == LocalUser.Id && t.Origin == TorrentOrigin.User &&
                (t.Status == EngineTorrentStatus.Queued || t.Status == EngineTorrentStatus.Downloading)).ToListAsync(ct);
        var interval = await db.ClientSettings.Where(s => s.UserId == LocalUser.Id)
            .Select(s => s.AutomationIntervalMinutes).FirstOrDefaultAsync(ct);
        var checksEnabled = interval > 0 && !configuration.GetValue<bool>("TorrentFlow:Library:DisableScheduler");
        var entries = new List<TimelineEntry>();
        var options = automationOptions.Value;
        var unavailable = 0;
        // Metadata has its own cache. Bound concurrent lookups and the whole metadata budget so a
        // provider outage cannot hold the read-only timeline (or its next poll) indefinitely.
        using var metadataDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        metadataDeadline.CancelAfter(TimeSpan.FromSeconds(8));
        var airTimes = new System.Collections.Concurrent.ConcurrentDictionary<string, DateTime>();
        await Parallel.ForEachAsync(monitored, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
            async (item, token) =>
            {
                if (EpisodeCursor.Resolve(item) is not { } cursor) return;
                try
                {
                    var air = await airDates.GetAirDateAsync(item.Title, item.MediaType, item.ExternalId,
                        cursor.Season, cursor.Episode, metadataDeadline.Token).WaitAsync(metadataDeadline.Token);
                    if (air is { } date) airTimes[item.Id] = Utc(date);
                }
                catch (Exception) when (!token.IsCancellationRequested) { Interlocked.Exchange(ref unavailable, 1); }
            });
        foreach (var item in monitored)
        {
            DateTime? air = airTimes.TryGetValue(item.Id, out var date) ? date : null;
            var cursor = EpisodeCursor.Resolve(item);
            var wait = WaitReasonService.Evaluate(new()
            {
                AirDate = air, SeederWaitSince = Utc(item.SeederWaitSince), NextCheckAt = Utc(item.NextCheckAt),
                MinimumSeeders = options.MinimumSeeders, SeederWaitTimeoutMinutes = options.SeederWaitTimeoutMinutes
            }, now.UtcDateTime);
            if (checksEnabled)
                entries.Add(new($"check:{item.Id}", "check", item.Title, cursor?.Label, item.PosterUrl,
                    Utc(item.NextCheckAt) ?? now.UtcDateTime, null, wait));
            if (WaitReasonService.IsFuture(air, now.UtcDateTime))
                entries.Add(new($"airs:{item.Id}", "airs", item.Title, cursor?.Label, item.PosterUrl, air, null,
                    WaitReasonService.Evaluate(new() { AirDate = air }, now.UtcDateTime)));
        }
        var windows = limits.Windows;
        var schedule = DownloadWindows.Evaluate(windows, time.GetLocalNow());
        var cap = Math.Max(1, schedule.Active?.MaxActiveDownloads ?? limits.MaxActiveOverride ?? engineOptions.CurrentValue.MaxActiveDownloads);
        var opening = schedule.Open ? null : DownloadWindows.NextStart(windows, now, time.LocalTimeZone);
        var rows = torrents.Select(t => new QueueRow(t.Hash, t.Status, t.Origin, t.CreatedAt,
            t.WorkId, t.QueueKey, t.ForcedAt, t.SizeBytes, t.Lane)).ToList();
        var queued = DownloadQueue.Order(rows);
        var bestLane = queued.Select(q => (int?)q.Lane).Min();
        var byHash = torrents.ToDictionary(t => t.Hash, StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < queued.Count; index++)
        {
            var row = queued[index];
            var torrent = byHash[row.Hash];
            var wait = WaitReasonService.Evaluate(new()
            {
                Queued = true, WindowOpen = schedule.Open, NextWindowStart = opening,
                MaxActive = cap, Lane = row.Lane, BestQueuedLane = bestLane
            }, now.UtcDateTime);
            var episode = EpisodeCursor.Parse(row.QueueKey) ?? EpisodeCursor.Parse(torrent.Name);
            entries.Add(new($"queued:{row.Hash}", "queued", torrent.Work?.CanonicalTitle ?? torrent.Name,
                episode?.Label, torrent.Work?.PosterUrl, wait.Until, TorrentLane.FromRank(row.Lane), wait, index + 1));
        }
        return new(Order(entries), unavailable != 0);
    }

    private static DateTime Utc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);
    private static DateTime? Utc(DateTime? value) => value is { } date ? Utc(date) : null;
}

public static class TimelineEndpoints
{
    public static void MapTimelineEndpoints(this WebApplication app) =>
        app.MapGet("/api/timeline", async (TimelineService service, HttpContext http, CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(await service.Get(ct));
        });
}
