using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

internal sealed class SearchHarness : IDisposable, IDbContextFactory<TorrentFlowDbContext>
{
    private readonly SqliteConnection keeper;
    private readonly DbContextOptions<TorrentFlowDbContext> options;
    public SearchCacheStore Cache { get; }
    public SearchHarness()
    {
        var connectionString = $"Data Source=search-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";
        keeper = new(connectionString);
        keeper.Open();
        options = new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite(connectionString).Options;
        using var db = CreateDbContext();
        db.Database.EnsureCreated();
        Cache = new(this, NullLogger<SearchCacheStore>.Instance);
    }
    public TorrentFlowDbContext CreateDbContext() => new(options);
    public Task<TorrentFlowDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default) => Task.FromResult(CreateDbContext());
    public TorrentSearchService Service(params ITorrentSourceAdapter[] adapters) => new(adapters, Cache, new NoOpSearchResultEnricher(), this,
        Options.Create(new SearchModuleOptions()), NullLogger<TorrentSearchService>.Instance);
    public void Dispose() => keeper.Dispose();
}
internal sealed class FakeAdapter(string id, Func<Task<IReadOnlyList<TorrentResult>>> work) : ITorrentSourceAdapter
{
    public string Id => id;
    public int Calls;
    public Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref Calls);
        return work();
    }
}

public sealed class SearchServiceTests
{
    private static TorrentResult Result(string id = "a") => new() { Id = id, Title = $"Movie {id} 1080p", SizeBytes = 1000000000, Seeders = 30, Source = "nyaa", SourceUrl = "https://example.test" };
    [Fact]
    public async Task Identical_concurrent_searches_are_single_flight()
    {
        using var h = new SearchHarness();
        var gate = new TaskCompletionSource<IReadOnlyList<TorrentResult>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var adapter = new FakeAdapter("nyaa", () => gate.Task);
        var service = h.Service(adapter);
        var jobs = Enumerable.Range(0, 12).Select(_ => service.SearchAsync(new() { Query = "Movie" })).ToArray();
        await Task.Delay(50);
        gate.SetResult([Result()]);
        var results = await Task.WhenAll(jobs);
        Assert.Equal(1, adapter.Calls);
        Assert.All(results, r => Assert.Single(r.Results));
        var cached = await service.SearchAsync(new() { Query = "Movie", PageSize = 200 });
        Assert.True(cached.Cached); Assert.Equal(1, adapter.Calls);
    }
    [Fact]
    public async Task Deadline_pool_is_not_cached_and_automation_waits()
    {
        using var h = new SearchHarness();
        var gate = new TaskCompletionSource<IReadOnlyList<TorrentResult>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var slow = new FakeAdapter("slow", () => gate.Task);
        var fast = new FakeAdapter("fast", () => Task.FromResult<IReadOnlyList<TorrentResult>>([Result("fast")]));
        var service = h.Service(slow, fast);
        var response = await service.SearchAsync(new() { Query = "Movie", AdapterDeadlineMs = 25 });
        Assert.Single(response.Results);
        Assert.Contains(response.Sources, s => s.Id == "slow" && s.Error!.Contains("25ms"));
        using (var db = h.CreateDbContext()) Assert.Empty(db.SearchCaches);
        var automation = service.SearchAsync(new() { Query = "Movie", Background = true, AdapterDeadlineMs = 1 });
        await Task.Delay(30); Assert.False(automation.IsCompleted);
        gate.SetResult([Result("slow")]);
        Assert.Equal(2, (await automation).TotalCount);
    }
    [Fact]
    public async Task Fanout_is_concurrent_not_sequential()
    {
        using var h = new SearchHarness();
        var gate = new TaskCompletionSource<IReadOnlyList<TorrentResult>>(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = new FakeAdapter("a", () => gate.Task); var b = new FakeAdapter("b", () => gate.Task);
        var work = h.Service(a, b).SearchAsync(new() { Query = "Movie" });
        for (var i = 0; i < 100 && (a.Calls == 0 || b.Calls == 0); i++) await Task.Delay(5);
        Assert.Equal(1, a.Calls); Assert.Equal(1, b.Calls);
        gate.SetResult([]); await work;
    }
    [Fact]
    public async Task Pagination_200_clamps_page_and_keeps_full_cache()
    {
        using var h = new SearchHarness();
        var adapter = new FakeAdapter("nyaa", () => Task.FromResult<IReadOnlyList<TorrentResult>>(Enumerable.Range(1, 75).Select(i => Result(i.ToString())).ToArray()));
        var service = h.Service(adapter);
        var first = await service.SearchAsync(new() { Query = "Movie", PageSize = 20 });
        Assert.Equal(75, first.TotalCount); Assert.Equal(4, first.TotalPages); Assert.Equal(20, first.Results.Count);
        var last = await service.SearchAsync(new() { Query = "Movie", Page = 999, PageSize = 20 });
        Assert.Equal(4, last.Page); Assert.Equal(15, last.Results.Count); Assert.True(last.Cached);
        var all = await service.SearchAsync(new() { Query = "Movie", PageSize = 200 });
        Assert.Equal(75, all.Results.Count); Assert.Equal(1, adapter.Calls);
    }
    [Fact]
    public async Task Empty_query_spends_no_upstream_budget()
    {
        using var h = new SearchHarness();
        var adapter = new FakeAdapter("nyaa", () => throw new InvalidOperationException());
        var result = await h.Service(adapter).SearchAsync(new() { Query = " " });
        Assert.Empty(result.Results); Assert.Equal(0, adapter.Calls); Assert.Equal(0, result.TotalPages);
    }
    [Fact]
    public async Task Persistent_cache_is_read_by_new_store_and_invalidated()
    {
        using var h = new SearchHarness();
        await h.Cache.SetAsync("k", new() { Query = "Movie", Results = [Result()] });
        var second = new SearchCacheStore(h, NullLogger<SearchCacheStore>.Instance);
        Assert.Single((await second.GetAsync("k"))!.Results);
        await second.InvalidateAsync();
        Assert.Null(await second.GetAsync("k"));
        using var db = h.CreateDbContext(); Assert.Empty(db.SearchCaches);
    }
    [Fact]
    public async Task Rate_limit_counts_fanout_not_cache_hits_and_refresh_never_uses_stale()
    {
        using var h = new SearchHarness();
        var adapter = new FakeAdapter("nyaa", () => Task.FromResult<IReadOnlyList<TorrentResult>>([Result()]));
        var service = h.Service(adapter);
        await service.SearchAsync(new() { Query = "Movie" });
        for (var i = 0; i < 45; i++) Assert.True((await service.SearchAsync(new() { Query = "Movie" })).Cached);
        for (var i = 0; i < 39; i++) Assert.Equal(0, h.Cache.Spend(false));
        await Assert.ThrowsAsync<SearchThrottledException>(() => service.SearchAsync(new() { Query = "Movie", SkipCache = true }));
        Assert.Equal(0, h.Cache.Spend(true));
    }
    [Fact]
    public void Cache_key_includes_nested_filters_target_but_not_pagination()
    {
        var o = new SearchOptions { Query = "Movie", Sources = ["yts", "nyaa"] };
        Assert.Equal(SearchCacheStore.Key(o, 1080), SearchCacheStore.Key(o with { Page = 2, PageSize = 200, Sources = ["nyaa", "yts"] }, 1080));
        Assert.NotEqual(SearchCacheStore.Key(o, 1080), SearchCacheStore.Key(o with { Filters = new() { Resolution = "2160p" } }, 1080));
        Assert.NotEqual(SearchCacheStore.Key(o, 1080), SearchCacheStore.Key(o, 2160));
    }
    [Theory]
    [InlineData("")]
    [InlineData("?q=Movie&pageSize=201")]
    [InlineData("?q=Movie&category=invalid")]
    [InlineData("?q=Movie&page=0")]
    [InlineData("?q=Movie&limit=2.5")]
    [InlineData("?q=Movie&enrich=true")]
    [InlineData("?q=Movie&sources=eztv")]
    [InlineData("?q=Movie&sources=nyaa,")]
    [InlineData("?q=Movie&minSeeders=10&maxSeeders=1")]
    [InlineData("?q=Movie&minSize=10&maxSize=1")]
    [InlineData("?q=Movie&season=10001")]
    [InlineData("?q=Movie&resolution=900p")]
    public async Task Route_rejects_invalid_params_without_search(string query)
    {
        using var h = new SearchHarness();
        var adapter = new FakeAdapter("nyaa", () => throw new InvalidOperationException());
        var service = h.Service(adapter);
        var controller = new SearchController(service, service, NullLogger<SearchController>.Instance)
        {
            ControllerContext = new() { HttpContext = new DefaultHttpContext() }
        };
        controller.Request.QueryString = new QueryString(query);
        Assert.IsType<BadRequestObjectResult>(await controller.Get(default)); Assert.Equal(0, adapter.Calls);
    }
    [Fact]
    public async Task Route_uses_interactive_deadline_and_returns_available_sources()
    {
        using var h = new SearchHarness();
        var service = h.Service(new FakeAdapter("nyaa", () => Task.FromResult<IReadOnlyList<TorrentResult>>([Result()])));
        var controller = new SearchController(service, service, NullLogger<SearchController>.Instance)
        {
            ControllerContext = new() { HttpContext = new DefaultHttpContext() }
        };
        controller.Request.QueryString = new("?q=Movie&pageSize=200&category=all");
        var response = Assert.IsType<SearchResponse>(Assert.IsType<OkObjectResult>(await controller.Get(default)).Value);
        Assert.Equal(200, response.PageSize); Assert.Equal(7, response.AvailableSources!.Count);
    }
    [Fact]
    public async Task Module_wires_all_adapters_options_and_replaceable_defaults()
    {
        using var h = new SearchHarness();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TorrentFlow:Search:ENABLE_1337X"] = "1", ["TorrentFlow:Search:NYAA_BASE_URL"] = "https://fixture.invalid"
        }).Build();
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(config);
        services.AddSingleton<IDbContextFactory<TorrentFlowDbContext>>(h);
        services.AddLogging();
        services.AddSearchModule(config);
        using var provider = services.BuildServiceProvider();
        Assert.Empty(provider.GetServices<ITorrentSourceAdapter>());
        Assert.Equal(6, provider.GetRequiredService<RegisteredTorrentSources>().For("all").Count);
        Assert.Equal("https://fixture.invalid", provider.GetRequiredService<IOptions<SearchModuleOptions>>().Value.NyaaBaseUrl);
        Assert.True(provider.GetRequiredService<TorrentSearchService>().AvailableSources.Single(s => s.Id == "1337x").EnabledByDefault);
        Assert.Empty((await provider.GetRequiredService<ITorrentSearchService>().SearchAsync(new() { Query = "" })).Results);
        Assert.IsType<NoOpSearchResultEnricher>(provider.GetRequiredService<ISearchResultEnricher>());
        Assert.IsType<UnavailableSwarmProbeEngine>(provider.GetRequiredService<ISwarmProbeEngine>());
    }
}
