using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed class SourceSearches
{
    private const int Capacity = 500;
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(30);
    private readonly object sync = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private long sequence;

    internal async Task<(SourceResult Result, bool Cached, bool Shared)> GetAsync(string key,
        Func<CancellationToken, Task<SourceResult>> search, CancellationToken stopping,
        CancellationToken caller, bool refresh = false)
    {
        Entry entry;
        bool cached;
        bool shared;
        lock (sync)
        {
            EvictExpired();
            if (refresh) entries.Remove(key);
            cached = entries.TryGetValue(key, out entry!) &&
                entry.ExpiresAt is { } expiresAt && expiresAt > DateTimeOffset.UtcNow;
            if (!cached && entries.TryGetValue(key, out entry!))
                shared = true;
            else if (!cached)
            {
                entry = new Entry(++sequence);
                entries[key] = entry;
                shared = false;
                entry.Work = new(() => RunAsync(key, entry, search, stopping),
                    LazyThreadSafetyMode.ExecutionAndPublication);
                while (entries.Count > Capacity)
                    entries.Remove(entries.MinBy(item => item.Value.Sequence).Key);
            }
            else shared = false;
        }

        var result = await entry.Work!.Value.WaitAsync(caller).ConfigureAwait(false);
        return (result, cached, shared);
    }

    private async Task<SourceResult> RunAsync(string key, Entry entry,
        Func<CancellationToken, Task<SourceResult>> search, CancellationToken stopping)
    {
        try
        {
            var result = await search(stopping).ConfigureAwait(false);
            lock (sync)
            {
                if (result.Outcome is SourceOutcome.Failed or SourceOutcome.TimedOut)
                    RemoveIfCurrent(key, entry);
                else if (entries.GetValueOrDefault(key) == entry)
                    entry.ExpiresAt = DateTimeOffset.UtcNow + Lifetime;
            }
            return result;
        }
        catch
        {
            lock (sync) RemoveIfCurrent(key, entry);
            throw;
        }
    }

    private void EvictExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var key in entries.Where(pair => pair.Value.ExpiresAt is { } expiry && expiry <= now)
                     .Select(pair => pair.Key).ToArray())
            entries.Remove(key);
    }

    private void RemoveIfCurrent(string key, Entry entry)
    {
        if (entries.GetValueOrDefault(key) == entry) entries.Remove(key);
    }

    private sealed class Entry(long sequence)
    {
        internal long Sequence { get; } = sequence;
        internal DateTimeOffset? ExpiresAt { get; set; }
        internal Lazy<Task<SourceResult>>? Work { get; set; }
    }
}
