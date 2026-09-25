using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// LRU eviction of speculative downloads (src/lib/prewarm/eviction.ts).
///
/// Only EngineTorrent rows with origin "prewarm" may ever be deleted here. Deleting something the user asked for
/// is data loss dressed up as cache management, so the guard is applied three times on purpose — in the query, in
/// the loop immediately before the destructive call, and in the lease that owns the row — because each one alone
/// is a single edit away from being wrong. A pre-warm the user started watching (a PlaybackProgress row) is no
/// longer speculative, and callers may protect the torrent on screen explicitly.
/// </summary>
public sealed class PrewarmEviction
{
    /// <summary>How many rows one eviction pass will consider.</summary>
    public const int MaxScan = 200;
    /// <summary>A lease older than this was abandoned by a crash and is restored to its recorded origin.</summary>
    public static readonly TimeSpan EvictLeaseStale = TimeSpan.FromMinutes(10);

    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly ITorrentEngine _engine;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;

    public PrewarmEviction(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentEngine engine, TimeProvider? time = null,
        ILogger<PrewarmEviction>? logger = null)
    {
        _factory = factory;
        _engine = engine;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    /// <summary>Test seams mirroring the TypeScript options.</summary>
    public sealed record Seams
    {
        public Func<string, Task<EngineActionResult>>? Delete { get; init; }
        /// <summary>Fires after the pre-claim guards, before the claim CAS (the promote race window).</summary>
        public Func<EvictionCandidate, Task>? BeforeClaim { get; init; }
        /// <summary>Fires after the claim, before the re-check + unlink (the lease-steal window).</summary>
        public Func<EvictionCandidate, Task>? AfterClaim { get; init; }
    }

    /// <summary>Bytes this row is actually holding on disk: a half-finished torrent has half its bytes.</summary>
    public static long OnDiskBytes(long sizeBytes, double progress)
    {
        if (sizeBytes <= 0) return 0;
        var p = double.IsFinite(progress) ? Math.Clamp(progress, 0, 1) : 0;
        return (long)Math.Round(sizeBytes * p, MidpointRounding.AwayFromZero);
    }

    public static string NewEvictLease(DateTimeOffset now) => $"{now.ToUnixTimeMilliseconds()}:{Guid.NewGuid()}";

    public static long? LeaseClaimedAtMs(string? token) =>
        token is not null && long.TryParse(token.Split(':')[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var ms) ? ms : null;

    /// <summary>Prewarm rows that are legitimately evictable, least-recently-used first.</summary>
    public async Task<(List<EvictionCandidate> Candidates, List<EvictionSkip> Skipped)> ListEvictableAsync(
        string userId, IEnumerable<string>? protectHashes = null, int? limit = null, CancellationToken ct = default)
    {
        var protectedHashes = new HashSet<string>((protectHashes ?? []).Select(h => h.ToLowerInvariant()), StringComparer.Ordinal);
        await using var db = await _factory.CreateDbContextAsync(ct);
        // Guard 1 of 3: the query itself never sees a user-origin row.
        var rows = await db.EngineTorrents.AsNoTracking()
            .Where(t => t.UserId == userId && t.Origin == PrewarmOrigins.Prewarm)
            .OrderBy(t => t.LastUsedAt)
            .Take(Math.Max(1, limit ?? MaxScan))
            .ToListAsync(ct);

        var watched = new HashSet<string>(StringComparer.Ordinal);
        if (rows.Count > 0)
        {
            var hashes = rows.Select(r => r.Hash).ToList();
            var progress = await db.PlaybackProgresses.AsNoTracking()
                .Where(p => p.UserId == userId && hashes.Contains(p.InfoHash))
                .Select(p => p.InfoHash).ToListAsync(ct);
            foreach (var h in progress) watched.Add(h.ToLowerInvariant());
        }

        List<EvictionSkip> skipped = [];
        List<EvictionCandidate> usable = [];
        foreach (var row in rows)
        {
            var candidate = new EvictionCandidate(row.Id, row.Hash, row.Name, row.Origin, row.SizeBytes, row.Progress, row.Status, row.LastUsedAt);
            var hash = row.Hash.ToLowerInvariant();
            if (candidate.Origin != PrewarmOrigins.Prewarm) { skipped.Add(new(hash, "not-prewarm")); continue; }
            if (protectedHashes.Contains(hash)) { skipped.Add(new(hash, "protected")); continue; }
            if (watched.Contains(hash)) { skipped.Add(new(hash, "watched")); continue; }
            usable.Add(candidate);
        }
        return (usable, skipped);
    }

    /// <summary>Restores eviction leases abandoned by a crash to the origin they were claimed from.</summary>
    public async Task<List<(string Hash, string RestoredTo)>> RecoverStaleLeasesAsync(string userId, DateTimeOffset? now = null, CancellationToken ct = default)
    {
        List<(string, string)> recovered = [];
        var nowMs = (now ?? _time.GetUtcNow()).ToUnixTimeMilliseconds();
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var rows = await db.EngineTorrents.AsNoTracking()
                .Where(t => t.UserId == userId && t.Origin == PrewarmOrigins.Evicting)
                .Select(t => new { t.Hash, t.EvictLease, t.EvictFrom }).ToListAsync(ct);
            foreach (var row in rows)
            {
                if (LeaseClaimedAtMs(row.EvictLease) is not { } claimedAt) continue;
                if (nowMs - claimedAt < (long)EvictLeaseStale.TotalMilliseconds) continue;
                var restoreTo = row.EvictFrom == PrewarmOrigins.Prewarm ? PrewarmOrigins.Prewarm : PrewarmOrigins.Stream;
                var count = await db.EngineTorrents
                    .Where(t => t.UserId == userId && t.Hash == row.Hash && t.Origin == PrewarmOrigins.Evicting && t.EvictLease == row.EvictLease)
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, restoreTo).SetProperty(t => t.EvictLease, (string?)null).SetProperty(t => t.EvictFrom, (string?)null), ct);
                if (count > 0) recovered.Add((row.Hash, restoreTo));
            }
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] could not recover stale eviction leases");
        }
        return recovered;
    }

    /// <summary>
    /// Free up to <paramref name="neededBytes"/> by evicting unwatched pre-warms, LRU first. Never throws;
    /// <c>Satisfied</c> is false when it could not free enough, and the caller should then do nothing.
    /// </summary>
    public async Task<EvictionResult> EvictForBytesAsync(string userId, long neededBytes, IEnumerable<string>? protectHashes = null,
        Seams? seams = null, CancellationToken ct = default)
    {
        var needed = Math.Max(0, neededBytes);
        var result = new EvictionResult { NeededBytes = needed, Satisfied = needed == 0 };
        if (needed == 0) return result;
        var remove = seams?.Delete ?? (hash => _engine.RemoveAsync(hash, deleteFiles: true, ct));

        // Reclaim any lease abandoned by a crash BEFORE listing, so a stranded row is restored, not leaked.
        await RecoverStaleLeasesAsync(userId, ct: ct);

        List<EvictionCandidate> candidates;
        try
        {
            var listed = await ListEvictableAsync(userId, protectHashes, ct: ct);
            candidates = listed.Candidates;
            result.Skipped.AddRange(listed.Skipped);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("[prewarm] could not list evictable pre-warms: {Message}", e.Message);
            return result;
        }

        foreach (var candidate in candidates)
        {
            if (result.FreedBytes >= needed) break;

            // Guard 2 of 3. This line stands between a cache policy and deleting a download the user asked for.
            if (candidate.Origin != PrewarmOrigins.Prewarm) { result.Skipped.Add(new(candidate.Hash, "not-prewarm")); continue; }

            var bytes = OnDiskBytes(candidate.SizeBytes, candidate.Progress);
            if (bytes <= 0) { result.Skipped.Add(new(candidate.Hash, "frees-nothing")); continue; }

            // Claim the row before touching any file: lease prewarm → evicting. A Download that promoted the row
            // after it was listed no longer matches origin = prewarm, so the claim frees nothing and the files stay.
            if (seams?.BeforeClaim is { } beforeClaim) await beforeClaim(candidate);
            var lease = NewEvictLease(_time.GetUtcNow());
            int claimed;
            try
            {
                await using var db = await _factory.CreateDbContextAsync(ct);
                claimed = await db.EngineTorrents
                    .Where(t => t.UserId == userId && t.Hash == candidate.Hash && t.Origin == PrewarmOrigins.Prewarm && t.EvictLease == null)
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, PrewarmOrigins.Evicting).SetProperty(t => t.EvictLease, lease).SetProperty(t => t.EvictFrom, PrewarmOrigins.Prewarm), ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                result.Skipped.Add(new(candidate.Hash, $"db-claim-error: {e.Message}"));
                continue;
            }
            if (claimed == 0) { result.Skipped.Add(new(candidate.Hash, "db-guard-refused")); continue; }

            if (seams?.AfterClaim is { } afterClaim) await afterClaim(candidate);

            // Re-check under the lease immediately before unlink: a Download that arrived after the claim steals it.
            bool stillOwn;
            try
            {
                await using var db = await _factory.CreateDbContextAsync(ct);
                stillOwn = await db.EngineTorrents.AsNoTracking().AnyAsync(t => t.UserId == userId && t.Hash == candidate.Hash
                    && t.Origin == PrewarmOrigins.Evicting && t.EvictLease == lease, ct);
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                stillOwn = false; // fail closed: never delete if ownership cannot be proven
            }
            if (!stillOwn) { result.Skipped.Add(new(candidate.Hash, "lease-stolen")); continue; }

            var deletedOk = false;
            try
            {
                var removed = await remove(candidate.Hash);
                deletedOk = removed.Ok;
                if (!removed.Ok) result.Skipped.Add(new(candidate.Hash, $"client-refused: {removed.Message}"));
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                result.Skipped.Add(new(candidate.Hash, $"client-error: {e.Message}"));
            }

            if (!deletedOk)
            {
                // Roll the lease back so the row is an evictable prewarm again — only if it is still our lease.
                try
                {
                    await using var db = await _factory.CreateDbContextAsync(ct);
                    await db.EngineTorrents
                        .Where(t => t.UserId == userId && t.Hash == candidate.Hash && t.Origin == PrewarmOrigins.Evicting && t.EvictLease == lease)
                        .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, PrewarmOrigins.Prewarm).SetProperty(t => t.EvictLease, (string?)null).SetProperty(t => t.EvictFrom, (string?)null), ct);
                }
                catch (Exception) when (!ct.IsCancellationRequested) { /* best effort */ }
                continue;
            }

            try
            {
                // Guard 3 of 3: only ever delete the row we claimed and still own.
                await using var db = await _factory.CreateDbContextAsync(ct);
                await db.EngineTorrents
                    .Where(t => t.UserId == userId && t.Hash == candidate.Hash && t.Origin == PrewarmOrigins.Evicting && t.EvictLease == lease)
                    .ExecuteDeleteAsync(ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                result.Skipped.Add(new(candidate.Hash, $"db-error: {e.Message}"));
                continue;
            }

            result.Evicted.Add(candidate);
            result.FreedBytes += bytes;
        }

        result.Satisfied = result.FreedBytes >= needed;
        return result;
    }

    /// <summary>Records that playback touched a torrent, so the thing on screen is never the LRU row. Never throws.</summary>
    public async Task<bool> MarkUsedAsync(string userId, string infoHash, DateTime? now = null, CancellationToken ct = default)
    {
        var hash = infoHash.Trim().ToLowerInvariant();
        if (hash.Length == 0) return false;
        try
        {
            var at = now ?? _time.GetUtcNow().UtcDateTime;
            await using var db = await _factory.CreateDbContextAsync(ct);
            var count = await db.EngineTorrents.Where(t => t.UserId == userId && t.Hash == hash)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.LastUsedAt, at), ct);
            return count > 0;
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            return false;
        }
    }
}
