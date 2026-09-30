using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search;

public sealed class TorrentSearchService(IEnumerable<ITorrentSourceAdapter> adapters, SearchCacheStore cache,
    ISearchResultEnricher enricher, IDbContextFactory<TorrentFlowDbContext> factory, IOptions<SearchModuleOptions> moduleOptions,
    ILogger<TorrentSearchService> logger, IHostApplicationLifetime? hostLifetime = null, ITrackerScraper? scraper = null,
    TorrentFlow.Core.Contracts.Metadata.ITmdbCredentialProvider? credentials = null,
    TorrentFlow.Core.Sources.SourceRegistry? registry = null, RegisteredTorrentSources? registered = null) : ITorrentSearchService
{
    public const int InteractiveAdapterDeadlineMs = 6000;
    /// <summary>Total attempts a single source gets when WaitForBudget is set; ordinary interactive searches keep one attempt.</summary>
    public const int SourceAttempts = 3;
    public const int SourceRetryBaseDelayMs = 250;
    private readonly ITorrentSourceAdapter[] all = adapters.ToArray();
    private readonly object flightGate = new();
    private readonly Dictionary<string, Task<SearchResponse>> flights = [];
    /// <summary>Signalled whenever a flight slot frees so waiters can retry admission without holding the gate.</summary>
    private TaskCompletionSource capacity = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim adapterSlots = new(moduleOptions.Value.MaxConcurrentAdapters);
    private bool Enable1337 => moduleOptions.Value.Setting("ENABLE_1337X") == "1";
    private bool EnableArchive => moduleOptions.Value.Setting("ENABLE_ARCHIVE") == "1";
    private bool TorznabConfigured => !string.IsNullOrWhiteSpace(moduleOptions.Value.Setting("TORZNAB_URL"));
    public IReadOnlyList<AvailableSource> AvailableSources => registry is not null
        ? registry.Snapshot().Where(e => e.Kind == "torrent").Select(e => new AvailableSource(e.Id, e.Id, registry.IsEnabled(e))).ToArray()
        : [
        new("nyaa", "Nyaa", true), new("apibay", "ThePirateBay", true), new("torrentscsv", "TorrentsCSV", true),
        new("yts", "YTS", true), new("1337x", "1337x", Enable1337), new("archive", "Internet Archive", EnableArchive),
        new("torznab", "Torznab (Jackett/Prowlarr)", TorznabConfigured)];
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
        if (options.Enrich && options.Page <= 1) enricher.Prime(options.Query, options.Category);
        var key = SearchCacheStore.Key(options, target) + (credentials is null ? "" : $":credentials:{credentials.Revision}") + (registry is null ? "" : $":sources:{registry.Revision}");
        var pool = options.SkipCache || options.IncludeRejectedResults ? null : await cache.GetAsync(key, token: cancellationToken);
        var cached = pool != null;
        if (pool == null)
        {
            // Deadline and freshness policies must not coalesce with automation.
            var flightKey = $"{key}|{options.SkipCache}|{options.Background}|{(options.Background ? null : options.AdapterDeadlineMs)}|{options.PageSize}|{options.IncludeRejectedResults}|{options.WaitForBudget}";
            Task<SearchResponse> work;
            while (true)
            {
                Task capacityWait;
                lock (flightGate)
                {
                    if (flights.TryGetValue(flightKey, out work!)) break;
                    if (flights.Count < moduleOptions.Value.MaxConcurrentSearches)
                    {
                        var captured = options;
                        work = Task.Run(() => FetchPoolAsync(captured, key, target, hostLifetime?.ApplicationStopping ?? CancellationToken.None));
                        flights[flightKey] = work;
                        _ = work.ContinueWith(completed =>
                        {
                            if (completed.IsFaulted) logger.LogDebug(completed.Exception, "Shared search failed for cache key {CacheKey}", key);
                            ReleaseFlight(flightKey);
                        }, CancellationToken.None,
                            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                        break;
                    }
                    // Queue behind in-flight fan-outs; never refuse work. Bounded by the caller's cancellation.
                    capacityWait = capacity.Task;
                }
                await capacityWait.WaitAsync(cancellationToken);
            }
            pool = await work.WaitAsync(cancellationToken);
            cached = pool.Cached == true;
        }
        var totalPages = (int)Math.Ceiling(pool.Results.Count / (double)options.PageSize);
        var page = totalPages == 0 ? 1 : Math.Clamp(options.Page, 1, totalPages);
        IReadOnlyList<TorrentResult> results = pool.Results.Skip((page - 1) * options.PageSize).Take(options.PageSize).ToArray();
        var enrichmentStart = watch.ElapsedMilliseconds;
        if (options.Enrich && options.Page <= 1 && results.Count > 0) results = await enricher.EnrichAsync(options.Query, options.Category, results, cancellationToken);
        logger.LogInformation("Torrent search: pool {PoolMs}ms, enrichment {EnrichmentMs}ms, cached {Cached}, results {Count}",
            enrichmentStart, watch.ElapsedMilliseconds - enrichmentStart, cached, results.Count);
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
    private void ReleaseFlight(string flightKey)
    {
        TaskCompletionSource freed;
        lock (flightGate)
        {
            flights.Remove(flightKey);
            freed = capacity;
            capacity = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        freed.TrySetResult();
    }
    private async Task<SearchResponse> FetchPoolAsync(SearchOptions options, string key, int target, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var selected = registered is not null
            ? registered.For(options.Category).Where(a => options.Sources?.Length is not > 0 || options.Sources.Contains(a.Id)).ToArray()
            : all.Where(a => options.Sources?.Length > 0 ? options.Sources.Contains(a.Id) : a.Id switch { "1337x" => Enable1337, "archive" => EnableArchive, "torznab" => TorznabConfigured, _ => true }).ToArray();
        // Always cast a wide net: the caller's Limit trims the ranked pool, not what each indexer is asked for.
        var limit = Math.Min(Math.Max(Math.Max(options.Limit ?? 50, options.PageSize), 50), 80);
        var stageWatch = Stopwatch.StartNew();
        var outcomes = await Task.WhenAll(selected.Select(adapter => RunSourceAsync(adapter, options with { Limit = limit }, token)));
        var indexerMs = stageWatch.ElapsedMilliseconds;
        var deduped = await WithLiveSwarmsAsync(ReleaseRanking.Dedupe(outcomes.SelectMany(o => o.Results)), options, target, token);
        logger.LogInformation("Torrent search fan-out: indexers {IndexerMs}ms, tracker scrape {ScrapeMs}ms",
            indexerMs, stageWatch.ElapsedMilliseconds - indexerMs);
        var decisions = deduped.Select(r => new SearchRejectedResult(r, TorrentFilters.RejectReason(r, options.Filters ?? new()) ?? "")).ToArray();
        var filtered = decisions.Where(d => d.Reason.Length == 0).Select(d => d.Result);
        IReadOnlyList<TorrentResult> ranked = ReleaseRanking.Rank(filtered.Select(r => DownloadRouting.Attach(r, options.Category)), options.Query, target, options.Category)
            .Select(WithPublicTrackers).ToArray();
        if (options.Limit != null) ranked = ranked.Take(Math.Max(0, options.Limit.Value)).ToArray();
        var response = new SearchResponse { Query = options.Query, Results = ranked, TotalCount = ranked.Count, Sources = outcomes.Select(o => o.Status).ToArray(),
            RejectedResults = options.IncludeRejectedResults ? decisions.Where(d => d.Reason.Length > 0).ToArray() : [] };
        if (!outcomes.Any(o => o.Truncated)) await cache.SetAsync(key, response with { RejectedResults = [] }, token);
        return response;
    }
    /// <summary>Sources whose listed counts come from their own live tracker, so a scrape of public trackers may undercount them.</summary>
    private static readonly HashSet<string> LiveCountSources = new(StringComparer.OrdinalIgnoreCase) { "nyaa" };
    public const int InteractiveScrapeBudgetMs = 1800;
    public const int BackgroundScrapeBudgetMs = 3500;
    public const int ScrapeCandidates = 60;

    /// <summary>
    /// Replaces stale indexer seeder counts with live tracker counts for the candidates that could win, so ranking
    /// prefers swarms that are actually alive now. A scrape that answers zero demotes the release to "weak" rather
    /// than dead: DHT-only swarms are invisible to trackers.
    /// </summary>
    private async Task<IReadOnlyList<TorrentResult>> WithLiveSwarmsAsync(IReadOnlyList<TorrentResult> results, SearchOptions options, int target, CancellationToken token)
    {
        if (scraper == null || results.Count == 0) return results;
        var hashes = ReleaseRanking.Rank(results, options.Query, target, options.Category)
            .Select(r => r.InfoHash?.ToLowerInvariant()).Where(h => h is { Length: 40 }).Distinct().Take(ScrapeCandidates).Cast<string>().ToArray();
        if (hashes.Length == 0) return results;
        IReadOnlyDictionary<string, ScrapeCount> live;
        try
        {
            live = await scraper.ScrapeAsync(hashes, TimeSpan.FromMilliseconds(options.Background ? BackgroundScrapeBudgetMs : InteractiveScrapeBudgetMs), token);
        }
        catch (Exception e) when (!token.IsCancellationRequested)
        {
            logger.LogDebug(e, "Tracker scrape failed");
            return results;
        }
        return results.Select(r => r.InfoHash?.ToLowerInvariant() is { } hash && live.TryGetValue(hash, out var count) ? ApplyLive(r, count) : r).ToArray();
    }

    /// <summary>A magnet with one tracker (or none) finds peers slowly in any client; hand out the full public list.</summary>
    internal static TorrentResult WithPublicTrackers(TorrentResult r) =>
        r.Magnet is { Length: > 0 } magnet ? r with { Magnet = TorrentFlow.Core.Torrents.PublicTrackers.WidenMagnet(magnet) } : r;

    internal static TorrentResult ApplyLive(TorrentResult r, ScrapeCount live)
    {
        var trusted = LiveCountSources.Contains(r.Source);
        var seeders = live.Seeders > 0 ? Math.Max(live.Seeders, trusted ? r.Seeders : 0) : trusted ? r.Seeders : Math.Min(r.Seeders, 1);
        var leechers = live.Seeders > 0 || live.Leechers > 0 ? Math.Max(live.Leechers, trusted ? r.Leechers : 0) : r.Leechers;
        return r with { Seeders = seeders, Leechers = leechers, IndexerSeeders = r.Seeders, SwarmChecked = true,
            Completed = live.Completed > 0 ? Math.Max(live.Completed, r.Completed ?? 0) : r.Completed };
    }

    private static readonly (IReadOnlyList<TorrentResult> Results, SourceStatus Status, bool Truncated) Empty =
        (Array.Empty<TorrentResult>(), new SourceStatus("", 0), false);

    /// <summary>Only transport-level failures are worth another attempt; configuration or programming errors are final.</summary>
    internal static bool IsTransient(Exception e) => e switch
    {
        System.Net.Http.HttpRequestException http => http.StatusCode is null or System.Net.HttpStatusCode.RequestTimeout
            or System.Net.HttpStatusCode.TooManyRequests || (int)http.StatusCode >= 500,
        InvalidDataException => false,
        TimeoutException or OperationCanceledException or System.Net.Sockets.SocketException or IOException => true,
        AggregateException aggregate => aggregate.InnerExceptions.All(IsTransient),
        _ => e.InnerException is { } inner && e is not ArgumentException and not InvalidOperationException && IsTransient(inner)
    };

    /// <summary>
    /// One source's contribution to a fan-out. Interactive searches keep the historical single attempt plus the
    /// abandon-on-deadline behaviour; acquisitions (WaitForBudget) retry transient transport failures a bounded
    /// number of times, each attempt cancelled before the next starts so nothing is left running.
    /// </summary>
    private async Task<(IReadOnlyList<TorrentResult> Results, SourceStatus Status, bool Truncated)> RunSourceAsync(
        ITorrentSourceAdapter adapter, SearchOptions options, CancellationToken token)
    {
        var deadlineMs = !options.Background && options.AdapterDeadlineMs is > 0 and var ms ? ms : (int?)null;
        if (!options.WaitForBudget)
        {
            var work = RunAdapterAsync(adapter, options, token);
            try
            {
                var results = deadlineMs is { } budget ? await work.WaitAsync(TimeSpan.FromMilliseconds(budget)) : await work;
                return (results, new SourceStatus(adapter.Id, results.Count), false);
            }
            catch (TimeoutException)
            {
                // The bounded underlying task continues to update mirror health. Observe its error.
                _ = work.ContinueWith(t => logger.LogDebug(t.Exception, "Late adapter {Id} failed", adapter.Id),
                    CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return (Empty.Results, new SourceStatus(adapter.Id, 0, $"{adapter.Id} exceeded the {options.AdapterDeadlineMs}ms search budget"), true);
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                logger.LogDebug(e, "Search adapter {Id} failed", adapter.Id);
                return (Empty.Results, new SourceStatus(adapter.Id, 0, e.Message), false);
            }
        }
        // Automatic acquisition must not spend the generic three-minute adapter lifetime on each retry.
        deadlineMs = Math.Min(deadlineMs ?? 15000, 15000);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var results = await RunAdapterAsync(adapter, options, token, deadlineMs);
                return (results, new SourceStatus(adapter.Id, results.Count), false);
            }
            catch (Exception e) when (!token.IsCancellationRequested && attempt < SourceAttempts && IsTransient(e))
            {
                logger.LogDebug(e, "Search adapter {Id} attempt {Attempt} failed; retrying", adapter.Id, attempt);
                await Task.Delay(TimeSpan.FromMilliseconds(SourceRetryBaseDelayMs * (1 << (attempt - 1))), token);
            }
            catch (Exception e) when (!token.IsCancellationRequested)
            {
                logger.LogDebug(e, "Search adapter {Id} failed after {Attempts} attempt(s)", adapter.Id, attempt);
                return (Empty.Results, new SourceStatus(adapter.Id, 0, e.Message), true);
            }
        }
    }

    private async Task<IReadOnlyList<TorrentResult>> RunAdapterAsync(ITorrentSourceAdapter adapter, SearchOptions options, CancellationToken token, int? attemptTimeoutMs = null)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
        lifetime.CancelAfter(attemptTimeoutMs is { } ms ? Math.Min(ms, moduleOptions.Value.AdapterLifetimeMs) : moduleOptions.Value.AdapterLifetimeMs);
        try
        {
            await adapterSlots.WaitAsync(lifetime.Token);
        }
        catch (OperationCanceledException) when (attemptTimeoutMs is not null && !token.IsCancellationRequested)
        {
            throw new TimeoutException($"{adapter.Id} exceeded the {attemptTimeoutMs}ms search budget");
        }
        try { return await adapter.SearchAsync(options, lifetime.Token); }
        catch (OperationCanceledException) when (attemptTimeoutMs is not null && !token.IsCancellationRequested)
        {
            throw new TimeoutException($"{adapter.Id} exceeded the {attemptTimeoutMs}ms search budget");
        }
        finally { adapterSlots.Release(); }
    }
}

internal sealed class NoOpSearchResultEnricher : ISearchResultEnricher
{
    public Task<IReadOnlyList<TorrentResult>> EnrichAsync(string query, string? category, IReadOnlyList<TorrentResult> results, CancellationToken cancellationToken = default) => Task.FromResult(results);
}
