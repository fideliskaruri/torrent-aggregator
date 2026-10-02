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
/// answer: it is left unnoted and passed over by this process for an hour, without crowding out the works it may ask
/// now. A pass that has nothing to ask rests until the first put-off or day-old check comes due (at most six hours), and
/// a pass that fails (a busy database, say) is logged and tried again after a growing pause; it never stops the server.
/// A rate-limited provider (a 429, or no room in the background share) stops the pass, unnoted, until it takes requests
/// again. Its requests are background (<see cref="ProviderPriority"/>): they spend only the provider's background
/// share, and only the request itself waits.
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
    private static readonly TimeSpan MaxRetry = TimeSpan.FromMinutes(30);
    /// <summary>Works whose last ask failed or was skipped, and when this process may ask about them again; each pass drops the expired ones.</summary>
    private readonly Dictionary<string, DateTimeOffset> _deferred = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var priority = ProviderPriority.Background();
        var failures = 0;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                TimeSpan wait;
                try
                {
                    wait = await PassAsync(stoppingToken);
                    failures = 0;
                }
                catch (Exception error) when (!stoppingToken.IsCancellationRequested)
                {
                    // A failed pass (a busy database, say) never ends the service, let alone the server: it backs off and tries again.
                    wait = TimeSpan.FromMinutes(Math.Min(MaxRetry.TotalMinutes, Math.Pow(2, failures++)));
                    logger.LogWarning(error, "The anime backfill pass failed; it tries again in {Minutes:0} min", wait.TotalMinutes);
                }
                await Task.Delay(wait, time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    /// <summary>One bounded pass; returns how long to wait before the next.</summary>
    private async Task<TimeSpan> PassAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        foreach (var expired in _deferred.Where(d => d.Value <= now).Select(d => d.Key).ToList()) _deferred.Remove(expired);
        var works = await AskableAsync(PerPass, ct);
        if (works.Count == 0) return await RestAsync(ct);
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
        // Another pass soon while any due work may be asked now; a long rest only when none may.
        return (await AskableAsync(1, ct)).Count > 0 ? NextPass : await RestAsync(ct);
    }

    /// <summary>
    /// Up to <paramref name="limit"/> due works this process may ask now, oldest check first. Works put off after a failed
    /// or skipped ask are passed over before the limit is counted, so however many there are they never crowd out the rest.
    /// </summary>
    private async Task<List<(string Key, string Provider)>> AskableAsync(int limit, CancellationToken ct)
    {
        var works = new List<(string Key, string Provider)>();
        await using var db = await factory.CreateDbContextAsync(ct);
        await foreach (var work in Unknown(db, time.GetUtcNow().UtcDateTime - Backoff).OrderBy(w => w.AnimeCheckedAt).ThenBy(w => w.CreatedAt)
            .Select(w => new { w.WorkKey, w.Provider }).AsAsyncEnumerable().WithCancellation(ct))
        {
            if (Deferred(work.WorkKey)) continue;
            works.Add((work.WorkKey, work.Provider!));
            if (works.Count >= limit) break;
        }
        return works;
    }

    /// <summary>Nothing to ask now: rests until the first put-off work or day-old check comes due again, at most <see cref="Idle"/>.</summary>
    private async Task<TimeSpan> RestAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var wake = now + Idle;
        foreach (var until in _deferred.Values) if (until < wake) wake = until;
        var cutoff = now.UtcDateTime - Backoff;
        DateTime? oldest;
        await using (var db = await factory.CreateDbContextAsync(ct))
            oldest = await Candidates(db).Where(w => w.AnimeCheckedAt != null && w.AnimeCheckedAt >= cutoff)
                .OrderBy(w => w.AnimeCheckedAt).Select(w => w.AnimeCheckedAt).FirstOrDefaultAsync(ct);
        if (oldest is { } checkedAt && new DateTimeOffset(DateTime.SpecifyKind(checkedAt, DateTimeKind.Utc)) + Backoff is var due && due < wake) wake = due;
        var rest = wake - now < TimeSpan.FromMinutes(1) ? TimeSpan.FromMinutes(1) : wake - now;
        logger.LogInformation("No work to ask whether it is anime right now ({Deferred} put off after a failed ask); the anime backfill looks again in {Minutes:0} min",
            _deferred.Count, rest.TotalMinutes);
        return rest;
    }

    /// <summary>Catalog works whose anime verdict is unknown and whose provider can be asked.</summary>
    private static IQueryable<Data.Entities.Work> Candidates(TorrentFlowDbContext db) =>
        db.Works.AsNoTracking().Where(w => w.Anime == null && w.Provider != null && w.ProviderId != null && IMetadataResolver.Providers.Contains(w.Provider));

    private static IQueryable<Data.Entities.Work> Unknown(TorrentFlowDbContext db, DateTime due) =>
        Candidates(db).Where(w => w.AnimeCheckedAt == null || w.AnimeCheckedAt < due);

    private bool Deferred(string key) => _deferred.TryGetValue(key, out var until) && until > time.GetUtcNow();

    private TimeSpan? Blocked(string provider) =>
        pacing?.BlockedUntil(provider) is { } until && until - time.GetUtcNow() is var wait && wait > TimeSpan.Zero ? wait : null;

    private TimeSpan Stopped(string provider, TimeSpan wait, int asked)
    {
        logger.LogInformation("{Provider} is rate-limiting or has no room for background requests; the anime backfill stops after {Asked} works and resumes in {Seconds:0} s", provider, asked, wait.TotalSeconds);
        return wait + TimeSpan.FromSeconds(1);
    }
}