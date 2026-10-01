using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Once per start, in the background and throttled, asks the provider of every catalog work whose anime verdict is
/// unknown (<see cref="Data.Entities.Work.Anime"/> null: TMDB and Cinemeta works saved before it existed) through the one
/// refresh owner, <see cref="WorkNamesRefresh"/>. A filled verdict is never asked again, so a restart with every verdict
/// known loads nothing; a failed lookup stays unknown for the next start or the work's next grab.
/// </summary>
public sealed class WorkAnimeBackfill(IDbContextFactory<TorrentFlowDbContext> factory, WorkNamesRefresh names, TimeProvider time,
    ILogger<WorkAnimeBackfill> logger) : BackgroundService
{
    private static readonly TimeSpan Pause = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan PerWork = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), time, stoppingToken);
            await PassAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    private async Task PassAsync(CancellationToken ct)
    {
        List<(string Key, string Provider)> works;
        await using (var db = await factory.CreateDbContextAsync(ct))
            works = (await db.Works.AsNoTracking().Where(w => w.Anime == null && w.Provider != null && w.ProviderId != null)
                .OrderBy(w => w.CreatedAt).Select(w => new { w.WorkKey, w.Provider }).ToListAsync(ct))
                .Where(w => IMetadataResolver.SupportsProvider(w.Provider!)).Select(w => (w.WorkKey, w.Provider!)).ToList();
        if (works.Count == 0)
        {
            logger.LogInformation("Every catalog work already knows whether it is anime; nothing to backfill");
            return;
        }
        logger.LogInformation("Asking the providers of {Count} works whether they are anime", works.Count);
        foreach (var (key, _) in works)
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(PerWork);
            try { await names.RefreshAsync(key, null, fetch: true, budget.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { logger.LogInformation("Anime verdict of {WorkKey} ran out of time; it is tried again later", key); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Anime verdict of {WorkKey} failed", key); }
            await Task.Delay(Pause, time, ct);
        }
        await using (var db = await factory.CreateDbContextAsync(ct))
            logger.LogInformation("Finished the anime backfill; {Unknown} works still unknown",
                await db.Works.CountAsync(w => w.Anime == null && w.Provider != null && w.ProviderId != null, ct));
    }
}
