using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;
using TorrentFlow.Library.Features.Automation;

namespace TorrentFlow.Library.Tests;

public sealed class SeasonAndCursorTests
{
    [Theory]
    [InlineData(1, 3, 1, 4, true)]
    [InlineData(1, 3, 1, 9, true)]
    [InlineData(1, 22, 2, 1, true)]
    [InlineData(1, 8, 1, 4, false)]
    [InlineData(3, 1, 2, 20, false)]
    [InlineData(2, 5, 2, 5, false)]
    public void CursorOnlyMovesForward(int s, int e, int ns, int ne, bool expected) =>
        Assert.Equal(expected, new EpisodeCursor(ns, ne).IsAfter(new(s, e)));
    [Fact]
    public void QueueKeySortsNumerically() => Assert.Equal("s00001e00002", new EpisodeCursor(1, 2).QueueKey);
    [Theory]
    [InlineData(0, 0)]
    [InlineData(3, 0)]
    [InlineData(4, 1)]
    [InlineData(5, 2)]
    [InlineData(6, 4)]
    [InlineData(7, 6)]
    [InlineData(1000, 6)]
    public void BackoffIsBounded(int misses, int hours) => Assert.Equal(hours, EpisodeCursor.Backoff(misses).TotalHours);
    [Theory]
    [InlineData(1, 2, 1, 3)]
    [InlineData(2, 2, 2, 0)]
    [InlineData(4, 0, 1, 1)]
    public void MissOnlyRollsAfterAnEpisodeWasFound(int episode, int misses, int season, int nextMisses)
    {
        var result = new EpisodeCursor(1, episode).AfterMiss(misses);
        Assert.Equal(season, result.Cursor.Season);
        Assert.Equal(nextMisses, result.Misses);
    }
    [Theory]
    [InlineData("Show S01E01 720p", 1080, false)]
    [InlineData("Show S01E01", 1080, false)]
    [InlineData("Show S01E01 2160p", 1080, true)]
    [InlineData("Show S01E01 1080p", 1080, true)]
    public void ResolutionIsMinimumNotPreference(string title, int floor, bool eligible) => Assert.Equal(eligible, ReleaseSelection.MeetsFloor(title, floor));
    [Theory]
    [InlineData("Example Show S01E02 1080p", true)]
    [InlineData("Example Show S01 1080p", false)]
    [InlineData("Example Show S01E01 1080p", false)]
    [InlineData("Example Show S01E02-E04 1080p", false)]
    public void OnlyExactSingleEpisode(string name, bool match) => Assert.Equal(match, ReleaseSelection.ExactEpisode(FakeSearch.Release(name), new(1, 2)));
    [Fact]
    public void StrictRulesRejectLiveActionForAnime()
    {
        var release = FakeSearch.Release("Silo S01E01 1080p") with { Source = "eztv" };
        Assert.False(AutomationService.MatchesCategory(release, "anime"));
        Assert.True(AutomationService.MatchesCategory(release, "tv"));
        Assert.False(AutomationService.MatchesCategory(release, "movies"));
    }
    [Fact]
    public async Task FanoutKeepsSendsOrderedAndQueuedHonest()
    {
        var order = new List<int>();
        var result = await SeasonFanout.Run([4, 1, 3, 2, 2], async (episode, before) =>
        {
            await Task.Delay((5 - episode) * 10);
            await before();
            lock (order) order.Add(episode);
            return new(true, "OK") { InfoHash = $"hash-{episode}", Queued = episode > 2 };
        }, orderWaitMs: 1000, sendHoldMs: 1000);
        Assert.Equal([1, 2, 3, 4], order);
        Assert.Equal(["downloading", "downloading", "queued", "queued"], result.Transfers.Select(x => x.Status));
        Assert.Equal([1, 2, 3, 4], result.CoveredEpisodes);
    }
    [Fact]
    public async Task FailedSearchReleasesLaterSend()
    {
        var result = await SeasonFanout.Run([1, 2, 3], async (ep, before) =>
        {
            if (ep == 2) throw new InvalidOperationException("provider refused episode 2");
            await before();
            return new(true, "OK") { InfoHash = $"hash-{ep}" };
        }, orderWaitMs: 500, sendHoldMs: 500);
        Assert.Equal([1, 3], result.CoveredEpisodes);
        Assert.Equal("provider refused episode 2", result.Transfers[1].Error);
        Assert.Null(result.Transfers[1].InfoHash);
    }
    [Fact]
    public async Task DeadSearchCannotBlockWholeSeason()
    {
        var thirdSent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var task = SeasonFanout.Run([1, 2, 3], async (ep, before) =>
        {
            if (ep == 1) { await releaseFirst.Task; return new(false, "no release"); }
            await before();
            if (ep == 3) thirdSent.TrySetResult();
            return new(true, "OK");
        }, orderWaitMs: 30, sendHoldMs: 30);
        try { await thirdSent.Task.WaitAsync(TimeSpan.FromSeconds(15)); }
        finally { releaseFirst.TrySetResult(); }
        Assert.Equal(2, (await task).CoveredEpisodes.Count);
    }
    [Fact]
    public async Task PoolNeverExceedsFourWorkers()
    {
        int live = 0, peak = 0;
        await SeasonFanout.Run(Enumerable.Range(1, 20), async (_, _) =>
        {
            var count = Interlocked.Increment(ref live);
            int current;
            do { current = peak; } while (count > current && Interlocked.CompareExchange(ref peak, count, current) != current);
            await Task.Delay(5);
            Interlocked.Decrement(ref live);
            return new(true, "OK");
        });
        Assert.Equal(4, peak);
    }
}
