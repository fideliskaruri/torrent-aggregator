using System.Collections.Concurrent;

namespace TorrentFlow.Metadata.Caching;

/// <summary>Bounded LRU-ish TTL cache (insertion order eviction, like the TS Map-based caches). Thread-safe.</summary>
public sealed class BoundedTtlCache<TValue>(int maxEntries, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly Lock _gate = new();
    private readonly Dictionary<string, LinkedListNode<(string Key, TValue Value, DateTimeOffset Expires)>> _map = new(StringComparer.Ordinal);
    private readonly LinkedList<(string Key, TValue Value, DateTimeOffset Expires)> _order = new();

    public int Count { get { lock (_gate) return _map.Count; } }

    public bool TryGet(string key, out TValue value)
    {
        lock (_gate)
        {
            if (_map.TryGetValue(key, out var node))
            {
                if (node.Value.Expires > _time.GetUtcNow())
                {
                    value = node.Value.Value;
                    return true;
                }
                _order.Remove(node);
                _map.Remove(key);
            }
        }
        value = default!;
        return false;
    }

    public void Set(string key, TValue value, TimeSpan ttl)
    {
        lock (_gate)
        {
            if (_map.Remove(key, out var old)) _order.Remove(old);
            _map[key] = _order.AddLast((key, value, _time.GetUtcNow() + ttl));
            while (_map.Count > maxEntries && _order.First is { } first)
            {
                _order.RemoveFirst();
                _map.Remove(first.Value.Key);
            }
        }
    }

    public void Remove(string key)
    {
        lock (_gate) if (_map.Remove(key, out var node)) _order.Remove(node);
    }

    public void Clear()
    {
        lock (_gate) { _map.Clear(); _order.Clear(); }
    }
}

/// <summary>Port of src/lib/cache/single-flight.ts: identical concurrent calls share one in-flight task.</summary>
public sealed class SingleFlight<T>
{
    private readonly ConcurrentDictionary<string, Lazy<Task<T>>> _inFlight = new(StringComparer.Ordinal);

    public int InFlightCount => _inFlight.Count;

    public async Task<T> RunAsync(string key, Func<Task<T>> work)
    {
        var lazy = _inFlight.GetOrAdd(key, _ => new Lazy<Task<T>>(work, LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            return await lazy.Value.ConfigureAwait(false);
        }
        finally
        {
            _inFlight.TryRemove(new KeyValuePair<string, Lazy<Task<T>>>(key, lazy));
        }
    }
}
