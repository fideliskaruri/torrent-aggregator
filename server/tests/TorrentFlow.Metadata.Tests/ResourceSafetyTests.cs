using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Metadata.Tests;

public sealed class ResourceSafetyTests
{
    [Fact]
    public void RateLimitBucketsStayBoundedDuringUniqueClientFlood()
    {
        var time = new ManualTime();
        var limiter = new RateLimiter(time);
        for (var i = 0; i < RateLimiter.MaxBuckets + 100; i++) Assert.True(limiter.Allow($"client-{i}"));
        Assert.Equal(RateLimiter.MaxBuckets, limiter.BucketCount);
        Assert.True(limiter.Allow("tracked", 2));
        Assert.True(limiter.Allow("tracked", 2));
        Assert.False(limiter.Allow("tracked", 2));
        time.Advance(TimeSpan.FromMinutes(2));
        Assert.True(limiter.Allow("new-client"));
        Assert.Equal(1, limiter.BucketCount);
    }

    [Fact]
    public async Task UniqueFlightsWaitForCapacityWhileIdenticalWorkStillCoalesces()
    {
        var flights = new SingleFlight<int>(1);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = flights.RunAsync("first", () => release.Task);
        var same = flights.RunAsync("first", () => throw new InvalidOperationException("Duplicate work"));
        var calls = 0;
        var second = flights.RunAsync("second", () => { Interlocked.Increment(ref calls); return Task.FromResult(2); });
        Assert.Equal(1, flights.InFlightCount);
        Assert.Equal(0, calls);
        release.SetResult(1);
        var results = await Task.WhenAll(first, same, second);
        Assert.Equal([1, 1, 2], results);
        Assert.Equal(1, calls);
        Assert.Equal(0, flights.InFlightCount);
    }

    [Fact]
    public async Task CancellingAWaiterDoesNotCancelSharedWorkOrKeepItsSlot()
    {
        var flights = new SingleFlight<int>(1);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        var cancelled = flights.RunAsync("shared", () => release.Task, cancellation.Token);
        var other = flights.RunAsync("shared", () => throw new InvalidOperationException("Duplicate work"));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal(1, flights.InFlightCount);
        release.SetResult(42);
        Assert.Equal(42, await other);
        Assert.Equal(0, flights.InFlightCount);
    }

    [Fact]
    public async Task CancelledAdmissionNeverStartsItsWork()
    {
        var flights = new SingleFlight<int>(1);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = flights.RunAsync("first", () => release.Task);
        using var cancellation = new CancellationTokenSource();
        var calls = 0;
        var waiting = flights.RunAsync("waiting", () => { calls++; return Task.FromResult(2); }, cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        release.SetResult(1);
        await first;
        Assert.Equal(0, calls);
        Assert.Equal(0, flights.InFlightCount);
    }

    [Fact]
    public async Task FailedFlightFreesCapacityAndCanBeRetried()
    {
        var flights = new SingleFlight<int>(1);
        await Assert.ThrowsAsync<InvalidOperationException>(() => flights.RunAsync("key", () => throw new InvalidOperationException("failure")));
        Assert.Equal(0, flights.InFlightCount);
        Assert.Equal(7, await flights.RunAsync("key", () => Task.FromResult(7)));
    }

    [Fact]
    public async Task AniListDisposesItsRequestContentAndResponse()
    {
        using var content = new TrackedContent("{\"data\":{\"Media\":null}}");
        using var handler = new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content }));
        var client = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        Assert.Null(await client.GetWorkByIdAsync("1"));
        Assert.True(content.Disposed);
        var request = Assert.Single(handler.Requests);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => request.Content!.ReadAsStringAsync());
    }

    [Fact]
    public async Task CancelledArtworkRequestDoesNotStartProviders()
    {
        using var handler = FakeHandler.Always("[]");
        var factory = new FakeHttpFactory(handler);
        var time = new ManualTime();
        var options = Fixtures.Options();
        var resolver = new ArtworkResolver(new TmdbClient(factory, options, time), new AniListClient(factory, time),
            new KeylessClients(factory), options, time);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => resolver.ResolveBatchAsync(
            [new ArtworkQuery("Film", null, "movie")], cancellation.Token));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ArtworkObservesAndLogsProviderFailureAfterItsDeadline()
    {
        var release = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new FakeHandler(_ => release.Task);
        var factory = new FakeHttpFactory(handler);
        var time = TimeProvider.System;
        var options = Options.Create(new MetadataOptions { ArtworkTimeoutMs = 20 });
        var logger = new LateFailureLogger();
        var resolver = new ArtworkResolver(new TmdbClient(factory, options, time), new AniListClient(factory, time),
            new KeylessClients(factory), options, time, logger);
        Assert.Equal(ArtworkResult.None, await resolver.ResolveAsync(new ArtworkQuery("Film", null, "movie")).WaitAsync(TimeSpan.FromSeconds(5)));
        release.SetException(new InvalidOperationException("late provider failure"));
        var failure = await logger.Failure.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("late provider failure", failure.ToString());
    }

    private sealed class TrackedContent(string content) : StringContent(content)
    {
        public bool Disposed { get; private set; }
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }

    private sealed class LateFailureLogger : ILogger<ArtworkResolver>
    {
        public TaskCompletionSource<Exception> Failure { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (exception != null && formatter(state, exception) == "Artwork provider failed") Failure.TrySetResult(exception);
        }
    }
}
