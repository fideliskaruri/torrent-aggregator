using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>A whole season (or a film when <see cref="Season"/> is null) someone asked for.</summary>
public sealed record WantedOrder(string WorkKey, string WorkId, int? Season, IReadOnlyList<int> Episodes,
    int? PreferredResolution = null, bool OverrideStorageCap = false, string? Lane = null);

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
}

/// <summary>
/// Fire and forget downloads. Download season (and a request) only records what is wanted and returns; this queue
/// then runs the shared season path (<see cref="GrabService.Season"/>: the single-episode grab, once per episode).
/// Whatever is not found yet stays wanted and is retried with a growing wait, forever, including after the search
/// sites were busy. Seasons are separate units, so one slow or failing season never holds up another. After a few
/// tries that did not find anything the owner is told once, with one action: pick a release yourself.
/// A wanted row is an <see cref="AcquisitionTarget"/> with status "queued" and no transfer yet.
/// </summary>
public sealed class WantedQueue(IDbContextFactory<TorrentFlowDbContext> factory, GrabService grabs, IEnumerable<IWantedObserver> observers,
    TimeProvider time, ILogger<WantedQueue> logger, IOptions<AutomationOptions> options, IAirDateLookup airDates) : BackgroundService
{
    /// <summary>
    /// A run mostly waits on swarms for torrent metadata (up to the engine's metadata timeout per candidate), so a
    /// season with dead releases can take an hour. The cap is generous so a show clicked season after season runs
    /// side by side instead of waiting behind the slowest one.
    /// </summary>
    public const int MaxParallel = 6;
    public const int TriesBeforeAskingOwner = 3;
    /// <summary>A wanted row nobody is working on (a crash, an episode click that never settled) is picked up after this.</summary>
    private static readonly TimeSpan OrphanAge = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan[] Waits = [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(15),
        TimeSpan.FromHours(1), TimeSpan.FromHours(3), TimeSpan.FromHours(6)];
    /// <summary>Failures that clear up by themselves; the owner is never asked about these.</summary>
    private static readonly HashSet<string> Passing = ["sources_unavailable", "search_busy", "download_failed", "metadata_unavailable"];
    /// <summary>The search itself did not happen (a site refused or was unreachable): not a miss, so no try is spent.</summary>
    private static readonly HashSet<string> Unsearched = ["sources_unavailable", "search_busy"];
    private static readonly TimeSpan MaxUnsearchedWait = TimeSpan.FromMinutes(15);

    private readonly record struct Unit(string WorkKey, int? Season);
    private sealed record Plan(long Order, int Tries, DateTime DueAt, bool Asked, int? Resolution, bool OverrideStorageCap, string? Lane, int Unsearched = 0,
        string? RunId = null);

    private readonly ConcurrentDictionary<Unit, Plan> plans = new();
    private readonly ConcurrentDictionary<Unit, Task> running = new();
    private readonly ConcurrentDictionary<string, string> why = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim wake = new(0);
    private long order;

    public static string TargetKey(string workKey, string scope, int? season, int? episode) =>
        $"{workKey}:{scope}:{season?.ToString() ?? "-"}:{episode?.ToString() ?? "-"}";

    /// <summary>Records the order and returns at once; the search runs in the background.</summary>
    public async Task<int> EnqueueAsync(WantedOrder wanted, CancellationToken ct)
    {
        var scope = wanted.Season == null ? "title" : "episode";
        IEnumerable<int?> episodes = wanted.Season == null ? [null] : wanted.Episodes.Where(e => e > 0).Distinct().Order().Cast<int?>();
        var tracked = await SeedAsync(wanted.WorkKey, wanted.WorkId, scope, wanted.Season, episodes, wanted.PreferredResolution, restart: false, ct);
        // Each season download is one run: every episode it asked for, already started or not, counts toward its one summary.
        string? runId = null;
        if (wanted.Season != null && tracked.Count > 0)
        {
            runId = Ids.New();
            var keys = tracked.Keys.ToArray();
            await using var db = await factory.CreateDbContextAsync(ct);
            await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && keys.Contains(t.TargetKey))
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.RunId, runId), ct);
        }
        var unit = new Unit(wanted.WorkKey, wanted.Season);
        plans[unit] = new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, wanted.PreferredResolution, wanted.OverrideStorageCap, wanted.Lane,
            RunId: runId);
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
    /// "failed", so a later attempt that already succeeded is never overwritten.
    /// </summary>
    public async Task SettleAsync(IReadOnlyDictionary<string, int?> tracked, string workId, IReadOnlyList<EpisodeTransfer> transfers, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var transfer in transfers)
            foreach (var key in tracked.Where(x => (x.Value ?? 0) == transfer.Episode).Select(x => x.Key))
            {
                string[] open = transfer.Status == "failed" ? ["queued"] : ["queued", "failed"];
                var miss = transfer.RealMiss ? 1 : 0;
                // InfoHash == null keeps a season pack claim made meanwhile from being overwritten by a late miss.
                await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.TargetKey == key && open.Contains(x.Status) &&
                        (transfer.InfoHash != null || x.InfoHash == null || x.FileIndex == null)).ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.WorkId, workId).SetProperty(t => t.Status, transfer.Status).SetProperty(t => t.Progress, 0)
                    .SetProperty(t => t.InfoHash, transfer.InfoHash).SetProperty(t => t.FilePath, (string?)null)
                    .SetProperty(t => t.RealMisses, t => t.RealMisses + miss)
                    .SetProperty(t => t.Error, transfer.Error).SetProperty(t => t.UpdatedAt, now), ct);
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
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ScanAsync(startup, stoppingToken);
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
        await Task.WhenAll(running.Values).WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ContinueWith(_ => { }, CancellationToken.None);
    }

    /// <summary>Picks up wanted rows no plan covers: all of them after a restart, then only rows left alone for a while.</summary>
    private async Task ScanAsync(bool startup, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var cutoff = time.GetUtcNow().UtcDateTime - OrphanAge;
        await ReleaseFailedPacksAsync(db, ct);
        var rows = await db.AcquisitionTargets.AsNoTracking()
            .Where(t => t.UserId == LocalUser.Id && t.Status == "queued" && t.InfoHash == null && (t.Scope == "episode" || t.Scope == "title"))
            .Select(t => new { t.WorkKey, t.Season, t.Scope, t.UpdatedAt }).ToListAsync(ct);
        foreach (var row in rows.GroupBy(r => new Unit(r.WorkKey, r.Scope == "title" ? null : r.Season)))
        {
            if (plans.ContainsKey(row.Key) || !startup && row.Max(r => r.UpdatedAt) > cutoff) continue;
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
        foreach (var (unit, _) in plans.Where(p => p.Value.DueAt <= now && !running.ContainsKey(p.Key)).OrderBy(p => p.Value.Order).ToArray())
        {
            if (running.Count >= MaxParallel) break;
            running[unit] = Task.Run(async () =>
            {
                try { await RunAsync(unit, ct); }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    logger.LogWarning(error, "Wanted {WorkKey} season {Season} attempt failed", unit.WorkKey, unit.Season);
                    Reschedule(unit, null, [GrabFailure.FromException(error)], null, null);
                }
                finally
                {
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
        var rows = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == unit.WorkKey &&
            t.Scope == scope && t.Season == unit.Season && t.Status == "queued" && t.InfoHash == null).ToListAsync(ct);
        var work = await db.Works.AsNoTracking().FirstOrDefaultAsync(w => w.WorkKey == unit.WorkKey, ct);
        plans.TryGetValue(unit, out var plan);
        var started = plan?.Order;
        var runs = rows.Select(r => r.RunId).Append(plan?.RunId).OfType<string>().Distinct().ToArray();
        if (rows.Count == 0 || work == null)
        {
            Reschedule(unit, started, [], null, null);
            if (work != null) await ReportRunsAsync(runs, create: true, ct);
            return;
        }
        string? lane = plan?.Lane;
        foreach (var observer in observers) lane ??= await observer.LaneAsync(unit.WorkKey, unit.Season, ct);
        IReadOnlyList<string> aliases = [];
        try { aliases = JsonSerializer.Deserialize<string[]>(work.AliasesJson ?? "[]") ?? []; }
        catch (JsonException) { }
        var input = new GrabInput(work.CanonicalTitle, work.MediaType, WorkId: work.Id,
            PreferredResolution: plan?.Resolution ?? rows.Select(r => r.PreferredResolution).FirstOrDefault(r => r != null),
            OverrideStorageCap: plan?.OverrideStorageCap ?? false, Aliases: aliases, Year: work.Year, WorkKey: work.WorkKey, Lane: lane,
            Provider: work.Provider, ProviderId: work.ProviderId, ReuseExisting: true);
        var tracked = rows.ToDictionary(r => r.TargetKey, r => r.Episode);
        var workId = work.Id;
        // Each episode's row and reason update the moment that episode settles, so a found episode starts and shows at
        // once instead of waiting for the slowest episode in its season.
        async Task Settle(IReadOnlyList<EpisodeTransfer> settled)
        {
            foreach (var row in rows)
            {
                var transfer = settled.FirstOrDefault(t => t.Episode == (row.Episode ?? 0));
                if (transfer == null) continue;
                if (transfer.InfoHash == null && transfer.Failure?.Detail is { } detail) why[row.TargetKey] = detail;
                else why.TryRemove(row.TargetKey, out _);
            }
            // Not found yet stays wanted ("queued", no transfer); the reason is kept for the owner.
            await SettleAsync(tracked, workId, settled.Select(t => t.Status == "failed" ? t with { Status = "queued" } : t).ToArray(), ct);
            var started = settled.Select(t => t.InfoHash).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
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
            var filled = await SeasonPackAsync(unit, packSeason, work, input, ct);
            if (filled.Count > 0) transfers = transfers.Select(t => filled.TryGetValue(t.Episode, out var hash) ? t with { Status = "downloading", InfoHash = hash, Error = null, Failure = null } : t).ToArray();
        }
        var hashes = transfers.Select(t => t.InfoHash).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        logger.LogInformation("Wanted {WorkKey} season {Season}: {Started} of {Total} started, {Transfers} transfers", unit.WorkKey, unit.Season,
            transfers.Count(t => t.InfoHash != null), transfers.Count, hashes.Length);
        var missing = transfers.Where(t => t.InfoHash == null).ToArray();
        Reschedule(unit, started, missing.Select(t => t.Failure ?? GrabFailure.Unknown).ToArray(), work,
            missing.Select(t => t.Episode).Where(e => e > 0).ToArray());
        await ReportRunsAsync(runs, create: true, ct);
    }

    /// <summary>
    /// Season pack fallback v1 (docs/season-pack-fallback.md): after the single-episode pass, from a fresh read,
    /// episodes that really missed often enough may be filled from one inspected season pack, but only for a season
    /// the provider proves has finished airing. Returns episode to pack hash for what the pack claimed.
    /// </summary>
    private async Task<Dictionary<int, string>> SeasonPackAsync(Unit unit, int season, Work work, GrabInput input, CancellationToken ct)
    {
        var settings = options.Value;
        var none = new Dictionary<int, string>();
        if (!settings.SeasonPackFallback || work.MediaType is not ("tv" or "anime")) return none;
        await using var db = await factory.CreateDbContextAsync(ct);
        var due = await db.AcquisitionTargets.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.WorkKey == unit.WorkKey && t.Scope == "episode" &&
            t.Season == season && t.Status == "queued" && t.InfoHash == null && t.Episode != null && t.RealMisses >= settings.SeasonPackMisses).ToListAsync(ct);
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

    /// <summary>What the last search for a wanted target really returned; null before its first try or after a restart.</summary>
    public string? Why(string targetKey) => why.GetValueOrDefault(targetKey);

    /// <summary>Wanted units and when each tries next, for diagnostics and tests.</summary>
    public IReadOnlyList<object> Snapshot() => plans.OrderBy(p => p.Value.Order).Select(p => (object)new
    {
        workKey = p.Key.WorkKey, season = p.Key.Season, tries = p.Value.Tries, running = running.ContainsKey(p.Key),
        nextAttemptAt = p.Value.DueAt == DateTime.MinValue ? (DateTime?)null : p.Value.DueAt, askedOwner = p.Value.Asked,
    }).ToArray();
}
