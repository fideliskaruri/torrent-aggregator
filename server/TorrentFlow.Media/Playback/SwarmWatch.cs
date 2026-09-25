using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Swarm;

namespace TorrentFlow.Media.Playback;

public sealed record SwarmTickResult(string CurrentHash, bool Switched, bool Exhausted, StallVerdict Verdict, Dictionary<string, object?> Narration);

public sealed record ManualSwitchResult(bool Ok, string? Reason, string? InfoHash, double? PositionSec, Dictionary<string, object?>? Narration);

public sealed record ForegroundPlaybackState(string ContentKey, string CurrentHash, string? PinnedHash, Dictionary<string, object?> Narration, bool Exhausted);

/// <summary>
/// A condensed port of src/lib/playback/swarm-delivery-watchdog.ts + engine-deps.ts: one watch entry per content key
/// holding the failover session and byte samples; ticks are serialised per entry. Pools come from the SearchCache
/// (rankedResultsFromCache), sources start as stream transfers and abandoned sources are paused, never deleted.
/// </summary>
public sealed class SwarmWatch(
    ITorrentEngine engine,
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    SwarmMeasurements measurements,
    TimeProvider clock,
    ILogger<SwarmWatch> logger)
{
    public const int WatchdogPollMs = 5_000;
    private const int MaxSwitchAttempts = 3;
    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _registry = new(StringComparer.Ordinal);
    private string? _activeContentKey;

    private sealed class Entry(string key, PlaybackTarget target)
    {
        public FailoverSession Session { get; set; } = FailoverSession.Create(key);
        public PlaybackTarget Target { get; set; } = target;
        public List<TransferSample> Samples { get; } = [];
        public Dictionary<string, object?>? LastNarration { get; set; }
        public SemaphoreSlim Queue { get; } = new(1, 1);
    }

    public static Dictionary<string, object?> WaitOutcome(string reason, int? peerCount = null, int? activeRequestCount = null) => new()
    {
        ["kind"] = "wait", ["reason"] = reason, ["peerCount"] = peerCount, ["activeRequestCount"] = activeRequestCount, ["nextPollMs"] = WatchdogPollMs,
    };

    public static Dictionary<string, object?> StartingNarration(int attempt, string reason = "connecting", int? peers = null) => new()
    {
        ["phase"] = "starting", ["attempt"] = attempt, ["outcome"] = WaitOutcome(reason, peers),
    };

    private Entry Ensure(string contentKey, string currentHash, PlaybackTarget target)
    {
        lock (_gate)
        {
            if (!_registry.TryGetValue(contentKey, out var entry))
            {
                entry = new Entry(contentKey, target);
                entry.Session = entry.Session.Commit(currentHash);
                _registry[contentKey] = entry;
            }
            _activeContentKey = contentKey;
            return entry;
        }
    }

    public bool UpdateTarget(string contentKey, PlaybackTarget target)
    {
        lock (_gate)
        {
            if (!_registry.TryGetValue(contentKey, out var entry)) return false;
            entry.Target = target;
            return true;
        }
    }

    public void EnsureTarget(string contentKey, string infoHash, PlaybackTarget target) => Ensure(contentKey, infoHash, target);

    public ForegroundPlaybackState? CurrentForegroundState()
    {
        lock (_gate)
        {
            if (_activeContentKey is null || !_registry.TryGetValue(_activeContentKey, out var e) || e.Session.Current is null) return null;
            return new ForegroundPlaybackState(_activeContentKey, e.Session.Current, e.Session.PinnedHash,
                e.LastNarration ?? StartingNarration(Math.Max(1, e.Session.Tried.Count)), e.Session.Status == "exhausted");
        }
    }

    public async Task<List<TorrentResult>> RankedResultsAsync(PlaybackTarget target, CancellationToken ct = default)
    {
        var normalized = MediaFiles.NormalizeTitle(target.Title);
        if (normalized.Length == 0) return [];
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.SearchCaches.AsNoTracking().Where(r => r.NormalizedQuery == normalized).OrderByDescending(r => r.ExpiresAt).FirstOrDefaultAsync(ct);
            return row is null ? [] : Releases.RankForTarget(Releases.ResultsFromPayload(row.Payload), target);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return []; }
    }

    public async Task<TorrentResult?> ResolveReleaseByInfoHashAsync(string chosen, CancellationToken ct = default)
    {
        var hash = chosen.ToLowerInvariant();
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var rows = await db.SearchCaches.AsNoTracking().OrderByDescending(r => r.ExpiresAt).Take(40).Select(r => r.Payload).ToListAsync(ct);
            foreach (var payload in rows)
                if (Releases.ResultsFromPayload(payload).FirstOrDefault(r => Releases.ReleaseInfoHash(r) == hash) is { } match) return match;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { }
        return null;
    }

    private async Task<TransferSample?> SampleAsync(string hash, CancellationToken ct)
    {
        var info = await engine.GetAsync(hash, ct);
        if (info is null) return null;
        return new TransferSample(clock.GetUtcNow().ToUnixTimeMilliseconds(), info.BytesReceived ?? (long)(info.Progress * info.SizeBytes), info.Progress, info.State, info.Peers);
    }

    private async Task<bool> StartReleaseAsync(FailoverCandidate candidate, CancellationToken ct)
    {
        var result = await engine.AddAsync(new EngineAddRequest
        {
            Magnet = candidate.Release.Magnet, TorrentUrl = candidate.Release.Magnet is null ? candidate.Release.TorrentUrl : null,
            InfoHash = candidate.Release.Magnet is null && candidate.Release.TorrentUrl is null ? candidate.InfoHash : null,
            Name = candidate.Release.Title, Purpose = TorrentPurpose.Stream, ExpectedSizeBytes = candidate.Release.SizeBytes,
        }, ct);
        return result.Ok;
    }

    private async Task AbandonAsync(string hash)
    {
        try { await engine.PauseAsync(hash); }
        catch (Exception ex) { logger.LogWarning("[failover] could not pause {Hash}: {Error}", hash, ex.Message); }
    }

    /// <summary>Copies the newest progress row of <paramref name="from"/> onto <paramref name="to"/>; returns the carried position.</summary>
    public async Task<double?> CarryPositionAsync(string from, string to, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await db.PlaybackProgresses.AsNoTracking().Where(p => p.UserId == LocalUser.Id && p.InfoHash == from).OrderByDescending(p => p.UpdatedAt).FirstOrDefaultAsync(ct);
        if (row is null) return null;
        var existing = await db.PlaybackProgresses.FirstOrDefaultAsync(p => p.UserId == LocalUser.Id && p.InfoHash == to && p.FilePath == row.FilePath, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        if (existing is null)
        {
            db.PlaybackProgresses.Add(new TorrentFlow.Data.Entities.PlaybackProgress
            {
                Id = Ids.New(), UserId = row.UserId, InfoHash = to, FilePath = row.FilePath, PositionSec = row.PositionSec, DurationSec = row.DurationSec,
                Title = row.Title, Season = row.Season, Episode = row.Episode, WatchListItemId = row.WatchListItemId, PosterUrl = row.PosterUrl,
                WorkId = row.WorkId, CreatedAt = now, UpdatedAt = now,
            });
        }
        else
        {
            existing.PositionSec = row.PositionSec;
            existing.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        return row.PositionSec;
    }

    public async Task<double?> LatestPositionAsync(string hash, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await db.PlaybackProgresses.AsNoTracking().Where(p => p.UserId == LocalUser.Id && p.InfoHash == hash).OrderByDescending(p => p.UpdatedAt).FirstOrDefaultAsync(ct);
        return row?.PositionSec;
    }

    /// <summary>Retries a delivery failure on the same source: resume it, or re-add it if the engine lost it.</summary>
    public async Task<bool> RetryTorrentAsync(string infoHash, CancellationToken ct = default)
    {
        var info = await engine.GetAsync(infoHash, ct);
        if (info is null) return (await engine.AddAsync(new EngineAddRequest { InfoHash = infoHash, Purpose = TorrentPurpose.Stream }, ct)).Ok;
        return (await engine.ResumeAsync(infoHash, ct)).Ok;
    }

    public async Task<SwarmTickResult> TickAsync(string contentKey, string infoHash, PlaybackTarget target, string cause, bool force,
        Func<PlaybackTarget, Task<List<TorrentResult>>>? rankedResults = null, CancellationToken ct = default)
    {
        var entry = Ensure(contentKey, infoHash, target);
        entry.Target = target;
        await entry.Queue.WaitAsync(ct);
        try
        {
            var current = entry.Session.Current ?? infoHash.ToLowerInvariant();
            if (await SampleAsync(current, ct) is { } sample)
            {
                entry.Samples.Add(sample);
                entry.Samples.RemoveAll(s => s.AtMs < sample.AtMs - Stall.ColdStartGraceMsDefault - Stall.WindowMs);
            }
            var verdict = Stall.Evaluate(entry.Samples);
            if (!force && !verdict.Stalled)
            {
                entry.LastNarration = verdict.Reason is "progressing" or "complete"
                    ? new Dictionary<string, object?> { ["phase"] = "playing" }
                    : StartingNarration(Math.Max(1, entry.Session.Tried.Count), verdict.Reason == "cold-starting" ? "cold-starting" : "connecting", entry.Samples.LastOrDefault()?.PeerCount);
                return new SwarmTickResult(current, false, entry.Session.Status == "exhausted", verdict, entry.LastNarration ?? []);
            }
            if (!force && entry.Session.PinnedHash == current)
            {
                entry.LastNarration = new Dictionary<string, object?> { ["phase"] = "stalled-held", ["outcome"] = new Dictionary<string, object?> { ["kind"] = "keep-waiting" } };
                return new SwarmTickResult(current, false, false, verdict, entry.LastNarration ?? []);
            }
            var pool = rankedResults is null ? await RankedResultsAsync(entry.Target, ct) : await rankedResults(entry.Target);
            var verdicts = await measurements.LoadVerdictsAsync(pool.Select(Releases.ReleaseInfoHash), ct);
            for (var attempt = 0; attempt < MaxSwitchAttempts; attempt++)
            {
                var result = Releases.FailOver(entry.Session, pool, entry.Target, cause, verdicts);
                entry.LastNarration = result.Narration;
                if (result.Kind == "exhausted" || result.Candidate is null)
                {
                    entry.Session = result.Session;
                    return new SwarmTickResult(current, false, true, verdict, result.Narration);
                }
                entry.Session = result.Session;
                if (!await StartReleaseAsync(result.Candidate, ct)) continue;
                try { await CarryPositionAsync(current, result.Candidate.InfoHash, ct); }
                catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException) { }
                await AbandonAsync(current);
                entry.Samples.Clear();
                logger.LogInformation("[failover] {Key}: switched {From} -> {To} ({Cause})", contentKey, current, result.Candidate.InfoHash, cause);
                return new SwarmTickResult(result.Candidate.InfoHash, true, false, verdict, result.Narration);
            }
            return new SwarmTickResult(entry.Session.Current ?? current, false, false, verdict, entry.LastNarration ?? []);
        }
        finally { entry.Queue.Release(); }
    }

    public async Task<ManualSwitchResult> ManualSwitchAsync(string contentKey, string currentHash, string chosenInfoHash, PlaybackTarget target, CancellationToken ct = default)
    {
        var entry = Ensure(contentKey, currentHash, target);
        entry.Target = target;
        await entry.Queue.WaitAsync(ct);
        try
        {
            var chosen = chosenInfoHash.ToLowerInvariant();
            var current = entry.Session.Current ?? currentHash.ToLowerInvariant();
            var results = await RankedResultsAsync(target, ct);
            var match = results.FirstOrDefault(r => Releases.ReleaseInfoHash(r) == chosen) ?? await ResolveReleaseByInfoHashAsync(chosen, ct);
            if (match is null || Releases.ReleaseInfoHash(match) != chosen) return new(false, "not-a-candidate", null, null, null);
            if (!Releases.MeetsResolutionFloor(match.Title, target.PreferredResolution)) return new(false, "not-a-candidate", null, null, null);
            if (chosen == current)
            {
                entry.Session = entry.Session.Pin(chosen);
                entry.Samples.Clear();
                entry.LastNarration = new() { ["phase"] = "playing" };
                return new(true, null, chosen, null, entry.LastNarration);
            }
            if (!await StartReleaseAsync(new FailoverCandidate(match, chosen), ct)) return new(false, "start-failed", null, null, null);
            double? position = null;
            try { position = await CarryPositionAsync(current, chosen, ct); }
            catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException) { position = null; }
            await AbandonAsync(current);
            entry.Session = entry.Session.Pin(chosen);
            entry.Samples.Clear();
            entry.LastNarration = StartingNarration(1);
            return new(true, null, chosen, position, entry.LastNarration);
        }
        finally { entry.Queue.Release(); }
    }

    internal void ResetForTests()
    {
        lock (_gate)
        {
            _registry.Clear();
            _activeContentKey = null;
        }
    }
}
