using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using Entity = TorrentFlow.Data.Entities.SwarmMeasurement;

namespace TorrentFlow.Media.Features.Prewarm;

public sealed record SwarmReading(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, long BytesReceived,
    int ElapsedMs, double EffectiveBps, double RequiredBps, string Verdict, DateTime MeasuredAt, bool FromLiveDownload);

/// <summary>A stored measurement with the verdict already expiry-corrected: an expired row reads "unknown".</summary>
public sealed record StoredSwarmReading(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, long BytesReceived,
    int ElapsedMs, double EffectiveBps, double RequiredBps, string Verdict, DateTime MeasuredAt, DateTime ExpiresAt, bool Expired);

/// <summary>
/// The swarm-probe library (src/lib/torrents/swarm-probe.ts) as the pre-probe needs it: measure a candidate's
/// swarm through <see cref="ISwarmProbeEngine"/>, persist the verdict with a TTL, and read verdicts back. The rules
/// mirror TorrentFlow.Search's SwarmHealth, which reads the same SwarmMeasurement table.
/// </summary>
public sealed class SwarmMeasurements
{
    public const double MinHeadroom = 1.5;
    public const int RecentLimit = 50;
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(6);
    public static readonly TimeSpan MaxWindow = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(15);

    private readonly ISwarmProbeEngine _engine;
    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly ILogger _logger;
    private readonly SemaphoreSlim _slots = new(4);

    public SwarmMeasurements(ISwarmProbeEngine engine, IDbContextFactory<TorrentFlowDbContext> factory, ILogger<SwarmMeasurements>? logger = null)
    {
        _engine = engine;
        _factory = factory;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    public static double RequiredBitrate(double? sizeBytes, double? durationSec) =>
        sizeBytes is > 0 && durationSec is > 0 && double.IsFinite(sizeBytes.Value) && double.IsFinite(durationSec.Value)
            ? sizeBytes.Value / durationSec.Value : 1_000_000;

    public static string Classify(bool reachedSwarm, int peers, long bytes, double effectiveBps, double requiredBps) =>
        !reachedSwarm || peers <= 0 ? "unknown"
        : bytes <= 0 ? "dead"
        : effectiveBps >= (requiredBps > 0 ? requiredBps : RequiredBitrate(null, null)) * MinHeadroom ? "good" : "weak";

    /// <summary>
    /// Measures one swarm. A live download is read, never touched; a failed liveness check is never treated as
    /// permission to open a probe; otherwise an isolated probe runs for at most <see cref="MaxWindow"/>.
    /// </summary>
    public async Task<SwarmReading> ProbeAsync(string? magnet, string hash, double? sizeBytes, string? name, TimeSpan? window, CancellationToken ct)
    {
        var required = RequiredBitrate(sizeBytes, null);
        SwarmReading Unknown(int elapsed = 0) => new(hash, name, 0, 0, 0, elapsed, 0, required, "unknown", DateTime.UtcNow, false);
        if (ct.IsCancellationRequested) return Unknown();
        var watch = Stopwatch.StartNew();
        var acquired = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Deadline);
        try
        {
            if (!await _slots.WaitAsync(0, timeout.Token)) return Unknown();
            acquired = true;
            var live = await _engine.FindLiveAsync(hash, timeout.Token);
            if (live.State == "live" && live.Snapshot is { } s)
            {
                var peers = Math.Max(0, s.PeersConnected); var bytes = Math.Max(0, s.BytesReceived); var speed = Math.Max(0, s.DownloadSpeed);
                return new(hash, name, peers, Math.Max(0, s.PeersUnchoked), bytes, 0, speed, required,
                    Classify(true, peers, bytes, speed, required), DateTime.UtcNow, true);
            }
            if (live.State != "absent") return Unknown();

            await using var probe = await _engine.OpenIsolatedAsync(magnet?.Trim() is { Length: > 0 } m ? m : $"magnet:?xt=urn:btih:{hash}", timeout.Token);
            var duration = window ?? MaxWindow;
            duration = duration < TimeSpan.Zero ? TimeSpan.Zero : duration > MaxWindow ? MaxWindow : duration;
            watch.Restart();
            while (watch.Elapsed < duration)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(100, Math.Max(1, (duration - watch.Elapsed).TotalMilliseconds))), timeout.Token);
                var current = probe.Snapshot;
                if (current.HasMetadata && current.BytesReceived > 0 && watch.Elapsed.TotalSeconds > 0
                    && current.BytesReceived / watch.Elapsed.TotalSeconds >= required * MinHeadroom) break;
            }
            var snapshot = probe.Snapshot;
            var elapsed = (int)Math.Max(0, watch.ElapsedMilliseconds);
            var effective = elapsed > 0 ? Math.Max(0, snapshot.BytesReceived) * 1000d / elapsed : 0;
            return new(hash, name, Math.Max(0, snapshot.PeersConnected), Math.Max(0, snapshot.PeersUnchoked), Math.Max(0, snapshot.BytesReceived),
                elapsed, effective, required,
                Classify(snapshot.HasMetadata || snapshot.PeersConnected > 0, snapshot.PeersConnected, snapshot.BytesReceived, effective, required),
                DateTime.UtcNow, false);
        }
        catch (Exception e)
        {
            _logger.LogDebug(e, "Swarm measurement unavailable");
            return Unknown((int)watch.ElapsedMilliseconds);
        }
        finally
        {
            if (acquired) _slots.Release();
        }
    }

    /// <summary>A live download's figures are a momentary snapshot of something the user already has, so they are not stored.</summary>
    public async Task RecordAsync(SwarmReading reading, CancellationToken ct = default)
    {
        if (reading.FromLiveDownload || ReleaseText.NormalizeInfoHash(reading.InfoHash) is not { } hash) return;
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var row = await db.SwarmMeasurements.FirstOrDefaultAsync(r => r.InfoHash == hash, ct);
            var now = DateTime.UtcNow;
            if (row == null) { row = new() { Id = Ids.New(), InfoHash = hash, CreatedAt = now }; db.SwarmMeasurements.Add(row); }
            if (!string.IsNullOrWhiteSpace(reading.Name)) row.Name = reading.Name.Trim();
            row.PeersConnected = Math.Max(0, reading.PeersConnected);
            row.PeersUnchoked = Math.Max(0, reading.PeersUnchoked);
            row.BytesReceived = Math.Max(0, reading.BytesReceived);
            row.ElapsedMs = Math.Max(0, reading.ElapsedMs);
            row.EffectiveBps = double.IsFinite(reading.EffectiveBps) ? reading.EffectiveBps : 0;
            row.RequiredBps = double.IsFinite(reading.RequiredBps) ? reading.RequiredBps : 0;
            row.Verdict = reading.Verdict;
            row.MeasuredAt = reading.MeasuredAt;
            row.ExpiresAt = now + Ttl;
            row.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning(e, "Could not store swarm measurement");
        }
    }

    /// <summary>probeAndRecord: never throws; a swarm that cannot be measured is a normal "unknown".</summary>
    public async Task<SwarmReading?> ProbeAndRecordAsync(string? magnet, string hash, double? sizeBytes, string? name, CancellationToken ct)
    {
        try
        {
            var reading = await ProbeAsync(magnet, hash, sizeBytes, name, null, ct);
            // A pass cancelled by the foreground must not store a truncated measurement as a verdict.
            if (!ct.IsCancellationRequested) await RecordAsync(reading, ct);
            return reading;
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning(e, "Could not probe and record swarm");
            return null;
        }
    }

    private static StoredSwarmReading Stored(Entity row)
    {
        var expired = row.ExpiresAt <= DateTime.UtcNow;
        var verdict = expired || row.Verdict is not ("good" or "weak" or "dead" or "unknown") ? "unknown" : row.Verdict;
        return new(row.InfoHash, row.Name, row.PeersConnected, row.PeersUnchoked, row.BytesReceived, row.ElapsedMs, row.EffectiveBps,
            row.RequiredBps, verdict, row.MeasuredAt, row.ExpiresAt, expired);
    }

    public async Task<StoredSwarmReading?> GetAsync(string infoHash, CancellationToken ct = default)
    {
        if (ReleaseText.NormalizeInfoHash(infoHash) is not { } hash) return null;
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var row = await db.SwarmMeasurements.AsNoTracking().FirstOrDefaultAsync(r => r.InfoHash == hash, ct);
            return row == null ? null : Stored(row);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "Could not read swarm measurement");
            return null;
        }
    }

    public async Task<IReadOnlyList<StoredSwarmReading>> ListRecentAsync(int limit = RecentLimit, CancellationToken ct = default)
    {
        await using var db = await _factory.CreateDbContextAsync(ct);
        var rows = await db.SwarmMeasurements.AsNoTracking().OrderByDescending(r => r.MeasuredAt).Take(Math.Clamp(limit, 1, 500)).ToListAsync(ct);
        return rows.Select(Stored).ToList();
    }

    public async Task<IReadOnlyDictionary<string, string>> LoadVerdictsAsync(IEnumerable<string?> hashes, CancellationToken ct = default)
    {
        var normalized = hashes.Select(ReleaseText.NormalizeInfoHash).OfType<string>().Distinct().Take(500).ToArray();
        var result = normalized.ToDictionary(h => h, _ => "unknown");
        if (normalized.Length == 0) return result;
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var rows = await db.SwarmMeasurements.AsNoTracking().Where(r => normalized.Contains(r.InfoHash)).ToListAsync(ct);
            foreach (var row in rows) result[row.InfoHash] = Stored(row).Verdict;
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "Could not read swarm verdicts");
        }
        return result;
    }
}
