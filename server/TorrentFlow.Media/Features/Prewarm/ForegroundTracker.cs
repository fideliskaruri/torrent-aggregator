using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Foreground priority — a pre-warm must never compete with playback (src/lib/prewarm/foreground.ts).
///
/// The engine has no per-torrent bandwidth priority, so speculative torrents stay connected but deselected while
/// the user is being served bytes: handshakes stay warm for "Next" while no content is requested.
///
/// Signals: PRIMARY is <see cref="MarkActive"/>, a beacon from the byte-serving routes (it catches a fully
/// downloaded file that moves zero torrent bytes while ffmpeg remuxes it). BACKSTOP is engine byte movement: any
/// non-pre-warm torrent moving bytes is direct evidence the swarm is being worked for something the user asked for.
///
/// "Foreground is active" is never a boolean something must remember to clear. It is a timestamp, and
/// <see cref="IsActive"/> is <c>now - lastSeen &lt; grace</c>: a stream route that dies mid-request leaves nothing to leak.
/// </summary>
public sealed class ForegroundTracker
{
    /// <summary>How long after the last observed foreground byte pre-warms stay parked.</summary>
    public const long IdleMs = 20_000;
    /// <summary>Below this a torrent is idle rather than streaming.</summary>
    public const long MinSpeedBps = 1024;

    private readonly object _gate = new();
    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly ITorrentEngine _engine;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;

    private long _lastSeenAt;
    private string? _lastHash;
    private readonly HashSet<string> _suspended = new(StringComparer.Ordinal);
    /// <summary>Per-hash "bytes were served to the player" stamps — written only by the byte-serving beacon.</summary>
    private readonly Dictionary<string, long> _seen = new(StringComparer.Ordinal);
    private readonly HashSet<CancellationTokenSource> _aborters = [];

    public ForegroundTracker(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentEngine engine, TimeProvider? time = null,
        ILogger<ForegroundTracker>? logger = null)
    {
        _factory = factory;
        _engine = engine;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    private static string Norm(string hash) => hash.Trim().ToLowerInvariant();

    /// <summary>Refreshes the global clock only — byte movement is not proof the user is watching that torrent.</summary>
    private void TouchGlobal(string? infoHash, long now)
    {
        CancellationTokenSource[] aborters;
        lock (_gate)
        {
            _lastSeenAt = now;
            if (!string.IsNullOrEmpty(infoHash)) _lastHash = Norm(infoHash);
            aborters = [.. _aborters];
            _aborters.Clear();
        }
        foreach (var a in aborters)
        {
            try { a.Cancel(); } catch (ObjectDisposedException) { }
        }
    }

    /// <summary>
    /// A token cancelled the instant foreground work starts. Speculative callers dispose the registration when
    /// they finish so an idle pass leaves nothing behind.
    /// </summary>
    public ForegroundCancellation CancellationSignal()
    {
        var cts = new CancellationTokenSource();
        if (IsActive()) cts.Cancel();
        else lock (_gate) _aborters.Add(cts);
        return new ForegroundCancellation(cts, () => { lock (_gate) _aborters.Remove(cts); });
    }

    /// <summary>Records that bytes are being served to the player for <paramref name="infoHash"/>. Cheap enough for every range request.</summary>
    public void MarkActive(string? infoHash)
    {
        var now = Now;
        TouchGlobal(infoHash, now);
        if (!string.IsNullOrEmpty(infoHash)) lock (_gate) _seen[Norm(infoHash)] = now;
    }

    /// <summary>Milliseconds since the last observed foreground byte; null when never seen.</summary>
    public long? IdleMsSince(long? now = null)
    {
        lock (_gate) return _lastSeenAt == 0 ? null : (now ?? Now) - _lastSeenAt;
    }

    public bool IsActive(long? now = null) => IdleMsSince(now) is { } idle && idle < IdleMs;

    public string? LastHash { get { lock (_gate) return _lastHash; } }

    /// <summary>
    /// The player for a stream closed: drop its "watched" stamp so the next sync parks it, and expire the global
    /// clock when it was the foreground. No hash clears everything (the page went away).
    /// </summary>
    public void Release(string? infoHash)
    {
        lock (_gate)
        {
            if (string.IsNullOrEmpty(infoHash))
            {
                _lastSeenAt = 0;
                _seen.Clear();
                return;
            }
            var h = Norm(infoHash);
            _seen.Remove(h);
            if (_lastHash == h) _lastSeenAt = 0;
        }
    }

    public void Reset()
    {
        lock (_gate)
        {
            _lastSeenAt = 0;
            _lastHash = null;
            _suspended.Clear();
            _seen.Clear();
        }
    }

    /// <summary>A torrent counts as foreground when it is moving bytes and is not a pre-warm.</summary>
    public string? Observe(IEnumerable<EngineTorrentInfo> torrents, IReadOnlySet<string> prewarms)
    {
        string? seen = null;
        foreach (var t in torrents)
        {
            var hash = Norm(t.Hash);
            if (hash.Length == 0 || prewarms.Contains(hash)) continue;
            if (t.Dlspeed >= MinSpeedBps) { seen = hash; break; }
        }
        if (seen is not null) TouchGlobal(seen, Now);
        return seen;
    }

    public sealed record SuspensionResult(bool Foreground, List<string> Suspended, List<string> Resumed, List<string> Parked, string? ForegroundHash);

    /// <summary>
    /// Brings pre-warm torrents into line with what the user is doing. Foreground active → every pre-warm is
    /// deselected but left connected; idle → clear the parked marker without re-selecting pieces. Never throws.
    /// </summary>
    /// <param name="foregroundOverride">Test seam: forces the verdict instead of sampling the engine.</param>
    /// <param name="parkStream">Parks a stream-only torrent; defaults to deselecting all its files.</param>
    public async Task<SuspensionResult> SyncAsync(string userId, long? now = null, bool? foregroundOverride = null,
        Func<string, Task<bool>>? parkStream = null, CancellationToken ct = default)
    {
        var at = now ?? Now;
        List<string> Parked() { lock (_gate) return [.. _suspended]; }

        HashSet<string> prewarms;
        try
        {
            prewarms = await OriginHashesAsync(userId, PrewarmOrigins.Prewarm, ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("[prewarm] could not read pre-warm origins; leaving torrents alone: {Message}", e.Message);
            return new(false, [], [], Parked(), LastHash);
        }

        IReadOnlyList<EngineTorrentInfo> torrents;
        try
        {
            torrents = await _engine.ListAsync(ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] engine unavailable for suspension sync");
            torrents = [];
        }

        if (foregroundOverride is null) Observe(torrents, prewarms);
        var active = foregroundOverride ?? IsActive(at);

        List<string> suspended = [];
        List<string> resumed = [];
        foreach (var t in torrents)
        {
            var hash = Norm(t.Hash);
            // The load-bearing line: only a speculative torrent may ever be touched. origin is the authority.
            if (hash.Length == 0 || !prewarms.Contains(hash)) continue;
            if (active)
            {
                bool already;
                lock (_gate) already = _suspended.Contains(hash);
                if (!already && await DeselectAsync(hash, ct))
                {
                    lock (_gate) _suspended.Add(hash);
                    suspended.Add(hash);
                }
            }
            else
            {
                // Connection-only prewarms were never paused, and idle must not re-select files.
                lock (_gate) _suspended.Remove(hash);
            }
        }

        // Stream-only torrents are a cache of what is on screen. One is left alone only while a byte-serving route
        // stamped its own playback clock within the grace window — never the global flag, which a stream still
        // pulling its own pieces would keep alive forever.
        HashSet<string> streams;
        try
        {
            streams = await OriginHashesAsync(userId, PrewarmOrigins.Stream, ct);
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            streams = [];
        }

        if (streams.Count > 0)
        {
            List<string> toPark = [];
            foreach (var t in torrents)
            {
                var hash = Norm(t.Hash);
                if (hash.Length == 0 || !streams.Contains(hash)) continue;
                lock (_gate)
                {
                    if (_seen.TryGetValue(hash, out var seenAt) && at - seenAt < IdleMs)
                    {
                        _suspended.Remove(hash);
                        continue;
                    }
                    if (!_suspended.Contains(hash)) toPark.Add(hash);
                }
            }
            var park = parkStream ?? (hash => DeselectAsync(hash, ct));
            foreach (var hash in toPark)
            {
                try
                {
                    if (await park(hash))
                    {
                        lock (_gate) _suspended.Add(hash);
                        suspended.Add(hash);
                    }
                }
                catch (Exception e) when (!ct.IsCancellationRequested)
                {
                    // One torrent that refuses to park must not strand the others.
                    _logger.LogDebug(e, "[prewarm] could not park stream {Hash}", hash);
                }
            }
        }

        return new(active, suspended, resumed, Parked(), LastHash);
    }

    private async Task<bool> DeselectAsync(string hash, CancellationToken ct)
    {
        try
        {
            return (await _engine.SelectFilesAsync(hash, [], ct)).Ok;
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] could not deselect {Hash}", hash);
            return false;
        }
    }

    private async Task<HashSet<string>> OriginHashesAsync(string userId, string origin, CancellationToken ct)
    {
        await using var db = await _factory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && t.Origin == origin).Select(t => t.Hash).ToListAsync(ct);
        return new HashSet<string>(rows.Select(Norm), StringComparer.Ordinal);
    }

    public sealed record Snapshot(bool Active, long? IdleMs, string? Hash, List<string> Parked, long GraceMs);

    /// <summary>Diagnostics for GET /api/prewarm.</summary>
    public Snapshot GetSnapshot(long? now = null)
    {
        var at = now ?? Now;
        var idle = IdleMsSince(at);
        lock (_gate) return new(idle is { } i && i < IdleMs, idle, _lastHash, [.. _suspended], IdleMs);
    }
}

public sealed class ForegroundCancellation(CancellationTokenSource source, Action unregister) : IDisposable
{
    public CancellationToken Token => source.Token;
    public bool IsCancellationRequested => source.IsCancellationRequested;

    public void Dispose()
    {
        unregister();
        source.Dispose();
    }
}
