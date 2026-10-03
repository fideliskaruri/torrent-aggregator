using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal sealed class SourceFlights(ISources sources, SearchCache persistentCache, SearchBudget budget,
    IHostApplicationLifetime lifetime, ILogger<SourceFlights> log, IConfiguration configuration)
{
    private readonly ISources sourceService = sources;
    private readonly SearchCache persistent = persistentCache;
    private readonly SearchBudget scopeBudget = budget;
    private readonly IHostApplicationLifetime host = lifetime;
    private readonly ILogger<SourceFlights> logger = log;
    private readonly int backgroundRequestLimit = BackgroundLimit(configuration);
    private readonly object sync = new();
    private readonly Dictionary<string, Flight> flights = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CacheEntry> cache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> poolAccess = new(StringComparer.Ordinal);
    private long access;
    private long retryRevision;
    internal long RetryRevision => Interlocked.Read(ref retryRevision);
    private static int BackgroundLimit(IConfiguration configuration)
    {
        var limit = configuration.GetValue<int?>("TorrentFlow:Find:BackgroundRequestLimit") ?? 6;
        return limit is >= 1 and <= 64 ? limit :
            throw new InvalidOperationException("Find request limits must be between 1 and 64.");
    }

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
        private readonly bool backgroundRetry;
        private DateTimeOffset? expiresAt;
        private readonly HashSet<string> savedHashes = new(StringComparer.Ordinal);
        private bool failureRetryAttempted;
        internal bool CacheHit { get; private set; }
        internal Lazy<Task> Work { get; }

        internal Flight(SourceFlights owner, string poolKey, string key, string sourceId, SourceQuery query, bool refresh,
            bool backgroundRetry = false, DateTimeOffset? expiresAt = null)
        {
            this.owner = owner; this.key = key; this.sourceId = sourceId;
            this.poolKey = poolKey; this.refresh = refresh;
            this.backgroundRetry = backgroundRetry; this.expiresAt = expiresAt ?? DateTimeOffset.UtcNow.AddMinutes(30);
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
            if (subscribers.Count == 0 && !finished && !backgroundRetry)
            {
                if (owner.flights.GetValueOrDefault(key) == this) owner.flights.Remove(key);
                cancel.Cancel();
            }
        }

        private async Task RunAsync()
        {
            SearchCacheRow? stored = null;
            IDisposable? retryAdmission = null;
            using var stop = owner.host.ApplicationStopping.Register(() => cancel.Cancel());
            try
            {
                if (backgroundRetry)
                {
                    if (query.RequestBudget is { } requestBudget)
                    {
                        await requestBudget.Finished.WaitAsync(cancel.Token);
                        if (requestBudget.Used >= requestBudget.Limit) return;
                    }
                }
                SourceQuery call;
                lock (owner.sync) call = query with { Lane = lane, DeadlineAt = DateTimeOffset.UtcNow.AddSeconds(6) };
                if (backgroundRetry)
                    call = call with { RequestBudget = new(owner.backgroundRequestLimit, query.RequestBudget) };
                stored = await owner.persistent.LoadAsync(key, sourceId, call, cancel.Token);
                if (backgroundRetry)
                {
                    if (stored is null || stored.ExpiresAt <= DateTimeOffset.UtcNow ||
                        stored.Payload.FailureRetryAttempted) return;
                    if (stored.Payload.SourceResult.RetryAt is { } retryAt && retryAt > DateTimeOffset.UtcNow)
                    {
                        if (retryAt >= stored.ExpiresAt) return;
                        await Task.Delay(retryAt - DateTimeOffset.UtcNow, cancel.Token);
                    }
                    if (stored.ExpiresAt <= DateTimeOffset.UtcNow ||
                        query.RequestBudget is { } remaining && remaining.Used >= remaining.Limit) return;
                    retryAdmission = await owner.scopeBudget.EnterAsync(PriorityLane.Background, cancel.Token);
                    await owner.persistent.SaveAsync(key, sourceId, call, stored.Payload.SourceResult, stored,
                        cancel.Token, stored.ExpiresAt, true);
                    stored = await owner.persistent.LoadAsync(key, sourceId, call, cancel.Token);
                    if (stored?.Payload.FailureRetryAttempted != true) return;
                }
                if (!refresh && stored is not null &&
                    stored.ExpiresAt > DateTimeOffset.UtcNow)
                {
                    await owner.persistent.SaveFactsAsync(sourceId, call, stored.Payload.SourceResult, savedHashes, cancel.Token);
                    lock (owner.sync)
                    {
                        CacheHit = true;
                        failureRetryAttempted = stored.Payload.FailureRetryAttempted;
                        expiresAt = stored.ExpiresAt;
                        latest = stored.Payload.SourceResult with { CacheExpiresAt = stored.ExpiresAt };
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
                        latest = result with { CacheExpiresAt = expiresAt };
                        foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryWrite(latest);
                    }
                }
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException)
            {
                owner.logger.LogWarning(ex, "Find source flight failed for {SourceId}.", sourceId);
                lock (owner.sync)
                {
                    latest = new(sourceId, SourceOutcome.Failed, [], null,
                        "The source search failed. Retry this source later.", TimeSpan.Zero);
                    foreach (var subscriber in subscribers) subscriber.Channel.Writer.TryWrite(latest);
                }
            }
            finally
            {
                retryAdmission?.Dispose();
                var expiry = expiresAt ?? DateTimeOffset.UtcNow.AddMinutes(30);
                var budgetRefused = latest?.Diagnostics is { Code: "RequestBudget", Requests: 0 };
                if (backgroundRetry && budgetRefused)
                    latest = stored is null ? null : stored.Payload.SourceResult with { CacheExpiresAt = expiry };
                lock (owner.sync)
                {
                    finished = true;
                    if (latest is not null && (!budgetRefused || backgroundRetry))
                    {
                        owner.cache[key] = new(latest, expiry, poolKey);
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
                if (latest is not null && (!budgetRefused || backgroundRetry) &&
                    !CacheHit && !owner.host.ApplicationStopping.IsCancellationRequested)
                {
                    using var save = CancellationTokenSource.CreateLinkedTokenSource(owner.host.ApplicationStopping);
                    save.CancelAfter(TimeSpan.FromSeconds(6));
                    try
                    {
                        await owner.persistent.SaveAsync(key, sourceId, query, latest, stored, save.Token,
                            expiry, backgroundRetry && !budgetRefused || failureRetryAttempted);
                        if (backgroundRetry && latest.Results.Length > 0)
                            Interlocked.Increment(ref owner.retryRevision);
                    }
                    catch (OperationCanceledException) when (save.IsCancellationRequested)
                    { owner.logger.LogWarning("Find cache persistence was interrupted for {SourceId}.", sourceId); }
                }
                if (!backgroundRetry && latest?.Outcome is SourceOutcome.Failed or SourceOutcome.TimedOut &&
                    !failureRetryAttempted && !owner.host.ApplicationStopping.IsCancellationRequested)
                {
                    var retry = new Flight(owner, poolKey, key, sourceId,
                        query with { Lane = PriorityLane.Background }, true, true, expiry);
                    _ = retry.Work.Value;
                }
                owner.sourceService.ForgetSearch(query.FlightId!);
                stop.Dispose();
                cancel.Dispose();
            }
        }
    }
}
