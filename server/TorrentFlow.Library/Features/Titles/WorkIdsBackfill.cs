using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;

namespace TorrentFlow.Library.Features.Titles;

/// <summary>
/// Once per start, in the background, reads the TVmaze record of every TVmaze work known only by its TVmaze id
/// (<see cref="WorkNamesRefresh.MissingTvmazeIds"/>: saved before TVmaze records carried their IMDb and TheTVDB ids) and
/// saves it through the one refresh owner, <see cref="WorkNamesRefresh"/>, so those ids become verified links and
/// <see cref="Data.Entities.Work.IdsJson"/> is rebuilt from them. A download from TMDB's or Cinemeta's record of the show
/// then finds the stored work instead of making a second one. Idempotent: a work with either id is never asked again, and
/// a show TVmaze gives neither id stays as it is (asked again on the next start, or at most once a day when its page
/// opens). Its requests are background (<see cref="ProviderPriority"/>), one at a time; TVmaze's client spaces its own
/// calls. A work TVmaze couldn't answer for is tried again on a later pass, a few times; a failed pass never stops the server.
/// </summary>
public sealed class WorkIdsBackfill(IDbContextFactory<TorrentFlowDbContext> factory, IMetadataResolver metadata, WorkNamesRefresh names,
    TimeProvider time, ILogger<WorkIdsBackfill> logger) : BackgroundService
{
    private static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan Pause = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan PerWork = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan NextPass = TimeSpan.FromMinutes(10);
    private const int Passes = 3;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var priority = ProviderPriority.Background();
        try
        {
            await Task.Delay(StartDelay, time, stoppingToken);
            // Works this start already read: filled, or TVmaze gives them neither id.
            var answered = new HashSet<string>(StringComparer.Ordinal);
            for (var pass = 1; pass <= Passes; pass++)
            {
                if (pass > 1) await Task.Delay(NextPass, time, stoppingToken);
                try
                {
                    if (await PassAsync(answered, stoppingToken) == 0) return;
                }
                catch (Exception error) when (!stoppingToken.IsCancellationRequested)
                {
                    logger.LogWarning(error, "The TVmaze ids backfill pass failed; it tries again in {Minutes:0} min", NextPass.TotalMinutes);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    /// <summary>One pass over the works still known only by their TVmaze id; returns how many TVmaze couldn't answer for.</summary>
    private async Task<int> PassAsync(HashSet<string> answered, CancellationToken ct)
    {
        List<(string Key, string Id)> due;
        await using (var db = await factory.CreateDbContextAsync(ct))
            due = (await db.Works.AsNoTracking().Where(w => w.Provider == "tvmaze" && w.ProviderId != null).ToListAsync(ct))
                .Where(w => WorkNamesRefresh.MissingTvmazeIds(w) && !answered.Contains(w.WorkKey)).Select(w => (w.WorkKey, w.ProviderId!)).ToList();
        if (due.Count == 0) return 0;
        logger.LogInformation("Reading the TVmaze records of {Count} works known only by their TVmaze id, for their IMDb and TheTVDB ids", due.Count);
        var (filled, none, unanswered) = (0, 0, 0);
        foreach (var (key, id) in due)
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(PerWork);
            try
            {
                var record = await metadata.GetByIdAsync("tvmaze", "tv", id, budget.Token);
                if (record == null || record.Source != "tvmaze" || record.ExternalId != id) unanswered++;
                else if (record.Ids is null or { Imdb: null, Tvdb: null })
                {
                    none++;
                    answered.Add(key);
                }
                else if (await names.RefreshAsync(key, record, fetch: false, budget.Token) is NamesRefresh.Saved or NamesRefresh.Unchanged)
                {
                    filled++;
                    answered.Add(key);
                }
                else unanswered++;
            }
            catch (Exception error) when (!ct.IsCancellationRequested)
            {
                unanswered++;
                logger.LogInformation("Could not read the TVmaze record of {WorkKey}: {Error}", key, error.Message);
            }
            await Task.Delay(Pause, time, ct);
        }
        logger.LogInformation("TVmaze ids backfill: {Filled} works got their IMDb or TheTVDB id, {None} have neither at TVmaze, {Unanswered} are asked again later",
            filled, none, unanswered);
        return unanswered;
    }
}
