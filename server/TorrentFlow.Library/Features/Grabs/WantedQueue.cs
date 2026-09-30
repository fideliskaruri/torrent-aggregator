using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>A whole season (or a film when <see cref="Season"/> is null) someone asked for.</summary>
public sealed record WantedOrder(string WorkKey, string WorkId, int? Season, IReadOnlyList<int> Episodes,
    int? PreferredResolution = null, bool OverrideStorageCap = false, string? Lane = null);

/// <summary>What still needs the owner after several tries, with the prefilled "Pick a release yourself" link.</summary>
public sealed record WantedHelp(string WorkKey, string Title, int? Season, IReadOnlyList<int> Episodes, GrabFailure Failure,
    string Query, string Link);

/// <summary>Where the wanted queue reports to the rest of the app: requests and notifications live in the API host.</summary>
public interface IWantedObserver
{
    /// <summary>The download lane for a retry after a restart, when the original order is gone.</summary>
    Task<string?> LaneAsync(string workKey, int? season, CancellationToken ct);
    Task StartedAsync(string workKey, int? season, IReadOnlyCollection<string> hashes, CancellationToken ct);
    Task NeedsOwnerAsync(WantedHelp help, CancellationToken ct);
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
    TimeProvider time, ILogger<WantedQueue> logger) : BackgroundService
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
    private sealed record Plan(long Order, int Tries, DateTime DueAt, bool Asked, int? Resolution, bool OverrideStorageCap, string? Lane, int Unsearched = 0);

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
        var unit = new Unit(wanted.WorkKey, wanted.Season);
        plans[unit] = new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, wanted.PreferredResolution, wanted.OverrideStorageCap, wanted.Lane);
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
                await db.AcquisitionTargets.Where(x => x.UserId == LocalUser.Id && x.TargetKey == key && open.Contains(x.Status)).ExecuteUpdateAsync(s => s
                    .SetProperty(t => t.WorkId, workId).SetProperty(t => t.Status, transfer.Status).SetProperty(t => t.Progress, 0)
                    .SetProperty(t => t.InfoHash, transfer.InfoHash).SetProperty(t => t.FilePath, (string?)null)
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
    }

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
        var rows = await db.AcquisitionTargets.AsNoTracking()
            .Where(t => t.UserId == LocalUser.Id && t.Status == "queued" && t.InfoHash == null && (t.Scope == "episode" || t.Scope == "title"))
            .Select(t => new { t.WorkKey, t.Season, t.Scope, t.UpdatedAt }).ToListAsync(ct);
        foreach (var row in rows.GroupBy(r => new Unit(r.WorkKey, r.Scope == "title" ? null : r.Season)))
        {
            if (plans.ContainsKey(row.Key) || !startup && row.Max(r => r.UpdatedAt) > cutoff) continue;
            plans.TryAdd(row.Key, new(Interlocked.Increment(ref order), 0, DateTime.MinValue, false, null, false, null));
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
        if (rows.Count == 0 || work == null)
        {
            Reschedule(unit, started, [], null, null);
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
        var hashes = transfers.Select(t => t.InfoHash).OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        logger.LogInformation("Wanted {WorkKey} season {Season}: {Started} of {Total} started, {Transfers} transfers", unit.WorkKey, unit.Season,
            transfers.Count(t => t.InfoHash != null), transfers.Count, hashes.Length);
        var missing = transfers.Where(t => t.InfoHash == null).ToArray();
        Reschedule(unit, started, missing.Select(t => t.Failure ?? GrabFailure.Unknown).ToArray(), work,
            missing.Select(t => t.Episode).Where(e => e > 0).ToArray());
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
            plans[unit] = plan with { Unsearched = rounds, DueAt = time.GetUtcNow().UtcDateTime + wait };
            return;
        }
        var tries = plan.Tries + 1;
        var failure = failures.GroupBy(f => f.Code).OrderByDescending(g => g.Count()).First().First();
        var ask = work != null && !plan.Asked && tries >= TriesBeforeAskingOwner && failures.Any(f => !Passing.Contains(f.Code));
        plans[unit] = plan with { Tries = tries, Unsearched = 0, DueAt = time.GetUtcNow().UtcDateTime + Waits[Math.Min(tries, Waits.Length) - 1], Asked = plan.Asked || ask };
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
