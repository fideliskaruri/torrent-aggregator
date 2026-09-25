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
public sealed class SingleFlight<T>(int maxEntries = 64)
{
    private readonly int _maxEntries = maxEntries > 0 ? maxEntries : throw new ArgumentOutOfRangeException(nameof(maxEntries));
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Task<T>> _inFlight = new(StringComparer.Ordinal);
    private TaskCompletionSource _capacity = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public int InFlightCount { get { lock (_gate) return _inFlight.Count; } }

    public async Task<T> RunAsync(string key, Func<Task<T>> work, CancellationToken cancellationToken = default)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Task<T>? task;
            Task? capacity = null;
            TaskCompletionSource<T>? owner = null;
            lock (_gate)
            {
                if (!_inFlight.TryGetValue(key, out task))
                {
                    if (_inFlight.Count >= _maxEntries) capacity = _capacity.Task;
                    else
                    {
                        owner = new(TaskCreationOptions.RunContinuationsAsynchronously);
                        task = owner.Task;
                        _inFlight.Add(key, task);
                    }
                }
            }
            if (capacity != null)
            {
                await capacity.WaitAsync(cancellationToken).ConfigureAwait(false);
                continue;
            }
            if (owner != null) _ = CompleteAsync(key, work, owner);
            return await task!.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task CompleteAsync(string key, Func<Task<T>> work, TaskCompletionSource<T> completion)
    {
        T result = default!;
        Exception? error = null;
        try
        {
            result = await work().ConfigureAwait(false);
        }
        catch (Exception e)
        {
            error = e;
        }
        finally
        {
            lock (_gate)
            {
                _inFlight.Remove(key);
                var capacity = _capacity;
                _capacity = new(TaskCreationOptions.RunContinuationsAsynchronously);
                capacity.SetResult();
            }
        }
        if (error is OperationCanceledException cancelled) completion.SetCanceled(cancelled.CancellationToken);
        else if (error != null)
        {
            completion.SetException(error);
            // All request waiters may have disconnected; the shared operation still owns its failure.
            _ = completion.Task.Exception;
        }
        else completion.SetResult(result);
    }
}
