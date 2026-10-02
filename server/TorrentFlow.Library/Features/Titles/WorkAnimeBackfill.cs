using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// In the background, in small bounded passes, asks the provider of every catalog work whose anime verdict is unknown
/// (<see cref="Data.Entities.Work.Anime"/> null: TMDB and Cinemeta works saved before it existed) through the one
/// refresh owner, <see cref="WorkNamesRefresh"/>. A filled verdict is never asked again. A provider that answered
/// without a verdict (not found) is noted on the work (<see cref="Data.Entities.Work.AnimeCheckedAt"/>) and asked
/// again a day later, so restarts resume where the last pass stopped instead of starting over. A failed ask is not an
/// answer: it is left unnoted and skipped by this process for an hour. A rate-limited provider (a 429, or no room in
/// the background share) stops the pass, unnoted, until it takes requests again. Its requests are background
/// (<see cref="ProviderPriority"/>): they spend only the provider's background share, and only the request itself waits.
/// </summary>
public sealed class WorkAnimeBackfill(IDbContextFactory<TorrentFlowDbContext> factory, WorkNamesRefresh names, TimeProvider time,
    ILogger<WorkAnimeBackfill> logger, IProviderPacing? pacing = null) : BackgroundService
{
    private const int PerPass = 40;
    private static readonly TimeSpan Pause = TimeSpan.FromSeconds(1.5);
    private static readonly TimeSpan PerWork = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan NextPass = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Idle = TimeSpan.FromHours(6);
    private static readonly TimeSpan Backoff = TimeSpan.FromDays(1);
    private static readonly TimeSpan FailedBackoff = TimeSpan.FromHours(1);
    /// <summary>Works whose last ask failed or was skipped, and when this process may ask about them again.</summary>
    private readonly Dictionary<string, DateTimeOffset> _deferred = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var priority = ProviderPriority.Background();
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
                await Task.Delay(await PassAsync(stoppingToken), time, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    /// <summary>One bounded pass; returns how long to wait before the next.</summary>
    private async Task<TimeSpan> PassAsync(CancellationToken ct)
    {
        var due = time.GetUtcNow().UtcDateTime - Backoff;
        List<(string Key, string Provider)> works;
        await using (var db = await factory.CreateDbContextAsync(ct))
            works = (await Unknown(db, due).OrderBy(w => w.AnimeCheckedAt).ThenBy(w => w.CreatedAt)
                .Select(w => new { w.WorkKey, w.Provider }).Take(PerPass * 4).ToListAsync(ct))
                .Where(w => IMetadataResolver.SupportsProvider(w.Provider!) && !Deferred(w.WorkKey)).Select(w => (w.WorkKey, w.Provider!)).Take(PerPass).ToList();
        if (works.Count == 0)
        {
            logger.LogInformation("Every catalog work knows whether it is anime, or was asked within a day; nothing to backfill");
            return Idle;
        }
        logger.LogInformation("Asking the providers of {Count} works whether they are anime (at most {PerPass} a pass)", works.Count, PerPass);
        var asked = 0;
        foreach (var (key, provider) in works)
        {
            if (Blocked(provider) is { } wait) return Stopped(provider, wait, asked);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(PerWork);
            NamesRefresh outcome;
            try { outcome = await names.RefreshAsync(key, null, fetch: true, budget.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { outcome = NamesRefresh.Failed; logger.LogInformation("Anime verdict of {WorkKey} ran out of time; it is tried again later", key); }
            if (outcome == NamesRefresh.RateLimited) return Stopped(provider, Blocked(provider) ?? TimeSpan.FromMinutes(1), asked);
            if (outcome is NamesRefresh.Failed or NamesRefresh.Skipped) _deferred[key] = time.GetUtcNow() + FailedBackoff;
            if (outcome != NamesRefresh.Skipped) asked++;
            await Task.Delay(Pause, time, ct);
        }
        int left;
        await using (var db = await factory.CreateDbContextAsync(ct))
            left = await Unknown(db, time.GetUtcNow().UtcDateTime - Backoff).CountAsync(ct);
        logger.LogInformation("Anime backfill pass asked {Asked} works; {Left} still due", asked, left);
        return left > 0 && asked > 0 ? NextPass : Idle;
    }

    private static IQueryable<Data.Entities.Work> Unknown(TorrentFlowDbContext db, DateTime due) =>
        db.Works.AsNoTracking().Where(w => w.Anime == null && w.Provider != null && w.ProviderId != null && (w.AnimeCheckedAt == null || w.AnimeCheckedAt < due));

    private bool Deferred(string key) => _deferred.TryGetValue(key, out var until) && until > time.GetUtcNow();

    private TimeSpan? Blocked(string provider) =>
        pacing?.BlockedUntil(provider) is { } until && until - time.GetUtcNow() is var wait && wait > TimeSpan.Zero ? wait : null;

    private TimeSpan Stopped(string provider, TimeSpan wait, int asked)
    {
        logger.LogInformation("{Provider} is rate-limiting or has no room for background requests; the anime backfill stops after {Asked} works and resumes in {Seconds:0} s", provider, asked, wait.TotalSeconds);
        return wait + TimeSpan.FromSeconds(1);
    }
}
