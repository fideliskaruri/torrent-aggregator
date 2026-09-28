using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

public sealed class AcquisitionRecoveryTests
{
    [Theory]
    [InlineData(400, false)]
    [InlineData(401, false)]
    [InlineData(403, false)]
    [InlineData(404, false)]
    [InlineData(408, true)]
    [InlineData(429, true)]
    [InlineData(500, true)]
    [InlineData(503, true)]
    public void HttpRetryClassificationExcludesPermanentFailures(int status, bool retry) =>
        Assert.Equal(retry, TorrentSearchService.IsTransient(new HttpRequestException("source", null, (System.Net.HttpStatusCode)status)));

    private static TorrentSearchService Service(SearchHarness harness, ITorrentSourceAdapter adapter, IHostApplicationLifetime lifetime, int maxSearches = 64) =>
        new([adapter], harness.Cache, new NoOpSearchResultEnricher(), harness,
            Options.Create(new SearchModuleOptions { MaxConcurrentSearches = maxSearches }), NullLogger<TorrentSearchService>.Instance, lifetime);

    [Fact]
    public async Task AcquisitionWaitsForFlightCapacityWhileInteractiveSearchStillThrottles()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        using var caller = new CancellationTokenSource();
        var adapter = new ScriptedAdapter();
        var service = Service(harness, adapter, lifetime, maxSearches: 1);
        var first = service.SearchAsync(new SearchOptions { Query = "Occupant", SkipCache = true });
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var waiting = service.SearchAsync(new SearchOptions { Query = "Waiter", SkipCache = true, Background = true, WaitForBudget = true }, caller.Token);
        await Assert.ThrowsAsync<SearchThrottledException>(() => service.SearchAsync(new SearchOptions { Query = "Interactive", SkipCache = true }));
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);

        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        lifetime.StopApplication();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
    }

    [Fact]
    public async Task WaitingAcquisitionProceedsOnceCapacityFrees()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new ScriptedAdapter();
        var service = Service(harness, adapter, lifetime, maxSearches: 1);
        var first = service.SearchAsync(new SearchOptions { Query = "Occupant", SkipCache = true });
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var waiting = service.SearchAsync(new SearchOptions { Query = "Waiter", SkipCache = true, Background = true, WaitForBudget = true });
        adapter.Release.SetResult();
        var response = await waiting.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("Waiter", response.Query);
        await first.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task TransientSourceFailureRecoversWithinBoundedAttempts()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new FlakyAdapter(failures: 2, new System.Net.Http.HttpRequestException("connection reset"));
        var service = Service(harness, adapter, lifetime);
        var response = await service.SearchAsync(new SearchOptions { Query = "Retry Me", SkipCache = true, Background = true, WaitForBudget = true })
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(3, adapter.Attempts);
        Assert.Single(response.Results);
        Assert.Null(Assert.Single(response.Sources!).Error);
    }

    [Fact]
    public async Task PersistentTransientFailureStopsAtAttemptBoundAndKeepsFinalSourceError()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new FlakyAdapter(failures: int.MaxValue, new System.Net.Http.HttpRequestException("indexer down"));
        var service = Service(harness, adapter, lifetime);
        var response = await service.SearchAsync(new SearchOptions { Query = "Down", SkipCache = true, Background = true, WaitForBudget = true })
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(TorrentSearchService.SourceAttempts, adapter.Attempts);
        Assert.Empty(response.Results);
        Assert.Equal("indexer down", Assert.Single(response.Sources!).Error);
    }

    [Fact]
    public async Task NonTransientFailureIsNotRetriedEvenForAcquisition()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new FlakyAdapter(failures: int.MaxValue, new InvalidOperationException("bad source configuration"));
        var service = Service(harness, adapter, lifetime);
        var response = await service.SearchAsync(new SearchOptions { Query = "Misconfigured", SkipCache = true, Background = true, WaitForBudget = true })
            .WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, adapter.Attempts);
        Assert.Equal("bad source configuration", Assert.Single(response.Sources!).Error);
    }

    [Fact]
    public async Task InteractiveSearchNeverRetriesTransientFailures()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new FlakyAdapter(failures: int.MaxValue, new System.Net.Http.HttpRequestException("flaky"));
        var service = Service(harness, adapter, lifetime);
        var response = await service.SearchAsync(new SearchOptions { Query = "Interactive", SkipCache = true })
            .WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, adapter.Attempts);
        Assert.Equal("flaky", Assert.Single(response.Sources!).Error);
    }

    [Fact]
    public async Task ShutdownStopsRetriesInsteadOfLeakingAttempts()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new FlakyAdapter(failures: int.MaxValue, new System.Net.Http.HttpRequestException("still down"), delayMs: 400);
        var service = Service(harness, adapter, lifetime);
        var search = service.SearchAsync(new SearchOptions { Query = "Shutdown", SkipCache = true, Background = true, WaitForBudget = true });
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        lifetime.StopApplication();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => search.WaitAsync(TimeSpan.FromSeconds(10)));
        var observed = adapter.Attempts;
        await Task.Delay(1500);
        Assert.Equal(observed, adapter.Attempts);
        Assert.True(observed <= TorrentSearchService.SourceAttempts);
    }

    private sealed class ScriptedAdapter : ITorrentSourceAdapter
    {
        public string Id => "scripted";
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
        {
            Started.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return [];
        }
    }

    private sealed class FlakyAdapter(int failures, Exception error, int delayMs = 0) : ITorrentSourceAdapter
    {
        private int attempts;
        public string Id => "flaky";
        public int Attempts => Volatile.Read(ref attempts);
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
        {
            var attempt = Interlocked.Increment(ref attempts);
            Started.TrySetResult();
            if (delayMs > 0) await Task.Delay(delayMs, cancellationToken);
            else await Task.Yield();
            cancellationToken.ThrowIfCancellationRequested();
            if (attempt <= failures) throw error;
            return [new TorrentResult { Id = "flaky-1", SourceUrl = "https://example.invalid/flaky-1", Title = "Recovered 1080p",
                Source = Id, Magnet = "magnet:?xt=urn:btih:" + new string('a', 40), Seeders = 10 }];
        }
    }

    private sealed class TestLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource stopping = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => stopping.Token;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => stopping.Cancel();
        public void Dispose() => stopping.Dispose();
    }
}
