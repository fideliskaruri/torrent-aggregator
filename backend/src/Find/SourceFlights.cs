using System.Runtime.CompilerServices;
using System.Threading.Channels;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed class SourceFlights(ISources sources, SearchCache persistentCache)
{
    private readonly ISources sourceService = sources;
    private readonly SearchCache persistent = persistentCache;
    private readonly object sync = new();
    private readonly Dictionary<string, Flight> flights = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CacheEntry> cache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> poolAccess = new(StringComparer.Ordinal);
    private long access;

    internal async IAsyncEnumerable<(SourceResult Result, bool Cached, bool Shared)> ReadAsync(
        string poolKey, string key, string sourceId, SourceQuery query,
        [EnumeratorCancellation] CancellationToken ct, bool refresh = false)
    {
        Flight? flight = null;
        Subscription? subscription = null;
        SourceResult? cached = null;
        bool shared = false;
        lock (sync)
        {
            if (!refresh && cache.TryGetValue(key, out var entry) && entry.ExpiresAt > DateTimeOffset.UtcNow)
            {
                poolAccess[entry.PoolKey] = ++access;
                cached = entry.Result;
            }
            else
            {
                cache.Remove(key);
                if (flights.TryGetValue(key, out flight)) shared = true;
                else
                {
                    flight = new Flight(this, poolKey, key, sourceId, query, refresh);
                    flights.Add(key, flight);
                }
                subscription = flight.Subscribe(query.Lane);
            }
        }
        if (cached is not null) { ct.ThrowIfCancellationRequested(); yield return (cached, true, false); yield break; }
        // Lazy work is inserted and subscribed before starting; abandoned waiters own no shared CTS.
        _ = flight!.Work.Value;
        try
        {
            await foreach (var result in subscription!.Channel.Reader.ReadAllAsync(ct))
                yield return (result, flight.CacheHit, shared);
        }
        finally
        {
            lock (sync) flight.Detach(subscription!);
        }
    }

    private sealed record CacheEntry(SourceResult Result, DateTimeOffset ExpiresAt, string PoolKey);
    private sealed class Subscription
    {
        internal Channel<SourceResult> Channel { get; } = System.Threading.Channels.Channel.CreateUnbounded<SourceResult>(
            new() { SingleReader = true, SingleWriter = false });
    }

    private sealed class Flight
    {
        private readonly SourceFlights owner;
        private readonly string key;
        private readonly string poolKey;
        private readonly string sourceId;
        private readonly SourceQuery query;
        private readonly CancellationTokenSource cancel = new();
        private readonly List<Subscription> subscribers = [];
        private SourceResult? latest;
        private bool finished;
        private PriorityLane lane;
        private readonly bool refresh;
        private DateTimeOffset? expiresAt;
        private readonly HashSet<string> savedHashes = new(StringComparer.Ordinal);
        internal bool CacheHit { get; private set; }
        internal Lazy<Task> Work { get; }

        internal Flight(SourceFlights owner, string poolKey, string key, string sourceId, SourceQuery query, bool refresh)
        {
            this.owner = owner; this.key = key; this.sourceId = sourceId;
            this.poolKey = poolKey; this.refresh = refresh;
            this.query = query with { FlightId = Guid.NewGuid().ToString("N") }; lane = query.Lane;
            Work = new(RunAsync, LazyThreadSafetyMode.ExecutionAndPublication);
        }

        internal Subscription Subscribe(PriorityLane requestedLane)
        {
            if (requestedLane == PriorityLane.Owner && lane != PriorityLane.Owner)
            {
                lane = PriorityLane.Owner;
                owner.sourceService.PromoteSearch(query.FlightId!);
            }
            var subscription = new Subscription();
            if (latest is not null) subscription.Channel.Writer.TryWrite(latest);
            subscribers.Add(subscription);
            return subscription;
        }

        internal void Detach(Subscription subscription)
        {
            subscribers.Remove(subscription);
            subscription.Channel.Writer.TryComplete();
            if (subscribers.Count == 0 && !finished)
            {
                if (owner.flights.GetValueOrDefault(key) == this) owner.flights.Remove(key);
                cancel.Cancel();
            }
        }

        private async Task RunAsync()
        {
            try
            {
                SourceQuery call;
                lock (owner.sync) call = query with { Lane = lane, DeadlineAt = DateTimeOffset.UtcNow.AddSeconds(6) };
                var stored = await owner.persistent.LoadAsync(key, sourceId, call, cancel.Token);
                if (!refresh && stored is { Complete: true, Payload.SourceResult: { Complete: true, Outcome: SourceOutcome.Success } } &&
                    stored.ExpiresAt > DateTimeOffset.UtcNow)
                {
                    await owner.persistent.SaveFactsAsync(sourceId, call, stored.Payload.SourceResult, savedHashes, cancel.Token);
                    lock (owner.sync)
                    {
                        CacheHit = true;
                        expiresAt = stored.ExpiresAt;
                        latest = stored.Payload.SourceResult;
                        foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryWrite(latest);
                    }
                    return;
                }
                // Cache I/O is not site queue time: the source deadline begins when its call is enqueued.
                lock (owner.sync) call = call with { Lane = lane, DeadlineAt = DateTimeOffset.UtcNow.AddSeconds(6) };
                await foreach (var result in owner.sourceService.SearchStreamAsync(sourceId, call, cancel.Token))
                {
                    await owner.persistent.SaveFactsAsync(sourceId, call, result, savedHashes, cancel.Token);
                    lock (owner.sync)
                    {
                        latest = result;
                        foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryWrite(result);
                    }
                }
                if (!cancel.IsCancellationRequested && latest is { Complete: true, Outcome: SourceOutcome.Success })
                    await owner.persistent.SaveAsync(key, sourceId, call, latest, stored, cancel.Token);
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException)
            {
                lock (owner.sync)
                {
                    latest = new(sourceId, SourceOutcome.Failed, [], null,
                        "The source search failed. Retry this source later.", TimeSpan.Zero);
                    foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryWrite(latest);
                }
            }
            finally
            {
                lock (owner.sync)
                {
                    finished = true;
                    if (!cancel.IsCancellationRequested && latest is { Complete: true, Outcome: SourceOutcome.Success })
                    {
                        owner.cache[key] = new(latest, expiresAt ?? DateTimeOffset.UtcNow.AddMinutes(30), poolKey);
                        owner.poolAccess[poolKey] = ++owner.access;
                        while (owner.poolAccess.Count > 200)
                        {
                            var oldest = owner.poolAccess.MinBy(p => p.Value).Key;
                            foreach (var expired in owner.cache.Where(p => p.Value.PoolKey == oldest).Select(p => p.Key).ToArray())
                                owner.cache.Remove(expired);
                            owner.poolAccess.Remove(oldest);
                        }
                    }
                    if (owner.flights.GetValueOrDefault(key) == this) owner.flights.Remove(key);
                    foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryComplete();
                }
                owner.sourceService.ForgetSearch(query.FlightId!);
                cancel.Dispose();
            }
        }
    }
}
