using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Titles;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// A whole season (or a film when <see cref="Season"/> is null) someone asked for. <see cref="Single"/> is one explicit
/// click on a film or one episode: it restarts only its own target, starts even when every season slot is busy, and is
/// not a season run, so it gets no season summary. A clicked episode runs apart from its season: the season's other
/// queued episodes keep their own retry time and their place behind the slot cap.
/// </summary>
public sealed record WantedOrder(string WorkKey, string WorkId, int? Season, IReadOnlyList<int> Episodes,
    int? PreferredResolution = null, bool OverrideStorageCap = false, string? Lane = null, bool Single = false);

/// <summary>What still needs the owner after several tries, with the prefilled "Pick a release yourself" link.</summary>
public sealed record WantedHelp(string WorkKey, string Title, int? Season, IReadOnlyList<int> Episodes, GrabFailure Failure,
    string Query, string Link);

/// <summary>
/// One season download's counts (<see cref="SeasonFailureSummary.Counts"/>). <see cref="Link"/> is unique to the run, so
/// the one notification a run gets is found again and updated by later finds instead of a new one being added.
/// </summary>
public sealed record WantedRunSummary(string RunId, string WorkKey, int Season, int Started, int NotFound, SeasonFailureSummary Summary,
    string Link);

/// <summary>Where the wanted queue reports to the rest of the app: requests and notifications live in the API host.</summary>
public interface IWantedObserver
{
    /// <summary>The download lane for a retry after a restart, when the original order is gone.</summary>
    Task<string?> LaneAsync(string workKey, int? season, CancellationToken ct);
    Task StartedAsync(string workKey, int? season, IReadOnlyCollection<string> hashes, CancellationToken ct);
    Task NeedsOwnerAsync(WantedHelp help, CancellationToken ct);
    /// <summary>A run's counts: after a pass of the queue (<paramref name="create"/>), or a later find that only updates what was said.</summary>
    Task RunSummaryAsync(WantedRunSummary run, bool create, CancellationToken ct);
    /// <summary>The owner stopped looking for a film, a season or one episode (<paramref name="episode"/>); nothing may bring it back.</summary>
    Task StoppedAsync(string workKey, int? season, int? episode, CancellationToken ct) => Task.CompletedTask;
}

/// <summary>
/// Fire and forget downloads. Download (a film or one episode), Download season and a request only record what is
/// wanted and return; this queue then runs the shared grab (<see cref="GrabService.Grab"/> for a film,
/// <see cref="GrabService.Season"/>: the single-episode grab, once per episode).
/// Whatever is not found yet stays wanted and is retried with a growing wait, forever, including after the search
/// sites were busy. Seasons are separate units, so one slow or failing season never holds up another. After a few
/// tries that did not find anything the owner is told once, with one action: pick a release yourself.
/// A wanted row is an <see cref="AcquisitionTarget"/> with status "queued" and no transfer yet.
/// </summary>
public sealed class WantedQueue(IDbContextFactory<TorrentFlowDbContext> factory, GrabService grabs, IEnumerable<IWantedObserver> observers,
    TimeProvider time, ILogger<WantedQueue> logger, IOptions<AutomationOptions> options, IAirDateLookup airDates, ITorrentEngine engine,
    WorkNamesRefresh? names = null, IWorkLinker? linker = null) : BackgroundService
{
    /// <summary>
    /// A run waits on searches and on the engine admitting each find (a magnet is admitted before its file list
    /// arrives). The cap is generous so a show clicked season after season runs side by side instead of waiting
    /// behind the slowest one.
    /// </summary>
    public const int MaxParallel = 6;
    public const int TriesBeforeAskingOwner = 3;
    /// <summary>A wanted row nobody is working on (a crash, an episode click that never settled) is picked up after this.</summary>
    private static readonly TimeSpan OrphanAge = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan[] Waits = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(15),
        TimeSpan.FromHours(1), TimeSpan.FromHours(3), TimeSpan.FromHours(6)];
    /// <summary>Failures that clear up by themselves; the owner is never asked about these.</summary>
    private static readonly HashSet<string> Passing = ["sources_unavailable", "search_busy", "download_failed", "metadata_unavailable",
        "audio_language"];
    /// <summary>The search itself did not happen (a site refused or was unreachable): not a miss, so no try is spent.</summary>
    private static readonly HashSet<string> Unsearched = ["sources_unavailable", "search_busy"];
    private static readonly TimeSpan MaxUnsearchedWait = TimeSpan.FromMinutes(15);

    /// <summary>What one run covers: a film, a season's queued episodes, or (<see cref="Episode"/>) one episode clicked on its own.</summary>
    private readonly record struct Unit(string WorkKey, int? Season, int? Episode = null);
    private sealed record Plan(long Order, int Tries, DateTime DueAt, bool Asked, int? Resolution, bool OverrideStorageCap, string? Lane, int Unsearched = 0,
        string? RunId = null, bool Single = false);

    private readonly ConcurrentDictionary<Unit, Plan> plans = new();
    private readonly ConcurrentDictionary<Unit, Task> running = new();
    /// <summary>A running unit's own cancel and its start, so Remove can stop it and undo what it started meanwhile.</summary>
    private readonly ConcurrentDictionary<Unit, (CancellationTokenSource Stop, DateTime Started)> inFlight = new();
    /// <summary>When each unit's last run started and ended: a Remove pressed as a run just finished still undoes it.</summary>
    private readonly ConcurrentDictionary<Unit, (DateTime Started, DateTime Ended)> lastRun = new();
    private static readonly TimeSpan RemoveWindow = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<string, string> why = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim wake = new(0);
    private long order;
    /// <summary>Set when a transfer failed: the release it was meant to fill is wanted again, so the next scan takes it at once.</summary>
    private int released;

    public static string TargetKey(string workKey, string scope, int? season, int? episode) =>
        $"{workKey}:{scope}:{season?.ToString() ?? "-"}:{episode?.ToString() ?? "-"}";

    /// <summary>Records the order and returns at once; the search runs in the background.</summary>
    public async Task<int> EnqueueAsync(WantedOrder wanted, CancellationToken ct)
    {
        var scope = wanted.Season == null ? "title" : "episode";
        IEnumerable<int?> episodes = wanted.Season == null ? [null] : wanted.Episodes.Where(e => e > 0).Distinct().Order().Cast<int?>();
        var tracked = await SeedAsync(wanted.WorkKey, wanted.WorkId, scope, wanted.Season, episodes, wanted.PreferredResolution, restart: wanted.Single, ct);
        // Each season download is one run: every episode it asked for, already started or not, counts toward its one summary.
        string? runId = null;
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            var keys = tracked.Keys.ToArray();
            if (wanted.Season != null && tracked.Count > 0 && !wanted.Single)
            {
                runId = Ids.New();
                // A season order takes back its episodes clicked on their own, also after a restart.
                await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && keys.Contains(t.TargetKey))
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.RunId, runId).SetProperty(t => t.ClickedAt, (DateTime?)null), ct);
            }
            else if (wanted.Single && tracked.Count == 1)
            {
                // The click is remembered so a restart brings it back as its own unit with click priority.
                var clickedAt = time.GetUtcNow().UtcDateTime;
                await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && keys.Contains(t.TargetKey) && t.InfoHash == null)
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.ClickedAt, clickedAt), ct);
            }
        }
        // A clicked episode is a unit of its own, so the click never restarts or reschedules the rest of its season.
        var unit = new Unit(wanted.WorkKey, wanted.Season,
            wanted.Single && wanted.Season != null && tracked.Values.ToArray() is [{ } clicked] ? clicked : null);
        // A season order takes back its episodes clicked on their own (one still running finishes first; its season's run skips it).
        if (unit.Episode == null && wanted.Season != null)
            foreach (var episode in tracked.Values.OfType<int>()) plans.TryRemove(unit with { Episode = episode }, out _);
        plans[unit] = new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, wanted.PreferredResolution, wanted.OverrideStorageCap, wanted.Lane,
            RunId: runId, Single: wanted.Single);
        wake.Release();
        return tracked.Count;
    }

    /// <summary>
    /// Creates or reopens the targets an order owns. A season never downgrades an episode already downloading or
    /// downloaded and reopens only failures; a single explicit click (<paramref name="restart"/>) restarts its own target.
    /// </summary>
    public async Task<Dictionary<string, int?>> SeedAsync(string workKey, string workId, string scope, int? season, IEnumerable<int?> episodes,
        int? resolution, bool restart, CancellationToken ct)
    {
        var tracked = new Dictionary<string, int?>(StringComparer.Ordinal);
        await using var db = await factory.CreateDbContextAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var ep in episodes)
        {
            var key = TargetKey(workKey, scope, season, ep);
            tracked[key] = ep;
            var target = await db.AcquisitionTargets.FirstOrDefaultAsync(x => x.UserId == LocalUser.Id && x.TargetKey == key, ct);
            if (target == null)
            {
                target = new() { Id = Ids.New(), UserId = LocalUser.Id, TargetKey = key, WorkKey = workKey, WorkId = workId,
                    Scope = scope, Season = season, Episode = ep, Status = "queued", PreferredResolution = resolution, CreatedAt = now, UpdatedAt = now };
                db.AcquisitionTargets.Add(target);
                try
                {
                    await db.SaveChangesAsync(ct);
                    continue;
                }
                catch (DbUpdateException error) when (error.InnerException is SqliteException { SqliteExtendedErrorCode: 2067 or 1555 })
                {
                    db.Entry(target).State = EntityState.Detached;
                    target = await db.AcquisitionTargets.SingleAsync(x => x.UserId == LocalUser.Id && x.TargetKey == key, ct);
                }
            }
            target.WorkId = workId; target.PreferredResolution = resolution; target.UpdatedAt = now;
            if (!restart && target.Status != "failed") continue;
            if (target.FileIndex != null && target.InfoHash is { } packHash)
            {
                // A restart never clears a healthy season pack claim: only a claim whose pack is gone or failed is reopened.
                var pack = await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(e => e.UserId == LocalUser.Id && e.Hash == packHash, ct);
                if (pack != null && pack.Status.ToLowerInvariant() is not ("removed" or "error" or "missingfiles")) continue;
                await db.SaveChangesAsync(ct);
                await db.AcquisitionTargets.Where(t => t.Id == target.Id && t.InfoHash == packHash && t.FileIndex != null).ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.Status, "queued").SetProperty(t => t.Progress, 0).SetProperty(t => t.InfoHash, (string?)null)
                    .SetProperty(t => t.FileIndex, (int?)null).SetProperty(t => t.FilePath, (string?)null).SetProperty(t => t.Error, (string?)null)
                    .SetProperty(t => t.UpdatedAt, now), ct);
                db.Entry(target).State = EntityState.Detached;
                continue;
            }
            target.Status = "queued"; target.Progress = 0; target.InfoHash = null; target.FilePath = null; target.Error = null;
        }
        await db.SaveChangesAsync(ct);
        return tracked;
    }

    /// <summary>
    /// Settles what one attempt did. A failure settles only a row still "queued"; a success settles "queued" or
    /// "failed", so a later attempt that already succeeded is never overwritten. A queue run settles only rows still
    /// without a release (<paramref name="unclaimedOnly"/>, compare-and-set on what it read): a release the owner picked
    /// meanwhile wins, and the run's late result is dropped. Returns the target keys it settled.
    /// </summary>
    public async Task<HashSet<string>> SettleAsync(IReadOnlyDictionary<string, int?> tracked, string workId, IReadOnlyList<EpisodeTransfer> transfers,
        CancellationToken ct, bool unclaimedOnly = false)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        var settled = new HashSet<string>(StringComparer.Ordinal);
        foreach (var transfer in transfers)
            foreach (var key in tracked.Where(x => (x.Value ?? 0) == transfer.Episode).Select(x => x.Key))
            {
                string[] open = transfer.Status == "failed" ? ["queued"] : ["queued", "failed"];
                var miss = transfer.RealMiss ? 1 : 0;
                // InfoHash == null keeps a season pack claim made meanwhile from being overwritten by a late miss.
                var changed = await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.TargetKey == key && open.Contains(x.Status) &&
                        (transfer.InfoHash != null || x.InfoHash == null || x.FileIndex == null) && (!unclaimedOnly || x.InfoHash == null)).ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.WorkId, workId).SetProperty(t => t.Status, transfer.Status).SetProperty(t => t.Progress, 0)
                    .SetProperty(t => t.InfoHash, transfer.InfoHash).SetProperty(t => t.FilePath, (string?)null)
                    .SetProperty(t => t.RealMisses, t => t.RealMisses + miss)
                    .SetProperty(t => t.ClickedAt, t => transfer.InfoHash == null ? t.ClickedAt : null)
                    .SetProperty(t => t.Error, transfer.Error).SetProperty(t => t.UpdatedAt, now), ct);
                if (changed > 0) settled.Add(key);
            }
        return settled;
    }

    /// <summary>
    /// A release the owner picked always wins: it claims its targets whatever a running search settled first, and a
    /// release the app started for them that hasn't finished and nothing else wants is removed with its files.
    /// </summary>
    public async Task ClaimPickedAsync(IReadOnlyDictionary<string, int?> tracked, string workId, IReadOnlyList<EpisodeTransfer> transfers, CancellationToken ct)
    {
        var picked = transfers.Select(t => t.InfoHash).OfType<string>().Select(h => h.ToLowerInvariant()).ToHashSet();
        var keys = tracked.Keys.ToList();
        List<string> previous;
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            previous = (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && keys.Contains(t.TargetKey) && t.InfoHash != null)
                .Select(t => t.InfoHash!).ToListAsync(ct)).Select(h => h.ToLowerInvariant()).Where(h => !picked.Contains(h)).Distinct().ToList();
            var now = time.GetUtcNow().UtcDateTime;
            foreach (var transfer in transfers)
                foreach (var key in tracked.Where(x => (x.Value ?? 0) == transfer.Episode).Select(x => x.Key))
                    await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.TargetKey == key).ExecuteUpdateAsync(s => s
                        .SetProperty(t => t.WorkId, workId).SetProperty(t => t.Status, transfer.Status).SetProperty(t => t.Progress, 0)
                        .SetProperty(t => t.InfoHash, transfer.InfoHash).SetProperty(t => t.FilePath, (string?)null)
                        .SetProperty(t => t.ClickedAt, (DateTime?)null).SetProperty(t => t.Error, transfer.Error).SetProperty(t => t.UpdatedAt, now), ct);
            if (previous.Count == 0) return;
            var still = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && previous.Contains(t.InfoHash.ToLower()))
                .Select(t => t.InfoHash!.ToLower()).Distinct().ToListAsync(ct);
            previous = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && previous.Contains(t.Hash) && !still.Contains(t.Hash) && t.Progress < 1)
                .Select(t => t.Hash).ToListAsync(ct);
        }
        foreach (var hash in previous)
        {
            var result = await engine.RemoveAsync(hash, true, ct);
            logger.LogInformation("Removed {Hash}: the owner picked another release for it: {Message}", hash, result.Message);
        }
    }

    /// <summary>Tells requests (and anything else watching) that transfers started for a work, from the queue or a hand pick.</summary>
    public async Task ReportStartedAsync(string workKey, int? season, IReadOnlyCollection<string> hashes, CancellationToken ct)
    {
        foreach (var observer in observers)
        {
            try { await observer.StartedAsync(workKey, season, hashes, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Wanted start report failed"); }
        }
        // A find after a run's first pass (a retry, a pack, a hand pick) updates that run's counts.
        string[] runs;
        await using (var db = await factory.CreateDbContextAsync(ct))
            runs = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == workKey && t.RunId != null &&
                t.InfoHash != null && hashes.Contains(t.InfoHash)).Select(t => t.RunId!).Distinct().ToArrayAsync(ct);
        await ReportRunsAsync(runs, create: false, ct);
    }

    /// <summary>
    /// A season download's counts, never its reasons (those stay on the title page): <paramref name="create"/> after a
    /// pass of the queue, which gives the run its one notification; otherwise only an update of a notification it has.
    /// </summary>
    private async Task ReportRunsAsync(IReadOnlyCollection<string> runIds, bool create, CancellationToken ct)
    {
        foreach (var runId in runIds)
        {
            WantedRunSummary run;
            await using (var db = await factory.CreateDbContextAsync(ct))
            {
                var rows = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.RunId == runId)
                    .Select(t => new { t.WorkKey, t.Season, t.Status, t.InfoHash }).ToListAsync(ct);
                if (rows.Count == 0 || rows[0].Season is not { } season) continue;
                var workKey = rows[0].WorkKey;
                var title = await db.Works.AsNoTracking().Where(w => w.WorkKey == workKey).Select(w => w.CanonicalTitle).FirstOrDefaultAsync(ct);
                var started = rows.Count(r => r.InfoHash != null || r.Status == "downloaded");
                run = new(runId, workKey, season, started, rows.Count - started,
                    SeasonFailureSummary.Counts(title ?? workKey, season, started, rows.Count - started), RunLink(workKey, season, runId));
            }
            foreach (var observer in observers)
            {
                try { await observer.RunSummaryAsync(run, create, ct); }
                catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Wanted run summary failed"); }
            }
        }
    }

    /// <summary>The title page at the run's season; the run id makes the link, and so the notification, the run's own.</summary>
    public static string RunLink(string workKey, int season, string runId) =>
        $"/title/{Uri.EscapeDataString(workKey)}?s={season}&run={Uri.EscapeDataString(runId)}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var startup = true;
        // A dead or refused release hands its wanted items back (queued); look for another release right away.
        void Failed(object? sender, EngineTorrentFailedEventArgs e)
        {
            Interlocked.Exchange(ref released, 1);
            wake.Release();
        }
        engine.TorrentFailed += Failed;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ScanAsync(startup || Interlocked.Exchange(ref released, 0) == 1, stoppingToken);
                    startup = false;
                    StartDue(stoppingToken);
                }
                catch (Exception error) when (!stoppingToken.IsCancellationRequested)
                {
                    logger.LogWarning(error, "Wanted queue scan failed");
                }
                try { await wake.WaitAsync(TimeSpan.FromSeconds(30), stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }
        finally { engine.TorrentFailed -= Failed; }
        await Task.WhenAll(running.Values).WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ContinueWith(_ => { }, CancellationToken.None);
    }

    /// <summary>Picks up wanted rows no plan covers: all of them after a restart or a failed transfer, then only rows left alone for a while.</summary>
    private async Task ScanAsync(bool all, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var cutoff = time.GetUtcNow().UtcDateTime - OrphanAge;
        await ReleaseFailedPacksAsync(db, ct);
        var rows = await db.AcquisitionTargets.AsNoTracking()
            .Where(t => t.UserId == LocalUser.Id && t.Status == "queued" && t.InfoHash == null && (t.Scope == "episode" || t.Scope == "title"))
            .Select(t => new { t.WorkKey, t.Season, t.Episode, t.Scope, t.UpdatedAt, t.ClickedAt }).ToListAsync(ct);
        // A clicked film or episode comes back as its own unit with its click priority, never absorbed into its season's run.
        foreach (var row in rows.Where(r => r.ClickedAt != null).OrderBy(r => r.ClickedAt))
        {
            var unit = new Unit(row.WorkKey, row.Scope == "title" ? null : row.Season, row.Scope == "title" ? null : row.Episode);
            if (plans.ContainsKey(unit) || !all && row.UpdatedAt > cutoff) continue;
            plans.TryAdd(unit, new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null, Single: true));
        }
        foreach (var row in rows.Where(r => r.ClickedAt == null && (r.Scope == "title" || r.Episode is not { } episode || !OnItsOwn(new(r.WorkKey, r.Season, episode))))
            .GroupBy(r => new Unit(r.WorkKey, r.Scope == "title" ? null : r.Season)))
        {
            if (plans.ContainsKey(row.Key) || !all && row.Max(r => r.UpdatedAt) > cutoff) continue;
            plans.TryAdd(row.Key, new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null));
        }
    }

    /// <summary>Whole-pack failure: a pack that errored, lost its files or was removed hands every unfinished claim back.</summary>
    private async Task ReleaseFailedPacksAsync(TorrentFlowDbContext db, CancellationToken ct)
    {
        var claims = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.FileIndex != null && t.InfoHash != null &&
            t.Status != "downloaded").Select(t => t.InfoHash!).Distinct().ToListAsync(ct);
        foreach (var hash in claims)
        {
            var pack = await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(e => e.UserId == LocalUser.Id && e.Hash == hash, ct);
            if (pack != null && pack.Status.ToLowerInvariant() is not ("removed" or "error" or "missingfiles")) continue;
            var released = await grabs.ReleasePackClaimsAsync(hash, ct);
            logger.LogInformation("Season pack {Hash} is {Status}; {Count} episodes back to the wanted queue", hash, pack?.Status ?? "gone", released);
        }
    }

    private void StartDue(CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var (unit, plan) in plans.Where(p => p.Value.DueAt <= now && !running.ContainsKey(p.Key)).OrderBy(p => p.Value.Order).ToArray())
        {
            // An episode clicked on its own waits for its season's run in flight, which may be grabbing it already.
            if (unit.Episode != null && running.ContainsKey(unit with { Episode = null })) continue;
            // Season runs share the slots; one clicked film or episode never waits behind them.
            if (running.Count >= MaxParallel && !plan.Single) continue;
            var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
            inFlight[unit] = (stop, now);
            running[unit] = Task.Run(async () =>
            {
                try { await RunAsync(unit, stop.Token); }
                catch (OperationCanceledException) when (stop.IsCancellationRequested && !ct.IsCancellationRequested)
                {
                    logger.LogInformation("Wanted {WorkKey} season {Season} was removed while it was looking", unit.WorkKey, unit.Season);
                }
                catch (Exception error) when (!ct.IsCancellationRequested && !stop.IsCancellationRequested && error is not ShuttingDownException)
                {
                    logger.LogWarning(error, "Wanted {WorkKey} season {Season} attempt failed", unit.WorkKey, unit.Season);
                    Reschedule(unit, null, [GrabFailure.FromException(error)], null, null);
                }
                finally
                {
                    inFlight.TryRemove(unit, out _);
                    lastRun[unit] = (now, time.GetUtcNow().UtcDateTime);
                    stop.Dispose();
                    running.TryRemove(unit, out _);
                    wake.Release();
                }
            }, CancellationToken.None);
        }
    }

    private async Task RunAsync(Unit unit, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var scope = unit.Season == null ? "title" : "episode";
        // A clicked episode's run takes only that episode; a season's run leaves alone the episodes clicked on their own.
        var rows = (await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == unit.WorkKey &&
                t.Scope == scope && t.Season == unit.Season && t.Status == "queued" && t.InfoHash == null).ToListAsync(ct))
            .Where(t => unit.Episode is { } clicked ? t.Episode == clicked : t.Episode is not { } episode || !OnItsOwn(unit with { Episode = episode }))
            .ToList();
        if ((names != null || linker != null) && rows.Count > 0)
        {
            // Before this grab searches, a work whose names never came from its provider gets them (at most once a day)
            // and a work never linked to its other records (AniList, TMDB) is linked, both within one 2 s budget: their
            // names join the search. Slow or failed lookups never hold up or fail the grab; title open and the backfill finish them.
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                if (names != null) await names.RefreshAsync(unit.WorkKey, null, fetch: true, budget.Token);
                if (linker != null) await linker.LinkAsync(unit.WorkKey, budget.Token);
            }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogInformation("Names and links of {WorkKey} before its grab stopped: {Error}", unit.WorkKey, error.Message); }
        }
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == unit.WorkKey, ct);
        plans.TryGetValue(unit, out var plan);
        var started = plan?.Order;
        var runs = rows.Select(r => r.RunId).Append(plan?.RunId).OfType<string>().Distinct().ToArray();
        if (rows.Count == 0 || work == null)
        {
            Reschedule(unit, started, [], null, null);
            if (work != null) await ReportRunsAsync(runs, create: unit.Episode == null, ct);
            return;
        }
        string? lane = plan?.Lane;
        foreach (var observer in observers) lane ??= await observer.LaneAsync(unit.WorkKey, unit.Season, ct);
        IReadOnlyList<string> aliases = work.ReadNames().Others(work.CanonicalTitle);
        // A library show's item moves its next-up cursor when that episode starts, as a click always did.
        var watchId = await db.WatchListItems.AsNoTracking().Where(x => x.UserId == LocalUser.Id && x.WorkId == work.Id)
            .Select(x => x.Id).FirstOrDefaultAsync(ct);
        var input = new GrabInput(work.CanonicalTitle, work.MediaType, WatchListItemId: watchId, WorkId: work.Id,
            PreferredResolution: plan?.Resolution ?? rows.Select(r => r.PreferredResolution).FirstOrDefault(r => r != null),
            OverrideStorageCap: plan?.OverrideStorageCap ?? false, Aliases: aliases, Year: work.Year, WorkKey: work.WorkKey, Lane: lane,
            Provider: work.Provider, ProviderId: work.ProviderId, ReuseExisting: true, Urgent: plan?.Single ?? false);
        var tracked = rows.ToDictionary(r => r.TargetKey, r => r.Episode);
        var workId = work.Id;
        var runStarted = inFlight.TryGetValue(unit, out var flight) ? flight.Started : time.GetUtcNow().UtcDateTime;
        // Each episode's row and reason update the moment that episode settles, so a found episode starts and shows at
        // once instead of waiting for the slowest episode in its season.
        async Task Settle(IReadOnlyList<EpisodeTransfer> settled)
        {
            // Not found yet stays wanted ("queued", no transfer); the reason is kept for the owner.
            var done = await SettleAsync(tracked, workId, settled.Select(t => t.Status == "failed" ? t with { Status = "queued" } : t).ToArray(), ct,
                unclaimedOnly: true);
            var late = settled.SelectMany(t => tracked.Where(x => (x.Value ?? 0) == t.Episode).Select(x => x.Key)).Where(k => !done.Contains(k)).ToArray();
            if (late.Length > 0)
                logger.LogInformation("Wanted {WorkKey}: dropped this search's late result for {Targets}; they already have a release", unit.WorkKey, string.Join(", ", late));
            foreach (var row in rows.Where(r => done.Contains(r.TargetKey)))
            {
                var transfer = settled.FirstOrDefault(t => t.Episode == (row.Episode ?? 0));
                if (transfer == null) continue;
                if (transfer.InfoHash == null && transfer.Failure?.Detail is { } detail) why[row.TargetKey] = detail;
                else why.TryRemove(row.TargetKey, out _);
            }
            var started = settled.Select(t => t.InfoHash).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var stale = await DropStaleAsync(unit, runStarted, started, ct);
            started = started.Except(stale, StringComparer.OrdinalIgnoreCase).ToArray();
            if (started.Length > 0) await ReportStartedAsync(unit.WorkKey, unit.Season, started, ct);
        }
        IReadOnlyList<EpisodeTransfer> transfers;
        if (unit.Season is { } season)
            transfers = (await grabs.Season(input, season, rows.Select(r => r.Episode ?? 0), ct, async transfer =>
            {
                try { await Settle([transfer]); }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    logger.LogWarning(error, "Wanted {WorkKey} season {Season} episode {Episode} update failed", unit.WorkKey, unit.Season, transfer.Episode);
                }
            })).Transfers;
        else
        {
            var film = await grabs.Grab(input, ct);
            transfers = [new(0, film.Ok ? film.Queued ? "queued" : "downloading" : "failed", film.Ok ? film.InfoHash : null,
                film.Ok ? null : film.Message, film.Ok ? null : film.Failure ?? GrabFailure.Unknown)];
            await Settle(transfers);
        }
        if (unit.Season is { } packSeason && transfers.Any(t => t.InfoHash == null))
        {
            var filled = await SeasonPackAsync(unit, packSeason, work, input, tracked.Keys.ToArray(), ct);
            if (filled.Count > 0) transfers = transfers.Select(t => filled.TryGetValue(t.Episode, out var hash) ? t with { Status = "downloading", InfoHash = hash, Error = null, Failure = null } : t).ToArray();
        }
        var hashes = transfers.Select(t => t.InfoHash).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        logger.LogInformation("Wanted {WorkKey} season {Season}: {Started} of {Total} started, {Transfers} transfers", unit.WorkKey, unit.Season,
            transfers.Count(t => t.InfoHash != null), transfers.Count, hashes.Length);
        var missing = transfers.Where(t => t.InfoHash == null).ToArray();
        Reschedule(unit, started, missing.Select(t => t.Failure ?? GrabFailure.Unknown).ToArray(), work,
            missing.Select(t => t.Episode).Where(e => e > 0).ToArray());
        // A clicked episode's try is a later find for its season's run, never the pass that gives the run its notification.
        await ReportRunsAsync(runs, create: unit.Episode == null, ct);
    }

    /// <summary>
    /// A run's result that lost to a release the owner picked meanwhile: what it started since it began and no target
    /// wants is removed with its files, so a stale search never leaves a second download behind. Returns those hashes.
    /// </summary>
    private async Task<IReadOnlyList<string>> DropStaleAsync(Unit unit, DateTime runStarted, IReadOnlyCollection<string> started, CancellationToken ct)
    {
        if (started.Count == 0) return [];
        var hashes = started.Select(h => h.ToLowerInvariant()).ToList();
        List<string> stale;
        await using (var db = await factory.CreateDbContextAsync(ct))
        {
            var wanted = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && hashes.Contains(t.InfoHash.ToLower()))
                .Select(t => t.InfoHash!.ToLower()).Distinct().ToListAsync(ct);
            var unwanted = hashes.Except(wanted).ToList();
            stale = unwanted.Count == 0 ? [] : await db.EngineTorrents.AsNoTracking()
                .Where(t => t.UserId == LocalUser.Id && unwanted.Contains(t.Hash) && t.CreatedAt >= runStarted).Select(t => t.Hash).ToListAsync(ct);
        }
        foreach (var hash in stale)
        {
            var result = await engine.RemoveAsync(hash, true, ct);
            logger.LogInformation("Removed {Hash} that {WorkKey}'s search started after a release was picked for it: {Message}", hash, unit.WorkKey, result.Message);
        }
        return stale;
    }

    /// <summary>
    /// Season pack fallback v1 (docs/season-pack-fallback.md): after the single-episode pass, from a fresh read,
    /// episodes that really missed often enough may be filled from one inspected season pack, but only for a season
    /// the provider proves has finished airing, and only among the run's own targets (<paramref name="owned"/>). Returns
    /// episode to pack hash for what the pack claimed.
    /// </summary>
    private async Task<Dictionary<int, string>> SeasonPackAsync(Unit unit, int season, Work work, GrabInput input, string[] owned, CancellationToken ct)
    {
        var settings = options.Value;
        var none = new Dictionary<int, string>();
        if (!settings.SeasonPackFallback || work.MediaType is not ("tv" or "anime")) return none;
        await using var db = await factory.CreateDbContextAsync(ct);
        var due = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == unit.WorkKey && t.Scope == "episode" &&
            t.Season == season && owned.Contains(t.TargetKey) && t.Status == "queued" && t.InfoHash == null && t.Episode != null && t.RealMisses >= settings.SeasonPackMisses).ToListAsync(ct);
        if (due.Count == 0) return none;
        // The provider id must be the kind the air date lookup reads for this media type; anything else cannot prove the season ended.
        var providerFits = work.ProviderId is { Length: > 0 } && (work.MediaType == "anime" ? work.Provider == "anilist" : work.Provider == "tmdb");
        bool? finished = null;
        if (providerFits)
        {
            try { finished = await airDates.SeasonFinishedAsync(work.CanonicalTitle, work.MediaType, work.ProviderId!, season, time.GetUtcNow().UtcDateTime, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Season finished check for {WorkKey} season {Season} failed", unit.WorkKey, season); }
        }
        if (finished != true)
        {
            logger.LogInformation("Season pack skipped for {WorkKey} season {Season}: season finished = {Finished}", unit.WorkKey, season, finished?.ToString() ?? "unknown");
            foreach (var row in due) why[row.TargetKey] = "Season still airing, or we could not confirm it has finished. Waiting for single episodes.";
            return none;
        }
        var targets = due.ToDictionary(t => t.Episode!.Value, t => t.TargetKey);
        var outcome = await grabs.SeasonPack(input, season, targets, settings.SeasonPackProbes, ct);
        logger.LogInformation("Season pack for {WorkKey} season {Season} ({Due} due): {Detail}", unit.WorkKey, season, due.Count, outcome.Detail);
        if (outcome.InfoHash is not { } hash || outcome.Claimed.Count == 0) return none;
        foreach (var episode in outcome.Claimed.Keys) why.TryRemove(targets[episode], out _);
        await ReportStartedAsync(unit.WorkKey, unit.Season, [hash], ct);
        return outcome.Claimed.Keys.ToDictionary(e => e, _ => hash);
    }

    /// <param name="started">The order this attempt ran for; a newer order placed meanwhile is left due as it is.</param>
    private void Reschedule(Unit unit, long? started, IReadOnlyList<GrabFailure> failures, Work? work, IReadOnlyList<int>? episodes)
    {
        var current = plans.GetValueOrDefault(unit);
        if (current != null && started != null && current.Order != started) return;
        if (failures.Count == 0)
        {
            if (current != null) plans.TryRemove(new KeyValuePair<Unit, Plan>(unit, current));
            return;
        }
        var plan = current ?? new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null);
        if (failures.All(f => Unsearched.Contains(f.Code)))
        {
            // Retry soon (1, 2, 4, 8, then every 15 minutes) without spending a try or asking the owner.
            var rounds = plan.Unsearched + 1;
            var wait = TimeSpan.FromMinutes(Math.Min(MaxUnsearchedWait.TotalMinutes, 1 << Math.Min(rounds - 1, 4)));
            plans[unit] = plan with { Unsearched = rounds, DueAt = time.GetUtcNow().UtcDateTime + wait * options.Value.WantedRetryScale };
            return;
        }
        var tries = plan.Tries + 1;
        var failure = failures.GroupBy(f => f.Code).OrderByDescending(g => g.Count()).First().First();
        var ask = work != null && !plan.Asked && tries >= TriesBeforeAskingOwner && failures.Any(f => !Passing.Contains(f.Code));
        plans[unit] = plan with { Tries = tries, Unsearched = 0, DueAt = time.GetUtcNow().UtcDateTime + Waits[Math.Min(tries, Waits.Length) - 1] * options.Value.WantedRetryScale, Asked = plan.Asked || ask };
        if (!ask) return;
        var single = episodes is { Count: 1 } ? episodes[0] : (int?)null;
        var query = ReleasePicker.DefaultQuery(work!.CanonicalTitle, unit.Season, single);
        var help = new WantedHelp(unit.WorkKey, work.CanonicalTitle, unit.Season, episodes ?? [], failure, query,
            PickLink(unit.WorkKey, work.CanonicalTitle, unit.Season, single, query));
        _ = Task.Run(async () =>
        {
            foreach (var observer in observers)
            {
                try { await observer.NeedsOwnerAsync(help, CancellationToken.None); }
                catch (Exception error) { logger.LogWarning(error, "Wanted owner report failed"); }
            }
        }, CancellationToken.None);
    }

    /// <summary>The title page with the release picker open and prefilled; the web shell reads the pick* parameters.</summary>
    public static string PickLink(string workKey, string title, int? season, int? episode, string query)
    {
        var parts = new List<string> { "pick=1", $"pickTitle={Uri.EscapeDataString(title)}", $"pickQuery={Uri.EscapeDataString(query)}" };
        if (season != null) parts.Add($"pickSeason={season}");
        if (episode != null) parts.Add($"pickEpisode={episode}");
        return $"/title/{Uri.EscapeDataString(workKey)}?{string.Join('&', parts)}";
    }

    /// <summary>
    /// Stop looking: drops a film's, a season's or one episode's wanted rows that have no release yet, so neither a
    /// retry nor a restart brings them back. Remove always wins over a search in flight: that run is cancelled and
    /// awaited, and any release it started meanwhile is removed with its files. Releases started before are left alone.
    /// Returns how many wanted rows were dropped.
    /// </summary>
    public async Task<int> StopAsync(string workKey, int? season, int? episode, CancellationToken ct)
    {
        bool Matches(Unit u) => u.WorkKey == workKey && u.Season == season && (episode == null || u.Episode == episode);
        void Forget() { foreach (var unit in plans.Keys.Where(Matches)) plans.TryRemove(unit, out _); }
        Forget();
        var stopped = inFlight.Where(p => Matches(p.Key)).Select(p => (p.Key, p.Value.Started)).ToList();
        var cutoff = time.GetUtcNow().UtcDateTime - RemoveWindow;
        var justEnded = lastRun.Where(p => Matches(p.Key) && p.Value.Ended >= cutoff).Select(p => (p.Key, p.Value.Started)).ToList();
        foreach (var (unit, _) in stopped)
        {
            if (inFlight.TryGetValue(unit, out var run)) { try { run.Stop.Cancel(); } catch (ObjectDisposedException) { } }
            if (running.TryGetValue(unit, out var task))
                await task.WaitAsync(TimeSpan.FromSeconds(30), ct).ContinueWith(_ => { }, CancellationToken.None);
        }
        Forget();
        stopped.AddRange(justEnded);

        await using var db = await factory.CreateDbContextAsync(ct);
        var scoped = db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.WorkKey == workKey);
        scoped = season == null ? scoped.Where(t => t.Scope == "title") : scoped.Where(t => t.Scope == "episode" && t.Season == season);
        if (season != null && episode != null) scoped = scoped.Where(t => t.Episode == episode);

        // What the cancelled run started before it noticed: this work's transfers created since that run began.
        var raced = new List<string>();
        if (stopped.Count > 0)
        {
            var since = stopped.Min(s => s.Started);
            var workId = await db.Works.Where(w => w.WorkKey == workKey).Select(w => w.Id).FirstOrDefaultAsync(ct);
            // Only transfers created since: a release the run reused from before stays, files and all.
            raced = workId == null ? [] : await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.WorkId == workId && t.CreatedAt >= since)
                .Select(t => t.Hash.ToLower()).ToListAsync(ct);
            // Another target (another season, or the owner's own pick) that still wants one of them keeps it.
            var mine = await scoped.Select(t => t.Id).ToListAsync(ct);
            var keep = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && raced.Contains(t.InfoHash.ToLower())
                    && !mine.Contains(t.Id)).Select(t => t.InfoHash!.ToLower()).ToListAsync(ct);
            raced = raced.Except(keep, StringComparer.OrdinalIgnoreCase).ToList();
        }

        var rows = scoped.Where(t => t.Status == "queued" && t.InfoHash == null || t.InfoHash != null && raced.Contains(t.InfoHash.ToLower()));
        var keys = await rows.Select(t => t.TargetKey).ToListAsync(ct);
        var removed = await rows.ExecuteDeleteAsync(ct);
        foreach (var key in keys) why.TryRemove(key, out _);
        foreach (var hash in raced)
        {
            var result = await engine.RemoveAsync(hash, true, ct);
            logger.LogInformation("Removed {Hash} that {WorkKey}'s search started as it was removed: {Message}", hash, workKey, result.Message);
        }
        foreach (var observer in observers)
        {
            try { await observer.StoppedAsync(workKey, season, episode, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested) { logger.LogWarning(error, "Wanted stop report failed"); }
        }
        return removed;
    }

    /// <summary>Try now: the film's, season's or episode's next try is due at once instead of after its wait.</summary>
    public void TryNow(string workKey, int? season, int? episode)
    {
        var units = plans.Keys.Where(u => u.WorkKey == workKey && u.Season == season && (episode == null || u.Episode == episode)).ToList();
        if (units.Count == 0)
        {
            // Nothing planned yet (a restart before the first scan): a film or one episode tries at once like a click.
            var single = season == null || episode != null;
            units.Add(new(workKey, season, season == null ? null : episode));
            plans.TryAdd(units[0], new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null, Single: single));
        }
        foreach (var unit in units)
            plans.AddOrUpdate(unit, _ => new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null),
                (_, plan) => plan with { DueAt = DateTime.MinValue });
        wake.Release();
    }

    /// <summary>What the last search for a wanted target really returned; null before its first try or after a restart.</summary>
    public string? Why(string targetKey) => why.GetValueOrDefault(targetKey);

    /// <summary>An episode clicked on its own belongs to its own unit until that settles: its season's runs and the scan skip it.</summary>
    private bool OnItsOwn(Unit clicked) => plans.ContainsKey(clicked) || running.ContainsKey(clicked);

    /// <summary>True while a search for this target runs: its own click, its season's run, or its film's.</summary>
    public bool Looking(string workKey, int? season, int? episode) =>
        running.ContainsKey(new(workKey, season, episode)) || episode != null && running.ContainsKey(new(workKey, season));

    /// <summary>When this target's unit tries next, or null when it is due now or not planned.</summary>
    public DateTime? NextAttempt(string workKey, int? season, int? episode) =>
        new[] { new Unit(workKey, season, episode), new Unit(workKey, season) }
            .Select(u => plans.GetValueOrDefault(u)?.DueAt).FirstOrDefault(d => d != null && d != DateTime.MinValue);

    /// <summary>Wanted units and when each tries next, for diagnostics and tests.</summary>
    public IReadOnlyList<object> Snapshot() => plans.OrderBy(p => p.Value.Order).Select(p => (object)new
    {
        workKey = p.Key.WorkKey, season = p.Key.Season, episode = p.Key.Episode, tries = p.Value.Tries, running = running.ContainsKey(p.Key),
        nextAttemptAt = p.Value.DueAt == DateTime.MinValue ? (DateTime?)null : p.Value.DueAt, askedOwner = p.Value.Asked,
    }).ToArray();
}
