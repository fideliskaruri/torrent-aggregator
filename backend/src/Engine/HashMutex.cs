namespace TorrentFlow.Engine;

internal sealed class HashMutex
{
    private sealed class Entry
    {
        internal readonly SemaphoreSlim Gate = new(1, 1);
        internal int Users;
    }
    private readonly Dictionary<string, Entry> entries = new(StringComparer.OrdinalIgnoreCase);

    public async Task<IDisposable> LockAsync(string hash, CancellationToken ct)
    {
        Entry entry;
        lock (entries)
        {
            if (!entries.TryGetValue(hash, out entry!)) entries[hash] = entry = new();
            entry.Users++;
        }
        try { await entry.Gate.WaitAsync(ct); }
        catch { Release(hash, entry, false); throw; }
        return new Lease(() => Release(hash, entry, true));
    }

    private void Release(string hash, Entry entry, bool acquired)
    {
        lock (entries)
        {
            if (acquired) entry.Gate.Release();
            if (--entry.Users != 0) return;
            entries.Remove(hash);
            entry.Gate.Dispose();
        }
    }

    private sealed class Lease(Action release) : IDisposable
    {
        private Action? release = release;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
}
