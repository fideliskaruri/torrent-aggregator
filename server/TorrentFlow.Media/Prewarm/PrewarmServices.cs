using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Media;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Swarm;

namespace TorrentFlow.Media.Prewarm;

/// <summary>Default <see cref="IUpcomingPlaybackTargets"/>: the next episode of each series in continue-watching.</summary>
public sealed class ContinueWatchingTargets(IDbContextFactory<TorrentFlowDbContext> dbFactory) : IUpcomingPlaybackTargets
{
    public async Task<IReadOnlyList<UpcomingPlaybackTarget>> ListAsync(int limit, IReadOnlyList<string> sources, CancellationToken cancellationToken = default)
    {
        if (limit <= 0 || !sources.Contains("watching")) return [];
        await using var db = await dbFactory.CreateDbContextAsync(cancellationToken);
        var rows = await db.PlaybackProgresses.AsNoTracking()
            .Where(p => p.UserId == LocalUser.Id && p.Season != null && p.Episode != null)
            .OrderByDescending(p => p.UpdatedAt).Take(200).ToListAsync(cancellationToken);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var targets = new List<UpcomingPlaybackTarget>();
        foreach (var row in rows)
        {
            var title = row.Title.Trim();
            if (title.Length == 0 || !seen.Add(MediaFiles.NormalizeTitle(title))) continue;
            targets.Add(new UpcomingPlaybackTarget(title, "tv", null, row.Season, row.Episode + 1));
            if (targets.Count >= limit) break;
        }
        return targets;
    }
}

/// <summary>Port of preprobe-lock.ts: one bounded speculative pass per user at a time.</summary>
public sealed class PreProbeLease
{
    private readonly ConcurrentDictionary<string, byte> _active = new(StringComparer.Ordinal);

    public IDisposable? TryAcquire(string userId) => _active.TryAdd(userId, 0) ? new Release(this, userId) : null;

    private sealed class Release(PreProbeLease owner, string userId) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0) owner._active.TryRemove(userId, out _);
        }
    }
}

public sealed record PreRankedCandidate(string Title, int Seeders,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] long? SizeBytes,
    string Source);

public sealed record PreRankedChoice(
    string Query,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] int? Season,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] int? Episode,
    int ResultCount,
    string Source,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] PreRankedCandidate? Candidate)
{
    [System.Text.Json.Serialization.JsonIgnore] public string? CandidateHash { get; init; }
}

public sealed record PreProbeResult(string? Skipped, string Scope, List<string> Probed, List<string> SkippedFresh, List<string> SkippedLive,
    bool Capped, Dictionary<string, string> Verdicts);

/// <summary>Port of prerank.ts + preprobe.ts: pick the release each upcoming target would play, then measure its swarm.</summary>
public sealed class PreRanker(
    IServiceProvider services,
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    IUpcomingPlaybackTargets upcoming,
    ISwarmProbeEngine probeEngine,
    SwarmMeasurements measurements,
    ForegroundTracker foreground,
    TimeProvider clock,
    ILogger<PreRanker> logger)
{
    public const int UpcomingLimit = 6;
    public const int MaxTargets = 2;
    public const int MaxCandidates = 3;
    public const int MaxProbes = 6;
    public const string DefaultScope = "monitored";
    private static readonly TimeSpan MemoTtl = TimeSpan.FromMinutes(30);
    private readonly ConcurrentDictionary<string, (PreRankedChoice Choice, DateTimeOffset At)> _memo = new(StringComparer.Ordinal);

    public static readonly object[] ScopeChoices =
    [
        new { value = "off", label = "Off" },
        new { value = "watching", label = "Only what I'm watching" },
        new { value = "monitored", label = "Everything I monitor" },
    ];

    public static string NormalizeScope(string? value) => value is "off" or "watching" or "monitored" ? value : DefaultScope;

    public static IReadOnlyList<string> SourcesForScope(string scope) => scope switch
    {
        "off" => [],
        "watching" => ["watching"],
        _ => ["monitored", "watchlist", "watching"],
    };

    public async Task<string> ResolveScopeAsync(CancellationToken ct = default)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var raw = await db.ClientSettings.AsNoTracking().Where(s => s.UserId == LocalUser.Id).Select(s => s.PreProbeScope).FirstOrDefaultAsync(ct);
            return NormalizeScope(raw);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return DefaultScope; }
    }

    public Task<IReadOnlyList<UpcomingPlaybackTarget>> UpcomingAsync(int limit = UpcomingLimit, IReadOnlyList<string>? sources = null, CancellationToken ct = default) =>
        upcoming.ListAsync(limit, sources ?? ["watching", "monitored", "watchlist"], ct);

    public static string QueryFor(UpcomingPlaybackTarget t) =>
        t.Season is { } s && t.Episode is { } e ? $"{t.Title} S{s:00}E{e:00}" : t.Year is { } y ? $"{t.Title} {y}" : t.Title;

    public PreRankedChoice? GetPreRanked(UpcomingPlaybackTarget target)
    {
        var key = Releases.PreRankKey(ToPlayback(target));
        return _memo.TryGetValue(key, out var hit) && clock.GetUtcNow() - hit.At < MemoTtl ? hit.Choice with { Source = "memo" } : null;
    }

    /// <summary>Rank one target: memo → search cache → a background search. Null = not determined.</summary>
    public async Task<PreRankedChoice?> PreRankAsync(UpcomingPlaybackTarget target, CancellationToken ct = default)
    {
        if (GetPreRanked(target) is { } memo) return memo;
        var playback = ToPlayback(target);
        var query = QueryFor(target);
        var source = "search-cache";
        var pool = await CachedPoolAsync(target.Title, ct);
        if (pool.Count == 0)
        {
            var search = services.GetService<ITorrentSearchService>();
            if (search is null) return null;
            try
            {
                var response = await search.SearchAsync(new SearchOptions
                {
                    Query = query,
                    Category = Releases.IsMovie(target.MediaType) ? "movies" : "tv",
                    Background = true,
                    PageSize = 50,
                }, ct);
                pool = [.. response.Results];
                source = "search";
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("[prerank] {Query} failed: {Message}", query, ex.Message);
                return null;
            }
        }
        var ranked = Releases.RankForTarget(pool, playback);
        var best = Releases.SelectBestRelease(ranked, playback);
        var choice = new PreRankedChoice(query, target.Season, target.Episode, pool.Count, source,
            best is null ? null : new PreRankedCandidate(best.Title, best.Seeders, best.SizeBytes, best.Source))
        { CandidateHash = best is null ? null : Releases.ReleaseInfoHash(best) };
        _memo[Releases.PreRankKey(playback)] = (choice, clock.GetUtcNow());
        return choice;
    }

    public async Task<List<PreRankedChoice>> PreRankUpcomingAsync(int? limit, CancellationToken ct = default)
    {
        var targets = await UpcomingAsync(Math.Clamp(limit ?? UpcomingLimit, 1, 20), null, ct);
        var ranked = new List<PreRankedChoice>();
        foreach (var target in targets)
        {
            if (foreground.Active()) break;
            if (await PreRankAsync(target, ct) is { } choice) ranked.Add(choice);
        }
        return ranked;
    }

    public async Task<PreProbeResult> PreProbeUpcomingAsync(CancellationToken ct = default)
    {
        var scope = await ResolveScopeAsync(ct);
        var result = new PreProbeResult(null, scope, [], [], [], false, []);
        if (scope == "off") return result with { Skipped = "disabled" };
        if (foreground.Active()) return result with { Skipped = "foreground" };
        var targets = await UpcomingAsync(MaxTargets, SourcesForScope(scope), ct);
        if (foreground.Active()) return result with { Skipped = "foreground" };
        if (targets.Count == 0) return result with { Skipped = "no-targets" };
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var target in targets)
        {
            if (foreground.Active()) return result with { Skipped = "foreground" };
            var pool = await CachedPoolAsync(target.Title, ct);
            if (foreground.Active()) return result with { Skipped = "foreground" };
            foreach (var candidate in TopCandidates(pool, MaxCandidates))
            {
                var hash = Releases.ReleaseInfoHash(candidate)!;
                if (!seen.Add(hash)) continue;
                SwarmLiveState live;
                try { live = await probeEngine.FindLiveAsync(hash, ct); }
                catch (Exception ex) when (ex is not OperationCanceledException) { live = new SwarmLiveState("unknown"); }
                if (live.State != "absent") { result.SkippedLive.Add(hash); continue; }
                var stored = await measurements.GetAsync(hash, ct);
                if (foreground.Active()) return result with { Skipped = "foreground" };
                if (stored is { Expired: false })
                {
                    result.SkippedFresh.Add(hash);
                    result.Verdicts[hash] = stored.Verdict;
                    continue;
                }
                if (result.Probed.Count >= MaxProbes) return result with { Capped = true };
                if (foreground.Active()) return result with { Skipped = "foreground" };
                var (token, registration) = foreground.CancellationSignal();
                SwarmReading? reading;
                try
                {
                    using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, ct);
                    reading = await measurements.ProbeAndRecordAsync(candidate.Magnet, hash, candidate.SizeBytes, candidate.Title, linked.Token);
                }
                finally { registration.Dispose(); }
                if (reading is null || foreground.Active()) return result with { Skipped = "foreground" };
                result.Probed.Add(hash);
                result.Verdicts[hash] = reading.Verdict;
            }
        }
        return result;
    }

    internal static IEnumerable<TorrentResult> TopCandidates(IEnumerable<TorrentResult> results, int limit) =>
        results.Where(r => !string.IsNullOrEmpty(r.Magnet) && r.Seeders > 0 && Releases.ReleaseInfoHash(r) is not null && r.Episode?.IsSeasonPack != true).Take(limit);

    private async Task<List<TorrentResult>> CachedPoolAsync(string title, CancellationToken ct)
    {
        var normalized = MediaFiles.NormalizeTitle(title);
        if (normalized.Length == 0) return [];
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.SearchCaches.AsNoTracking().Where(r => r.NormalizedQuery == normalized).OrderByDescending(r => r.ExpiresAt).FirstOrDefaultAsync(ct);
            return row is null ? [] : Releases.ResultsFromPayload(row.Payload);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException or System.Text.Json.JsonException) { return []; }
    }

    public static PlaybackTarget ToPlayback(UpcomingPlaybackTarget t) =>
        new(t.Title, t.MediaType ?? "tv", t.Year, t.Season, t.Episode, t.PreferredResolution);
}

public sealed record SuspensionResult(bool Foreground, List<string> Suspended, List<string> Resumed, IReadOnlyList<string> Parked, string? ForegroundHash);
public sealed record EvictedPrewarm(string Hash, string Name);
public sealed record SkippedPrewarm(string Hash, string Reason);
public sealed record EvictionResult(List<EvictedPrewarm> Evicted, long FreedBytes, long NeededBytes, bool Satisfied, List<SkippedPrewarm> Skipped);

/// <summary>Port of foreground.ts syncPrewarmSuspension and eviction.ts.</summary>
public sealed class PrewarmCoordinator(
    ITorrentEngine engine,
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ForegroundTracker foreground,
    TimeProvider clock,
    ILogger<PrewarmCoordinator> logger)
{
    public const string PrewarmOrigin = "prewarm";
    public const string StreamOrigin = "stream";
    public const string EvictingOrigin = "evicting";
    private const int MaxScan = 200;

    /// <summary>Pause prewarm transfers while playback is active (they resume when a stream next needs them).</summary>
    public async Task<SuspensionResult> SyncSuspensionAsync(CancellationToken ct = default)
    {
        List<string> prewarms;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            prewarms = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Origin == PrewarmOrigin).Select(t => t.Hash).ToListAsync(ct);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogWarning("[prewarm] could not read pre-warm origins; leaving torrents alone: {Message}", ex.Message);
            return new SuspensionResult(foreground.Active(), [], [], foreground.Parked, foreground.Hash);
        }
        var active = foreground.Active();
        var suspended = new List<string>();
        foreach (var hash in prewarms.Select(h => h.ToLowerInvariant()))
        {
            if (active && !foreground.IsSuspended(hash))
            {
                try
                {
                    var info = await engine.GetAsync(hash, ct);
                    if (info is null || info.Progress >= 1) continue;
                    await engine.PauseAsync(hash, ct);
                    foreground.MarkSuspended(hash);
                    suspended.Add(hash);
                }
                catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogDebug(ex, "prewarm suspend failed for {Hash}", hash); }
            }
            else if (!active && foreground.IsSuspended(hash)) foreground.ClearSuspended(hash);
        }
        return new SuspensionResult(active, suspended, [], foreground.Parked, foreground.Hash);
    }

    public async Task<(List<EngineTorrent> Candidates, List<SkippedPrewarm> Skipped)> ListEvictableAsync(IEnumerable<string>? protectHashes = null, CancellationToken ct = default)
    {
        var protectedSet = new HashSet<string>((protectHashes ?? []).Select(h => h.ToLowerInvariant()), StringComparer.Ordinal);
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Origin == PrewarmOrigin)
            .OrderBy(t => t.LastUsedAt).Take(MaxScan).ToListAsync(ct);
        var hashes = rows.Select(r => r.Hash).ToList();
        var watched = rows.Count == 0 ? [] : (await db.PlaybackProgresses.AsNoTracking()
            .Where(p => p.UserId == LocalUser.Id && hashes.Contains(p.InfoHash)).Select(p => p.InfoHash).ToListAsync(ct))
            .Select(h => h.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
        var usable = new List<EngineTorrent>();
        var skipped = new List<SkippedPrewarm>();
        foreach (var row in rows)
        {
            var hash = row.Hash.ToLowerInvariant();
            if (row.Origin != PrewarmOrigin) skipped.Add(new(hash, "not-prewarm"));
            else if (protectedSet.Contains(hash)) skipped.Add(new(hash, "protected"));
            else if (watched.Contains(hash)) skipped.Add(new(hash, "watched"));
            else usable.Add(row);
        }
        return (usable, skipped);
    }

    public async Task<EvictionResult> EvictForBytesAsync(long neededBytes, IEnumerable<string>? protectHashes = null, CancellationToken ct = default)
    {
        neededBytes = Math.Max(0, neededBytes);
        var result = new EvictionResult([], 0, neededBytes, neededBytes == 0, []);
        if (neededBytes == 0) return result;
        List<EngineTorrent> candidates;
        try
        {
            var listed = await ListEvictableAsync(protectHashes, ct);
            candidates = listed.Candidates;
            result.Skipped.AddRange(listed.Skipped);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogWarning("[prewarm] could not list evictable pre-warms: {Message}", ex.Message);
            return result;
        }
        long freed = 0;
        foreach (var candidate in candidates)
        {
            if (freed >= neededBytes) break;
            var hash = candidate.Hash.ToLowerInvariant();
            var bytes = (long)Math.Floor(Math.Max(0, candidate.SizeBytes) * Math.Clamp(candidate.Progress, 0, 1));
            if (bytes <= 0) { result.Skipped.Add(new(hash, "frees-nothing")); continue; }
            var lease = Guid.NewGuid().ToString("N");
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var claimed = await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.Hash == candidate.Hash && t.Origin == PrewarmOrigin && t.EvictLease == null)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, EvictingOrigin).SetProperty(t => t.EvictLease, lease).SetProperty(t => t.EvictFrom, PrewarmOrigin), ct);
            if (claimed == 0) { result.Skipped.Add(new(hash, "db-guard-refused")); continue; }
            var owned = await db.EngineTorrents.AnyAsync(t => t.UserId == LocalUser.Id && t.Hash == candidate.Hash && t.Origin == EvictingOrigin && t.EvictLease == lease, ct);
            if (!owned) { result.Skipped.Add(new(hash, "lease-stolen")); continue; }
            var deleted = false;
            try
            {
                var removed = await engine.RemoveAsync(hash, deleteFiles: true, ct);
                deleted = removed.Ok;
                if (!removed.Ok) result.Skipped.Add(new(hash, $"client-refused: {removed.Message}"));
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { result.Skipped.Add(new(hash, $"client-error: {ex.Message}")); }
            if (!deleted)
            {
                await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.Hash == candidate.Hash && t.Origin == EvictingOrigin && t.EvictLease == lease)
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, PrewarmOrigin).SetProperty(t => t.EvictLease, (string?)null).SetProperty(t => t.EvictFrom, (string?)null), ct);
                continue;
            }
            await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.Hash == candidate.Hash && t.Origin == EvictingOrigin && t.EvictLease == lease).ExecuteDeleteAsync(ct);
            result.Evicted.Add(new(hash, candidate.Name));
            freed += bytes;
        }
        return result with { FreedBytes = freed, Satisfied = freed >= neededBytes };
    }

    public async Task<bool> MarkUsedAsync(string infoHash, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        if (hash.Length == 0) return false;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var now = clock.GetUtcNow().UtcDateTime;
            return await db.EngineTorrents.Where(t => t.UserId == LocalUser.Id && t.Hash == hash).ExecuteUpdateAsync(s => s.SetProperty(t => t.LastUsedAt, now), ct) > 0;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return false; }
    }
}
