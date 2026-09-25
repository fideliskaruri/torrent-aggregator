using TorrentFlow.Engine.Queue;

namespace TorrentFlow.Engine.Tests;

/// <summary>Port of download-queue.test.ts.</summary>
public class DownloadQueueTests
{
    private static readonly DateTime Base = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static DateTime At(int ms) => Base.AddMilliseconds(ms);

    private static QueueRow Row(string hash, string status = "queued", string origin = "user", string? workId = null,
        string? queueKey = null, int created = 0, DateTime? forcedAt = null, long? size = 0) =>
        new(hash, status, origin, At(created), workId, queueKey, forcedAt, size);

    private static string? K(int s, int e) => DownloadQueue.QueueKeyForEpisode(s, e);

    [Fact]
    public void EpisodeKeysSortNumerically()
    {
        var keys = new[] { K(1, 9)!, K(1, 10)!, K(2, 1)! };
        Assert.Equal(keys, keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Null(DownloadQueue.QueueKeyForEpisode(null, 3));
        Assert.Equal("s00001e00002", K(1, 2));
    }

    [Fact]
    public void WithinASeriesQueueIsChronologicalBySeasonEpisode()
    {
        var rows = new[]
        {
            Row("e3", workId: "show", queueKey: K(1, 3), created: 10),
            Row("e10", workId: "show", queueKey: K(1, 10), created: 0),
            Row("e1", workId: "show", queueKey: K(1, 1), created: 50),
            Row("s2e1", workId: "show", queueKey: K(2, 1), created: 5),
        };
        Assert.Equal(["e1", "e3", "e10", "s2e1"], DownloadQueue.Order(rows).Select(r => r.Hash));
    }

    [Fact]
    public void AcrossWorksQueueIsFifoByFirstEnqueue()
    {
        var rows = new[]
        {
            Row("b1", workId: "later", queueKey: K(1, 1), created: 900),
            Row("a2", workId: "early", queueKey: K(1, 2), created: 700),
            Row("a1", workId: "early", queueKey: K(1, 1), created: 100),
            Row("film", created: 1200),
        };
        Assert.Equal(["a1", "a2", "b1", "film"], DownloadQueue.Order(rows).Select(r => r.Hash));
        Assert.Equal(["a1", "a2", "b1", "film"], DownloadQueue.Positions(rows).OrderBy(kv => kv.Value).Select(kv => kv.Key));
    }

    [Fact]
    public void RowsWithoutQueueKeySortAfterNumberedOnesInTheirGroup()
    {
        var rows = new[] { Row("extra", workId: "w", created: 0), Row("e1", workId: "w", queueKey: K(1, 1), created: 10) };
        Assert.Equal(["e1", "extra"], DownloadQueue.Order(rows).Select(r => r.Hash));
    }

    [Fact]
    public void OnlyKeptDownloadingRowsCountAgainstTheCap()
    {
        var rows = new[]
        {
            Row("kept", "downloading"), Row("stream", "downloading", "stream"), Row("prewarm", "downloading", "prewarm"),
            Row("paused", "paused"), Row("waiting"),
        };
        Assert.Equal(1, DownloadQueue.ActiveKeptCount(rows));
    }

    [Fact]
    public void CapBlocksNewKeptAddButNeverStreamOrForce()
    {
        var rows = new[] { Row("a", "downloading"), Row("b", "downloading") };
        Assert.True(DownloadQueue.ShouldQueueNewDownload(rows, 2, "user", false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 3, "user", false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 2, "stream", false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 2, "prewarm", false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 2, "user", true));
    }

    [Fact]
    public void PromotionRefillsExactlyTheFreedSlotsInQueueOrder()
    {
        var rows = new List<QueueRow>
        {
            Row("a", "downloading"), Row("b", "downloading"),
            Row("q1", workId: "show", queueKey: K(1, 1), created: 10),
            Row("q2", workId: "show", queueKey: K(1, 2), created: 20),
        };
        Assert.Empty(DownloadQueue.PromotionCandidates(rows, 2));

        var afterComplete = rows.Select(r => r.Hash == "a" ? r with { Status = "parked" } : r).ToList();
        Assert.Equal(["q1"], DownloadQueue.PromotionCandidates(afterComplete, 2));

        var afterPause = afterComplete.Select(r => r.Hash == "b" ? r with { Status = "paused" } : r).ToList();
        Assert.Equal(["q1", "q2"], DownloadQueue.PromotionCandidates(afterPause, 2));

        var afterDelete = afterPause.Where(r => r.Hash != "b").ToList();
        Assert.Equal(["q1", "q2"], DownloadQueue.PromotionCandidates(afterDelete, 2));

        var afterFail = rows.Select(r => r.Hash == "a" ? r with { Status = "error" } : r).ToList();
        Assert.Equal(["q1"], DownloadQueue.PromotionCandidates(afterFail, 2));
    }

    [Fact]
    public void RehydrateRespectsCapAndAlwaysStartsForcedRows()
    {
        var rows = new[]
        {
            Row("d1", "downloading", workId: "show", queueKey: K(1, 1), created: 10),
            Row("d2", "downloading", workId: "show", queueKey: K(1, 2), created: 20),
            Row("d3", "downloading", workId: "show", queueKey: K(1, 3), created: 30),
            Row("f", "queued", workId: "show", queueKey: K(1, 9), created: 90, forcedAt: At(95)),
            Row("s", "downloading", "stream"),
        };
        var plan = DownloadQueue.PlanRehydrate(rows, 2);
        Assert.Equal(["f", "d1"], plan.Active);
        Assert.Equal(["d2", "d3"], plan.Demote.Order());
        Assert.DoesNotContain("s", plan.Active);
    }

    [Fact]
    public void QueuedSizesAreReserved()
    {
        var rows = new[] { Row("a", "downloading", size: 1000), Row("q1", size: 2000), Row("q2", size: 3000), Row("q3", size: null) };
        // q3's size is unknown: it reserves the storage gate's default estimate, not zero.
        Assert.Equal(5000 + Storage.StorageBudget.DefaultIncomingReserveBytes, DownloadQueue.QueuedReservedBytes(rows));
    }

    [Fact]
    public void UnknownSizeQueuedRowsReserveTheDefaultEstimate()
    {
        Assert.Equal(2L * 1024 * 1024 * 1024, Storage.StorageBudget.DefaultIncomingReserveBytes);
        var rows = new[] { Row("a", size: null), Row("b", size: 0), Row("c", "downloading", size: null) };
        Assert.Equal(2 * Storage.StorageBudget.DefaultIncomingReserveBytes, DownloadQueue.QueuedReservedBytes(rows));
    }

    [Fact]
    public void WaitingRowsMakeANewKeptAddQueueEvenWithAFreeSlot()
    {
        var rows = new[] { Row("a", "downloading"), Row("q", "queued") };
        Assert.True(DownloadQueue.ShouldQueueNewDownload(rows, 3, "user", false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 3, "user", true));
        Assert.False(DownloadQueue.ShouldQueueNewDownload(rows, 3, "stream", false));
    }

    [Theory]
    [InlineData(null, 2)]
    [InlineData("5", 5)]
    [InlineData("0", 1)]
    [InlineData("x", 2)]
    [InlineData(" 3.7 ", 3)]
    public void CapParsesLikeTheEnvVar(string? raw, int expected) => Assert.Equal(expected, DownloadQueue.ParseMaxActive(raw));
}
