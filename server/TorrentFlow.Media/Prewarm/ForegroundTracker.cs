using System.Collections.Concurrent;

namespace TorrentFlow.Media.Prewarm;

/// <summary>
/// Port of src/lib/prewarm/foreground.ts. Foreground is a timestamp, never a boolean: a crashed stream simply
/// stops refreshing it, so it cannot leak "busy" forever.
/// </summary>
public sealed class ForegroundTracker(TimeProvider clock)
{
    public const int IdleMs = 20_000;
    public const long MinSpeedBps = 1024;

    private readonly object _gate = new();
    private long _lastSeenAt;
    private string? _lastHash;
    private readonly Dictionary<string, long> _seen = new(StringComparer.Ordinal);
    private readonly HashSet<CancellationTokenSource> _aborters = [];
    private readonly ConcurrentDictionary<string, byte> _suspended = new(StringComparer.Ordinal);

    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();
    private static string? Norm(string? hash) => string.IsNullOrWhiteSpace(hash) ? null : hash.Trim().ToLowerInvariant();

    public double IdleMsAt(long? now = null)
    {
        lock (_gate) return _lastSeenAt == 0 ? double.PositiveInfinity : (now ?? Now) - _lastSeenAt;
    }

    public bool Active(long? now = null) => IdleMsAt(now) < IdleMs;

    public string? Hash { get { lock (_gate) return _lastHash; } }

    /// <summary>Byte-movement backstop: refreshes the global stamp and cancels speculative work, without the per-hash map.</summary>
    public void TouchGlobal(string? hash = null)
    {
        List<CancellationTokenSource> abort;
        lock (_gate)
        {
            _lastSeenAt = Now;
            if (Norm(hash) is { } h) _lastHash = h;
            abort = [.. _aborters];
            _aborters.Clear();
        }
        foreach (var cts in abort) { try { cts.Cancel(); } catch (ObjectDisposedException) { } }
    }

    /// <summary>The primary signal, from byte-serving routes. Cheap enough for every range request.</summary>
    public void MarkActive(string? hash = null)
    {
        TouchGlobal(hash);
        if (Norm(hash) is { } h) lock (_gate) _seen[h] = Now;
    }

    public void Release(string? hash = null)
    {
        lock (_gate)
        {
            var h = Norm(hash);
            if (h is null)
            {
                _lastSeenAt = 0;
                _seen.Clear();
                return;
            }
            _seen.Remove(h);
            if (_lastHash == h) _lastSeenAt = 0;
        }
    }

    public bool WatchedRecently(string hash, long? now = null)
    {
        lock (_gate) return _seen.TryGetValue(hash.ToLowerInvariant(), out var at) && (now ?? Now) - at < IdleMs;
    }

    /// <summary>A token that cancels on the first foreground byte (already cancelled when foreground is active).</summary>
    public (CancellationToken Token, IDisposable Registration) CancellationSignal()
    {
        var cts = new CancellationTokenSource();
        if (Active()) cts.Cancel();
        else lock (_gate) _aborters.Add(cts);
        return (cts.Token, new Registration(this, cts));
    }

    private sealed class Registration(ForegroundTracker owner, CancellationTokenSource cts) : IDisposable
    {
        public void Dispose()
        {
            lock (owner._gate) owner._aborters.Remove(cts);
            cts.Dispose();
        }
    }

    internal bool MarkSuspended(string hash) => _suspended.TryAdd(hash, 0);
    internal bool ClearSuspended(string hash) => _suspended.TryRemove(hash, out _);
    internal bool IsSuspended(string hash) => _suspended.ContainsKey(hash);
    public IReadOnlyList<string> Parked => [.. _suspended.Keys];

    public ForegroundSnapshot Snapshot()
    {
        var idle = IdleMsAt();
        return new ForegroundSnapshot(idle < IdleMs, double.IsFinite(idle) ? idle : null, Hash, Parked, IdleMs);
    }

    internal void ResetForTests()
    {
        lock (_gate)
        {
            _lastSeenAt = 0;
            _lastHash = null;
            _seen.Clear();
            _aborters.Clear();
        }
        _suspended.Clear();
    }
}

public sealed record ForegroundSnapshot(
    bool Active,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] double? IdleMs,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] string? Hash,
    IReadOnlyList<string> Parked,
    int GraceMs);
