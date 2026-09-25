using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using Entity = TorrentFlow.Data.Entities.SwarmMeasurement;

namespace TorrentFlow.Search;

public sealed record SwarmFacts(bool ReachedSwarm, int PeersConnected, long BytesReceived, double EffectiveBps, double RequiredBps);
public sealed record SwarmMeasurement(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, long BytesReceived,
    int ElapsedMs, double EffectiveBps, double RequiredBps, string Verdict, long MeasuredAt, bool FromLiveDownload);
public sealed record StoredSwarmMeasurement(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, long BytesReceived,
    int ElapsedMs, double EffectiveBps, double RequiredBps, string Verdict, DateTime MeasuredAt, DateTime ExpiresAt, bool Expired);

public sealed class SwarmHealth(ISwarmProbeEngine engine, IDbContextFactory<TorrentFlowDbContext> factory, ILogger<SwarmHealth> logger)
{
    public const double MinHeadroom = 1.5;
    public static readonly TimeSpan MeasurementTtl = TimeSpan.FromHours(6);
    private readonly SemaphoreSlim slots = new(4);
    public static double RequiredBitrate(double? sizeBytes, double? durationSec) => sizeBytes is > 0 && durationSec is > 0
        && double.IsFinite(sizeBytes.Value) && double.IsFinite(durationSec.Value) ? sizeBytes.Value / durationSec.Value : 1_000_000;
    public static string Classify(SwarmFacts facts) => !facts.ReachedSwarm || facts.PeersConnected <= 0 ? "unknown"
        : facts.BytesReceived <= 0 ? "dead" : facts.EffectiveBps >= (facts.RequiredBps > 0 ? facts.RequiredBps : RequiredBitrate(null, null)) * MinHeadroom ? "good" : "weak";
    public static string? DisplayName(string? magnet)
    {
        var m = EpisodeParser.Match(magnet ?? "", @"[?&]dn=([^&]+)");
        if (!m.Success || EpisodeParser.Match(m.Groups[1].Value, "%(?![0-9a-f]{2})").Success) return null;
        var value = Uri.UnescapeDataString(m.Groups[1].Value.Replace('+', ' ')).Trim();
        return value.Length > 0 ? value : null;
    }
    public async Task<SwarmMeasurement> ProbeAsync(string? magnet, string? infoHash = null, double? sizeBytes = null,
        double? durationSec = null, TimeSpan? window = null, CancellationToken cancellationToken = default)
    {
        var hash = InfoHash.Normalize(infoHash) ?? InfoHash.FromMagnet(magnet);
        var required = RequiredBitrate(sizeBytes, durationSec);
        var name = DisplayName(magnet);
        SwarmMeasurement Unknown(int elapsed = 0) => new(hash ?? "", name, 0, 0, 0, elapsed, 0, required, "unknown", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), false);
        if (hash == null || cancellationToken.IsCancellationRequested) return Unknown();
        var watch = Stopwatch.StartNew();
        var acquired = false;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            if (!await slots.WaitAsync(0, timeout.Token)) return Unknown();
            acquired = true;
            var live = await engine.FindLiveAsync(hash, timeout.Token);
            if (live.State == "live" && live.Snapshot is { } s)
            {
                var peers = Math.Max(0, s.PeersConnected); var bytes = Math.Max(0, s.BytesReceived); var speed = Math.Max(0, s.DownloadSpeed);
                return new(hash, name, peers, Math.Max(0, s.PeersUnchoked), bytes, 0, speed, required,
                    Classify(new(true, peers, bytes, speed, required)), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), true);
            }
            // A failed liveness check must never be treated as permission to add/destroy a torrent.
            if (live.State != "absent") return Unknown();
            await using var probe = await engine.OpenIsolatedAsync(magnet?.Trim() is { Length: > 0 } m ? m : $"magnet:?xt=urn:btih:{hash}", timeout.Token);
            var duration = window ?? TimeSpan.FromSeconds(8);
            duration = duration < TimeSpan.Zero ? TimeSpan.Zero : duration > TimeSpan.FromSeconds(8) ? TimeSpan.FromSeconds(8) : duration;
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
            return new(hash, name, Math.Max(0, snapshot.PeersConnected), Math.Max(0, snapshot.PeersUnchoked), Math.Max(0, snapshot.BytesReceived), elapsed,
                effective, required, Classify(new(snapshot.HasMetadata, snapshot.PeersConnected, snapshot.BytesReceived, effective, required)),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), false);
        }
        catch (Exception e)
        {
            logger.LogDebug(e, "Swarm measurement unavailable");
            return Unknown((int)watch.ElapsedMilliseconds);
        }
        finally { if (acquired) slots.Release(); }
    }
    public async Task RecordAsync(SwarmMeasurement measurement, TimeSpan? ttl = null, CancellationToken token = default)
    {
        if (measurement.FromLiveDownload || InfoHash.Normalize(measurement.InfoHash) is not { } hash) return;
        try
        {
            await using var db = await factory.CreateDbContextAsync(token);
            var row = await db.SwarmMeasurements.FirstOrDefaultAsync(r => r.InfoHash == hash, token);
            if (row == null) { row = new() { Id = Ids.New(), InfoHash = hash, CreatedAt = DateTime.UtcNow }; db.SwarmMeasurements.Add(row); }
            if (!string.IsNullOrWhiteSpace(measurement.Name)) row.Name = measurement.Name.Trim();
            row.PeersConnected = Math.Max(0, measurement.PeersConnected); row.PeersUnchoked = Math.Max(0, measurement.PeersUnchoked);
            row.BytesReceived = Math.Max(0, measurement.BytesReceived); row.ElapsedMs = Math.Max(0, measurement.ElapsedMs);
            row.EffectiveBps = double.IsFinite(measurement.EffectiveBps) ? measurement.EffectiveBps : 0;
            row.RequiredBps = double.IsFinite(measurement.RequiredBps) ? measurement.RequiredBps : 0;
            row.Verdict = measurement.Verdict; row.MeasuredAt = DateTimeOffset.FromUnixTimeMilliseconds(measurement.MeasuredAt).UtcDateTime;
            row.ExpiresAt = DateTime.UtcNow + (ttl ?? MeasurementTtl); row.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(token);
        }
        catch (Exception e) when (!token.IsCancellationRequested) { logger.LogWarning(e, "Could not store swarm measurement"); }
    }
    private static StoredSwarmMeasurement Stored(Entity row)
    {
        var expired = row.ExpiresAt <= DateTime.UtcNow;
        return new(row.InfoHash, row.Name, row.PeersConnected, row.PeersUnchoked, row.BytesReceived, row.ElapsedMs, row.EffectiveBps, row.RequiredBps,
            expired || row.Verdict is not ("good" or "weak" or "dead" or "unknown") ? "unknown" : row.Verdict, row.MeasuredAt, row.ExpiresAt, expired);
    }
    public async Task<StoredSwarmMeasurement?> GetAsync(string infoHash, CancellationToken token = default)
    {
        if (InfoHash.Normalize(infoHash) is not { } hash) return null;
        try
        {
            await using var db = await factory.CreateDbContextAsync(token);
            var row = await db.SwarmMeasurements.AsNoTracking().FirstOrDefaultAsync(r => r.InfoHash == hash, token);
            return row == null ? null : Stored(row);
        }
        catch (Exception e) when (!token.IsCancellationRequested) { logger.LogDebug(e, "Could not read swarm measurement"); return null; }
    }
    public async Task<IReadOnlyList<StoredSwarmMeasurement>> ListAsync(int limit = 100, CancellationToken token = default)
    {
        await using var db = await factory.CreateDbContextAsync(token);
        var rows = await db.SwarmMeasurements.AsNoTracking().OrderByDescending(r => r.MeasuredAt).Take(Math.Clamp(limit, 1, 500)).ToArrayAsync(token);
        return rows.Select(Stored).ToArray();
    }
    public async Task<string> GetVerdictAsync(string hash, CancellationToken token = default) => (await GetAsync(hash, token))?.Verdict ?? "unknown";
    public async Task<IReadOnlyDictionary<string, string>> LoadVerdictsAsync(IEnumerable<string?> hashes, CancellationToken token = default)
    {
        var normalized = hashes.Select(InfoHash.Normalize).OfType<string>().Distinct().Take(500).ToArray();
        var result = normalized.ToDictionary(h => h, _ => "unknown");
        try
        {
            await using var db = await factory.CreateDbContextAsync(token);
            var rows = await db.SwarmMeasurements.AsNoTracking().Where(r => normalized.Contains(r.InfoHash)).ToArrayAsync(token);
            foreach (var row in rows) result[row.InfoHash] = Stored(row).Verdict;
        }
        catch (Exception e) when (!token.IsCancellationRequested) { logger.LogDebug(e, "Could not read swarm verdicts"); }
        return result;
    }
    public async Task<SwarmMeasurement?> ProbeAndRecordAsync(string? magnet, string? infoHash = null, CancellationToken token = default)
    {
        try
        {
            var result = await ProbeAsync(magnet, infoHash, cancellationToken: token);
            await RecordAsync(result, token: token);
            return result;
        }
        catch (Exception e) when (!token.IsCancellationRequested) { logger.LogWarning(e, "Could not probe and record swarm"); return null; }
    }
}

internal sealed class UnavailableSwarmProbeEngine : ISwarmProbeEngine
{
    public Task<SwarmLiveState> FindLiveAsync(string infoHash, CancellationToken cancellationToken) => Task.FromResult(new SwarmLiveState("unknown"));
    public Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken cancellationToken) => throw new NotSupportedException("The engine module has not supplied a swarm probe backend.");
}
