using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Media.Common;

namespace TorrentFlow.Media.Swarm;

public sealed record SwarmReading(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, long BytesReceived,
    int ElapsedMs, double EffectiveBps, double RequiredBps, string Verdict, long MeasuredAt, bool FromLiveDownload);

public sealed record StoredSwarmReading(string InfoHash, string? Name, int PeersConnected, int PeersUnchoked, double EffectiveBps,
    double RequiredBps, string Verdict, DateTime MeasuredAt, DateTime ExpiresAt, bool Expired);

/// <summary>Port of src/lib/prewarm/swarm-probe.ts + swarm-measurements.ts on top of <see cref="ISwarmProbeEngine"/>.</summary>
public sealed class SwarmMeasurements(ISwarmProbeEngine engine, IDbContextFactory<TorrentFlowDbContext> dbFactory, TimeProvider clock, ILogger<SwarmMeasurements> logger)
{
    public const double MinHeadroom = 1.5;
    public const int DefaultRequiredMbps = 8;
    public const int ProbeWindowMs = 8_000;
    public const int RecentLimit = 50;
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(6);

    internal TimeSpan Window { get; set; } = TimeSpan.FromMilliseconds(ProbeWindowMs);
    private DateTime UtcNow => clock.GetUtcNow().UtcDateTime;

    public static double RequiredBitrateBps(double? sizeBytes, double? durationSec) =>
        sizeBytes is { } s && durationSec is { } d && double.IsFinite(s) && double.IsFinite(d) && s > 0 && d > 0 ? s / d : DefaultRequiredMbps * 1_000_000d / 8;

    public static string Classify(bool reachedSwarm, int peersConnected, long bytesReceived, double effectiveBps, double requiredBps)
    {
        if (!reachedSwarm || peersConnected <= 0) return "unknown";
        if (bytesReceived <= 0) return "dead";
        var required = requiredBps > 0 ? requiredBps : RequiredBitrateBps(null, null);
        return effectiveBps >= required * MinHeadroom ? "good" : "weak";
    }

    public static string? MagnetDisplayName(string? magnet)
    {
        var m = System.Text.RegularExpressions.Regex.Match(magnet ?? "", "[?&]dn=([^&]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        try
        {
            var v = Uri.UnescapeDataString(m.Groups[1].Value.Replace('+', ' ')).Trim();
            return v.Length > 0 ? v : null;
        }
        catch (UriFormatException) { return null; }
    }

    public async Task<SwarmReading> ProbeAsync(string? magnet, string? infoHash, double? sizeBytes, double? durationSec, CancellationToken ct)
    {
        var hash = InfoHashes.Normalize(infoHash) ?? InfoHashes.FromMagnet(magnet);
        var required = RequiredBitrateBps(sizeBytes, durationSec);
        var name = MagnetDisplayName(magnet);
        SwarmReading Unknown(int elapsed = 0) => new(hash ?? "", name, 0, 0, 0, elapsed, 0, required, "unknown", clock.GetUtcNow().ToUnixTimeMilliseconds(), false);
        if (hash is null || ct.IsCancellationRequested) return Unknown();
        var live = await engine.FindLiveAsync(hash, ct);
        if (live.State == "live" && live.Snapshot is { } s)
        {
            var peers = Math.Max(0, s.PeersConnected);
            var bytes = Math.Max(0, s.BytesReceived);
            var speed = Math.Max(0, s.DownloadSpeed);
            return new(hash, name, peers, Math.Max(0, s.PeersUnchoked), bytes, 0, speed, required,
                Classify(true, peers, bytes, speed, required), clock.GetUtcNow().ToUnixTimeMilliseconds(), true);
        }
        if (live.State != "absent" || ct.IsCancellationRequested) return Unknown();
        var watch = Stopwatch.StartNew();
        try
        {
            await using var probe = await engine.OpenIsolatedAsync(magnet?.Trim() is { Length: > 0 } m ? m : $"magnet:?xt=urn:btih:{hash}", ct);
            watch.Restart();
            while (watch.Elapsed < Window && !ct.IsCancellationRequested)
            {
                try { await Task.Delay(100, ct); } catch (OperationCanceledException) { break; }
                var cur = probe.Snapshot;
                if (cur.BytesReceived > 0 && cur.BytesReceived / Math.Max(0.001, watch.Elapsed.TotalSeconds) >= required * MinHeadroom) break;
            }
            var snap = probe.Snapshot;
            var elapsed = (int)Math.Max(0, watch.ElapsedMilliseconds);
            var effective = elapsed > 0 ? Math.Max(0, snap.BytesReceived) * 1000d / elapsed : 0;
            var reached = snap.PeersConnected > 0 || snap.HasMetadata;
            return new(hash, name, Math.Max(0, snap.PeersConnected), Math.Max(0, snap.PeersUnchoked), Math.Max(0, snap.BytesReceived), elapsed,
                effective, required, Classify(reached, snap.PeersConnected, snap.BytesReceived, effective, required), clock.GetUtcNow().ToUnixTimeMilliseconds(), false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "[swarm-probe] probe failed");
            return Unknown((int)watch.ElapsedMilliseconds);
        }
    }

    /// <summary>probeAndRecord: an aborted probe yields null and is never persisted.</summary>
    public async Task<SwarmReading?> ProbeAndRecordAsync(string? magnet, string? infoHash, double? sizeBytes, string? name, CancellationToken ct)
    {
        try
        {
            var reading = await ProbeAsync(magnet, infoHash, sizeBytes, null, ct);
            if (ct.IsCancellationRequested) return null;
            if (name?.Trim() is { Length: > 0 } n) reading = reading with { Name = n };
            await RecordAsync(reading);
            return reading;
        }
        catch (Exception ex)
        {
            if (ct.IsCancellationRequested) return null;
            logger.LogWarning("[swarm-probe] probe failed: {Error}", ex.Message);
            return null;
        }
    }

    public async Task RecordAsync(SwarmReading m)
    {
        if (m.FromLiveDownload || InfoHashes.Normalize(m.InfoHash) is not { } hash) return;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var row = await db.SwarmMeasurements.FirstOrDefaultAsync(r => r.InfoHash == hash);
            var now = UtcNow;
            if (row is null)
            {
                row = new TorrentFlow.Data.Entities.SwarmMeasurement { Id = Ids.New(), InfoHash = hash, CreatedAt = now };
                db.SwarmMeasurements.Add(row);
            }
            if (m.Name?.Trim() is { Length: > 0 } name) row.Name = name;
            row.PeersConnected = Math.Max(0, m.PeersConnected);
            row.PeersUnchoked = Math.Max(0, m.PeersUnchoked);
            row.BytesReceived = Math.Max(0, m.BytesReceived);
            row.ElapsedMs = Math.Max(0, m.ElapsedMs);
            row.EffectiveBps = double.IsFinite(m.EffectiveBps) ? m.EffectiveBps : 0;
            row.RequiredBps = double.IsFinite(m.RequiredBps) ? m.RequiredBps : 0;
            row.Verdict = m.Verdict;
            row.MeasuredAt = DateTimeOffset.FromUnixTimeMilliseconds(m.MeasuredAt).UtcDateTime;
            row.ExpiresAt = now + Ttl;
            row.UpdatedAt = now;
            await db.SaveChangesAsync();
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            logger.LogWarning("[swarm-probe] could not store measurement: {Error}", ex.Message);
        }
    }

    private StoredSwarmReading Stored(TorrentFlow.Data.Entities.SwarmMeasurement row)
    {
        var expired = row.ExpiresAt <= UtcNow;
        var verdict = expired || row.Verdict is not ("good" or "weak" or "dead" or "unknown") ? "unknown" : row.Verdict;
        return new(row.InfoHash, row.Name, row.PeersConnected, row.PeersUnchoked, row.EffectiveBps, row.RequiredBps, verdict, row.MeasuredAt, row.ExpiresAt, expired);
    }

    public async Task<StoredSwarmReading?> GetAsync(string hash, CancellationToken ct = default)
    {
        if (InfoHashes.Normalize(hash) is not { } h) return null;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.SwarmMeasurements.AsNoTracking().FirstOrDefaultAsync(r => r.InfoHash == h, ct);
            return row is null ? null : Stored(row);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return null; }
    }

    public async Task<IReadOnlyList<StoredSwarmReading>> ListRecentAsync(int? limit = null, CancellationToken ct = default)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var rows = await db.SwarmMeasurements.AsNoTracking().OrderByDescending(r => r.MeasuredAt).Take(Math.Clamp(limit ?? RecentLimit, 1, 500)).ToListAsync(ct);
            return [.. rows.Select(Stored)];
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return []; }
    }

    public async Task<IReadOnlyDictionary<string, string>> LoadVerdictsAsync(IEnumerable<string?> hashes, CancellationToken ct = default)
    {
        var wanted = hashes.Select(InfoHashes.Normalize).OfType<string>().Distinct().Take(500).ToList();
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        if (wanted.Count == 0) return map;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var rows = await db.SwarmMeasurements.AsNoTracking().Where(r => wanted.Contains(r.InfoHash)).ToListAsync(ct);
            foreach (var row in rows) map[row.InfoHash] = Stored(row).Verdict;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException) { return new Dictionary<string, string>(); }
        return map;
    }
}
