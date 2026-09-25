using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Torrents;

namespace TorrentFlow.Engine;

/// <summary>
/// Keeps <see cref="PublicTrackers.Current"/> fresh: loads the cached list at startup, then fetches ngosang's
/// trackers_best list now and every <see cref="EngineOptions.TrackerRefreshHours"/>. Offline or failed fetches keep
/// whatever list is current (cache, else the bundled default); nothing here can fail startup.
/// </summary>
internal sealed class TrackerListRefreshService(
    IHttpClientFactory httpFactory,
    IOptions<EngineOptions> options,
    TimeProvider time,
    ILogger<TrackerListRefreshService> logger) : BackgroundService
{
    public const string HttpClientName = "TorrentFlow.Trackers";
    public const string SourceUrl = "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt";
    public const string CacheFileName = "trackers_best.txt";

    private string CachePath => Path.Combine(options.Value.DataDirectory, CacheFileName);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.RefreshTrackers) return;
        await Task.Yield();
        await LoadCacheAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromHours(options.Value.TrackerRefreshHours), time);
        try
        {
            do
            {
                await RefreshAsync(stoppingToken);
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    internal static IEnumerable<string> Parse(string text) =>
        text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith('#'));

    private async Task LoadCacheAsync(CancellationToken ct)
    {
        try
        {
            if (!File.Exists(CachePath)) return;
            var text = await File.ReadAllTextAsync(CachePath, ct);
            if (PublicTrackers.Update(Parse(text)))
                logger.LogInformation("Loaded {Count} public trackers from cache", PublicTrackers.Current.Count);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Reading the cached tracker list failed");
        }
    }

    internal async Task<bool> RefreshAsync(CancellationToken ct)
    {
        string text;
        try
        {
            using var client = httpFactory.CreateClient(HttpClientName);
            text = await client.GetStringAsync(new Uri(SourceUrl), ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogInformation("Fetching the public tracker list failed; keeping the current list: {Message}", ex.Message);
            return false;
        }

        if (!PublicTrackers.Update(Parse(text)))
        {
            logger.LogWarning("Fetched tracker list had too few valid trackers; keeping the current list");
            return false;
        }
        logger.LogInformation("Refreshed {Count} public trackers", PublicTrackers.Current.Count);
        try
        {
            Directory.CreateDirectory(options.Value.DataDirectory);
            await File.WriteAllTextAsync(CachePath, string.Join('\n', PublicTrackers.Current) + "\n", ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Caching the tracker list failed");
        }
        return true;
    }
}
