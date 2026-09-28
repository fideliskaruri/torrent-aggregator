using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit.Abstractions;

namespace TorrentFlow.Search.Tests;

/// <summary>Opt-in live public-tracker smoke (TF_NETWORK_TESTS=1).</summary>
public sealed class TrackerScraperTests(ITestOutputHelper output)
{
    private const string Hash = "08ada5a7a6183aae1e09d831df6748d566095a10";

    [NetworkFact]
    [Trait("Category", "Network")]
    public async Task Public_trackers_legal_torrents_smoke()
    {
        var hashes = new Dictionary<string, string>
        {
            [Hash] = "Sintel",
            ["dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"] = "Big Buck Bunny",
            ["209c8226b299b308beaf2b9cd3fb49212dbd13ec"] = "Tears of Steel"
        };
        using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
        using var scraper = new TrackerScraper(services.GetRequiredService<IHttpClientFactory>(), NullLogger<TrackerScraper>.Instance);
        var elapsed = Stopwatch.StartNew();
        var result = await scraper.ScrapeAsync(hashes.Keys.ToArray(), TimeSpan.FromMilliseconds(2500));
        output.WriteLine($"Elapsed: {elapsed.ElapsedMilliseconds} ms");
        foreach (var (hash, title) in hashes)
            output.WriteLine(result.TryGetValue(hash, out var count)
                ? $"{title}: seeders={count.Seeders}, leechers={count.Leechers}, completed={count.Completed}, trackers={count.TrackersAnswered}"
                : $"{title}: no tracker answered (unknown counts)");
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(4));
    }

    private sealed class NetworkFactAttribute : FactAttribute
    {
        public NetworkFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("TF_NETWORK_TESTS") != "1")
                Skip = "Set TF_NETWORK_TESTS=1 to query public trackers.";
        }
    }
}