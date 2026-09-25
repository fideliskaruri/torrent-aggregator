using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

public sealed class SwarmRankingTests
{
    private static TorrentResult R(string id, string title, int seeders, string source = "apibay", string? hash = null) => new()
    {
        Id = id, Title = title, Seeders = seeders, Source = source, SourceUrl = "https://example.test", SizeBytes = 2_000_000_000,
        InfoHash = hash, Magnet = hash == null ? null : $"magnet:?xt=urn:btih:{hash}&dn={id}"
    };

    [Fact]
    public void Better_seeded_release_wins_within_the_same_quality()
    {
        var ranked = ReleaseRanking.Rank([R("few", "Film 2010 1080p WEB H264-A", 12), R("many", "Film 2010 1080p WEB H264-B", 900)], "Film", 1080);
        Assert.Equal("many", ranked[0].Id);
    }

    [Fact]
    public void Swarm_size_outweighs_small_quality_hints()
    {
        // English-tagged direct-play release with a tiny swarm vs an untagged one with 16x the seeders.
        var ranked = ReleaseRanking.Rank([R("tagged", "Film 2010 1080p WEB-DL AAC ENG H264-A", 12), R("big", "Film 2010 1080p WEBRip x264-B", 400)], "Film", 1080);
        Assert.Equal("big", ranked[0].Id);
    }

    [Fact]
    public void Weak_swarm_at_preferred_resolution_loses_to_usable_swarm_nearby()
    {
        var ranked = ReleaseRanking.Rank([R("weak1080", "Film 2010 1080p BluRay x264-A", 4), R("ok720", "Film 2010 720p BluRay x264-B", 60)], "Film", 1080);
        Assert.Equal("ok720", ranked[0].Id);
    }

    [Fact]
    public void Usable_swarm_at_preferred_resolution_keeps_its_place()
    {
        var ranked = ReleaseRanking.Rank([R("ok1080", "Film 2010 1080p BluRay x264-A", 15), R("huge360", "Film 2010 360p x264-B", 20000)], "Film", 1080);
        Assert.Equal("ok1080", ranked[0].Id);
    }

    [Fact]
    public void Webseed_tag_does_not_outrank_a_real_swarm()
    {
        var web = R("web", "Film 2010 1080p", 1) with { Tags = ["Webseed"] };
        Assert.Equal("swarm", ReleaseRanking.Rank([web, R("swarm", "Film 2010 1080p WEB H264-B", 60)], "Film", 1080)[0].Id);
    }

    [Fact]
    public void Dedupe_keeps_the_best_counts_seen_for_one_hash()
    {
        var hash = new string('a', 40);
        var deduped = ReleaseRanking.Dedupe([R("x", "Film 1080p", 5, "torrentscsv", hash), R("y", "Film 1080p", 250, "apibay", hash)]);
        Assert.Equal(250, Assert.Single(deduped).Seeders);
    }

    [Fact]
    public void Live_counts_replace_stale_indexer_counts()
    {
        var stale = R("x", "Film 1080p", 900, "torrentscsv", new string('b', 40));
        var live = TorrentSearchService.ApplyLive(stale, new ScrapeCount(37, 4, 1000, 5));
        Assert.Equal((37, 900, true), (live.Seeders, live.IndexerSeeders, live.SwarmChecked));
        var dead = TorrentSearchService.ApplyLive(stale, new ScrapeCount(0, 0, 0, 5));
        Assert.Equal(1, dead.Seeders);
    }

    [Fact]
    public void Sources_with_their_own_live_tracker_are_never_scraped_down()
    {
        var nyaa = R("n", "[Group] Show - 01 [1080p]", 300, "nyaa", new string('c', 40));
        Assert.Equal(300, TorrentSearchService.ApplyLive(nyaa, new ScrapeCount(20, 1, 0, 3)).Seeders);
    }

    [Fact]
    public void Search_results_carry_the_public_tracker_list()
    {
        var r = TorrentSearchService.WithPublicTrackers(R("x", "Film", 5, hash: new string('d', 40)));
        Assert.True(System.Text.RegularExpressions.Regex.Matches(r.Magnet!, "&tr=").Count >= 5);
    }

    [Fact]
    public async Task Search_ranks_with_live_counts_and_asks_indexers_for_a_wide_pool()
    {
        using var h = new SearchHarness();
        string H(char c) => new(c, 40);
        var limits = new List<int?>();
        var adapter = new FakeAdapter("apibay", () => Task.FromResult<IReadOnlyList<TorrentResult>>(
            [R("stale", "Film 2010 1080p WEB H264-A", 800, hash: H('1')), R("alive", "Film 2010 1080p WEB H264-B", 30, hash: H('2'))]));
        var scraper = new StubScraper(new Dictionary<string, ScrapeCount> { [H('1')] = new(2, 0, 0, 4), [H('2')] = new(450, 10, 0, 4) });
        var service = new TorrentSearchService([new LimitSpy(adapter, limits)], h.Cache, new NoOpSearchResultEnricher(), h,
            Options.Create(new SearchModuleOptions()), NullLogger<TorrentSearchService>.Instance, scraper: scraper);
        var response = await service.SearchAsync(new() { Query = "Film", Limit = 20, Enrich = false });
        Assert.Equal("alive", response.Results[0].Id);
        Assert.Equal(450, response.Results[0].Seeders);
        Assert.All(limits, l => Assert.True(l >= 50));
    }

    private sealed class StubScraper(IReadOnlyDictionary<string, ScrapeCount> counts) : ITrackerScraper
    {
        public Task<IReadOnlyDictionary<string, ScrapeCount>> ScrapeAsync(IReadOnlyCollection<string> infoHashes, TimeSpan budget, CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyDictionary<string, ScrapeCount>>(counts.Where(kv => infoHashes.Contains(kv.Key)).ToDictionary());
    }

    private sealed class LimitSpy(ITorrentSourceAdapter inner, List<int?> limits) : ITorrentSourceAdapter
    {
        public string Id => inner.Id;
        public Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default)
        {
            lock (limits) limits.Add(options.Limit);
            return inner.SearchAsync(options, cancellationToken);
        }
    }
}
