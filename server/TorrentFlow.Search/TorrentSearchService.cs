using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search;

public sealed class SearchThrottledException(int seconds) : Exception($"Indexers are being rate limited. Retry in {Math.Max(1, seconds)}s.")
{
    public int RetryAfterSeconds { get; } = Math.Max(1, seconds);
}

public sealed class TorrentSearchService(IEnumerable<ITorrentSourceAdapter> adapters, SearchCacheStore cache,
    ISearchResultEnricher enricher, IDbContextFactory<TorrentFlowDbContext> factory, IOptions<SearchModuleOptions> moduleOptions,
    ILogger<TorrentSearchService> logger) : ITorrentSearchService
{
    public const int InteractiveAdapterDeadlineMs = 6000;
    private readonly ITorrentSourceAdapter[] all = adapters.ToArray();
    private readonly object flightGate = new();
    private readonly Dictionary<string, Task<SearchResponse>> flights = [];
    private readonly SemaphoreSlim adapterSlots = new(24);
    private bool Enable1337 => moduleOptions.Value.Setting("ENABLE_1337X") == "1";
    public IReadOnlyList<AvailableSource> AvailableSources => [
        new("nyaa", "Nyaa", true), new("apibay", "ThePirateBay", true), new("torrentscsv", "TorrentsCSV", true),
        new("yts", "YTS", true), new("1337x", "1337x", Enable1337)];
    public async Task<SearchResponse> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
    {
        var watch = Stopwatch.StartNew();
        options = options with { Query = options.Query?.Trim() ?? "", PageSize = Math.Clamp(options.PageSize, 1, 200) };
        if (options.Query.Length == 0) return new() { Query = "", PageSize = options.PageSize };
        ClientSetting? settings = null;
        try
        {
            await using var db = await factory.CreateDbContextAsync(cancellationToken);
            settings = await db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(c => c.UserId == LocalUser.Id, cancellationToken);
        }
        catch (Exception e) when (!cancellationToken.IsCancellationRequested) { logger.LogWarning(e, "Search settings unavailable; using defaults"); }
        var target = options.TargetResolution is 480 or 720 or 1080 or 2160 ? options.TargetResolution.Value
            : settings?.PreferredResolution is 480 or 720 or 1080 or 2160 ? settings.PreferredResolution.Value : 1080;
        var key = SearchCacheStore.Key(options, target);
        var pool = options.SkipCache ? null : await cache.GetAsync(key, token: cancellationToken);
        var cached = pool != null;
        if (pool == null)
        {
            // Deadline and freshness policies must not coalesce with automation.
            var flightKey = $"{key}|{options.SkipCache}|{options.Background}|{(options.Background ? null : options.AdapterDeadlineMs)}|{options.PageSize}";
            Task<SearchResponse> work;
            lock (flightGate)
            {
                if (!flights.TryGetValue(flightKey, out work!))
                {
                    if (flights.Count >= 64) throw new SearchThrottledException(1);
                    var captured = options;
                    work = Task.Run(() => FetchPoolAsync(captured, key, target));
                    flights[flightKey] = work;
                    _ = work.ContinueWith(_ => { lock (flightGate) flights.Remove(flightKey); }, CancellationToken.None,
                        TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                }
            }
            pool = await work.WaitAsync(cancellationToken);
            cached = pool.Cached == true;
        }
        var totalPages = (int)Math.Ceiling(pool.Results.Count / (double)options.PageSize);
        var page = totalPages == 0 ? 1 : Math.Clamp(options.Page, 1, totalPages);
        IReadOnlyList<TorrentResult> results = pool.Results.Skip((page - 1) * options.PageSize).Take(options.PageSize).ToArray();
        if (options.Enrich && results.Count > 0) results = await enricher.EnrichAsync(options.Query, results, cancellationToken);
        var routing = options.Routing is { } prefs ? new ClientSetting
        {
            Categories = prefs.Categories == null ? null : System.Text.Json.JsonSerializer.Serialize(prefs.Categories),
            BaseDownloadPath = prefs.BaseDownloadPath, SavePath = prefs.SavePath,
            PathRules = prefs.PathRules == null ? null : System.Text.Json.JsonSerializer.Serialize(prefs.PathRules)
        } : settings;
        results = results.Select(r => DownloadRouting.Attach(r, options.Category, routing)).ToArray();
        return pool with { Query = options.Query, Results = results, Groups = ReleaseRanking.Groups(results), Page = page, PageSize = options.PageSize,
            TotalPages = totalPages, TotalCount = pool.Results.Count, Cached = cached ? true : null, TookMs = watch.ElapsedMilliseconds };
    }
    private async Task<SearchResponse> FetchPoolAsync(SearchOptions options, string key, int target)
    {
        var retry = cache.Spend(options.Background);
        if (retry > 0)
        {
            var stale = options.SkipCache ? null : await cache.GetAsync(key, true);
            return stale != null ? stale with { Cached = true } : throw new SearchThrottledException(retry);
        }
        var selected = all.Where(a => options.Sources?.Length > 0 ? options.Sources.Contains(a.Id) : a.Id != "1337x" || Enable1337).ToArray();
        var limit = Math.Min(Math.Max(options.Limit ?? 50, options.PageSize), 80);
        var outcomes = await Task.WhenAll(selected.Select(async adapter =>
        {
            var work = RunAdapterAsync(adapter, options with { Limit = limit });
            try
            {
                var results = !options.Background && options.AdapterDeadlineMs is > 0 and var ms
                    ? await work.WaitAsync(TimeSpan.FromMilliseconds(ms)) : await work;
                return (Results: results, Status: new SourceStatus(adapter.Id, results.Count), Truncated: false);
            }
            catch (TimeoutException)
            {
                // The bounded underlying task continues to update mirror health. Observe its error.
                _ = work.ContinueWith(t => logger.LogDebug(t.Exception, "Late adapter {Id} failed", adapter.Id),
                    CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return (Results: (IReadOnlyList<TorrentResult>)Array.Empty<TorrentResult>(), Status: new SourceStatus(adapter.Id, 0, $"{adapter.Id} exceeded the {options.AdapterDeadlineMs}ms search budget"), Truncated: true);
            }
            catch (Exception e)
            {
                logger.LogDebug(e, "Search adapter {Id} failed", adapter.Id);
                return (Results: (IReadOnlyList<TorrentResult>)Array.Empty<TorrentResult>(), Status: new SourceStatus(adapter.Id, 0, e.Message), Truncated: false);
            }
        }));
        var deduped = ReleaseRanking.Dedupe(outcomes.SelectMany(o => o.Results));
        var filtered = TorrentFilters.Apply(deduped, options.Filters ?? new());
        var ranked = ReleaseRanking.Rank(filtered.Select(r => DownloadRouting.Attach(r, options.Category)), options.Query, target, options.Category);
        if (options.Limit != null) ranked = ranked.Take(Math.Max(0, options.Limit.Value)).ToArray();
        var response = new SearchResponse { Query = options.Query, Results = ranked, TotalCount = ranked.Count, Sources = outcomes.Select(o => o.Status).ToArray() };
        if (!outcomes.Any(o => o.Truncated)) await cache.SetAsync(key, response);
        return response;
    }
    private async Task<IReadOnlyList<TorrentResult>> RunAdapterAsync(ITorrentSourceAdapter adapter, SearchOptions options)
    {
        using var lifetime = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        await adapterSlots.WaitAsync(lifetime.Token);
        try { return await adapter.SearchAsync(options, lifetime.Token); }
        finally { adapterSlots.Release(); }
    }
}

internal sealed class NoOpSearchResultEnricher : ISearchResultEnricher
{
    public Task<IReadOnlyList<TorrentResult>> EnrichAsync(string query, IReadOnlyList<TorrentResult> results, CancellationToken cancellationToken = default) => Task.FromResult(results);
}
