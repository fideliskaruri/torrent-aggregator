namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Process-local exclusion for speculative pre-rank/probe passes (src/lib/prewarm/preprobe-lock.ts). Foreground
/// playback never waits on this; only speculative callers contend, and a second pass skips.
/// </summary>
public sealed class PreProbeLock
{
    private readonly HashSet<string> _active = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    /// <summary>A release callback (idempotent), or null when a pass for this user is already running.</summary>
    public Action? TryAcquire(string userId)
    {
        lock (_gate)
        {
            if (!_active.Add(userId)) return null;
        }
        var released = 0;
        return () =>
        {
            if (Interlocked.Exchange(ref released, 1) == 1) return;
            lock (_gate) _active.Remove(userId);
        };
    }

    public sealed record PassResult<T>(bool Started, T? Value);

    public async Task<PassResult<T>> TryRunPassAsync<T>(string userId, Func<Task<T>> task)
    {
        var release = TryAcquire(userId);
        if (release is null) return new PassResult<T>(false, default);
        try
        {
            return new PassResult<T>(true, await task());
        }
        finally
        {
            release();
        }
    }
}
