using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

public sealed class ResourceSafetyTests
{
    [Fact]
    public async Task SearchCacheTrimsOldRowsWithoutMaterializingTheOverflow()
    {
        using var harness = new SearchHarness();
        await using (var db = harness.CreateDbContext())
        {
            var now = DateTime.UtcNow;
            db.SearchCaches.AddRange(Enumerable.Range(0, 600).Select(i => new SearchCache
            {
                Id = Ids.New(), CacheKey = $"old-{i}", NormalizedQuery = "", Payload = "{}",
                CreatedAt = now.AddDays(-1), ExpiresAt = now.AddMinutes(-i - 1),
            }));
            await db.SaveChangesAsync();
        }
        await harness.Cache.SetAsync("new", new SearchResponse { Query = "test" });
        await using var verify = harness.CreateDbContext();
        Assert.Equal(500, await verify.SearchCaches.CountAsync());
        Assert.True(await verify.SearchCaches.AnyAsync(r => r.CacheKey == "new"));
        Assert.False(await verify.SearchCaches.AnyAsync(r => r.CacheKey == "old-599"));
    }

    [Fact]
    public async Task PatternCacheHandlesConcurrentRankingWithoutChangingResults()
    {
        var titles = new[] { "Show.S02E03.1080p", "[SubsPlease] Show - 04 (1080p)", "Show Season 2 Complete" };
        var expected = titles.Select(EpisodeParser.Parse).ToArray();
        await Parallel.ForEachAsync(Enumerable.Range(0, 1000), async (i, _) =>
        {
            Assert.Equal(expected[i % titles.Length], EpisodeParser.Parse(titles[i % titles.Length]));
            await Task.CompletedTask;
        });
    }

    [Fact]
    public async Task HostShutdownCancelsSharedAdapterWork()
    {
        using var harness = new SearchHarness();
        using var lifetime = new TestLifetime();
        var adapter = new CancellableAdapter();
        var service = new TorrentSearchService([adapter], harness.Cache, new NoOpSearchResultEnricher(), harness,
            Options.Create(new SearchModuleOptions()), NullLogger<TorrentSearchService>.Instance, lifetime);
        var search = service.SearchAsync(new SearchOptions { Query = "Movie" });
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        lifetime.StopApplication();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => search);
    }

    [Theory]
    [InlineData("MaxConcurrentAdapters", "0")]
    [InlineData("MaxConcurrentSearches", "257")]
    [InlineData("AdapterLifetimeMs", "-1")]
    public void InvalidResourceLimitsFailOptionsValidation(string key, string value)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { [$"TorrentFlow:Search:{key}"] = value }).Build();
        using var services = new ServiceCollection().AddSearchModule(configuration).BuildServiceProvider();
        Assert.Throws<OptionsValidationException>(() => services.GetRequiredService<IOptions<SearchModuleOptions>>().Value);
    }

    private sealed class CancellableAdapter : ITorrentSourceAdapter
    {
        public string Id => "cancellable";
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
        {
            Started.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return [];
        }
    }

    private sealed class TestLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource _stopping = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => _stopping.Token;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => _stopping.Cancel();
        public void Dispose() => _stopping.Dispose();
    }
}
