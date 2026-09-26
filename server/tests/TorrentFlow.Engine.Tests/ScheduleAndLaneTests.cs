using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Queue;

namespace TorrentFlow.Engine.Tests;

/// <summary>Download hours, window speed caps and priority lanes: the pure rules and the engine over a fake client.</summary>
public class ScheduleAndLaneTests
{
    // 2024-01-01 was a Monday.
    private static DateTimeOffset Monday(int hour, int minute = 0) => new(2024, 1, 1, hour, minute, 0, TimeSpan.Zero);
    private const int Mon = 1, Tue = 2;

    private static EngineAddRequest Keep(int n, int? ep = null, string? lane = null, bool forced = false, string work = "show") => new()
    {
        Magnet = EngineHarness.Magnet(n),
        Purpose = TorrentPurpose.Keep,
        WorkId = work,
        QueueKey = ep is { } e ? DownloadQueue.QueueKeyForEpisode(1, e) : null,
        Lane = lane,
        Forced = forced,
    };

    private static DownloadWindow Window(int start, int end, int? cap = null, long? down = null, long? up = null, params int[] days) =>
        new(days.Length == 0 ? [Mon] : days, start, end, cap, down, up);

    // ------------------------------------------------------------ pure rules

    [Fact]
    public void SameDayWindowCoversOnlyItsHoursAndDays()
    {
        var w = Window(9, 17);
        Assert.True(DownloadWindows.Covers(w, Monday(9)));
        Assert.True(DownloadWindows.Covers(w, Monday(16, 59)));
        Assert.False(DownloadWindows.Covers(w, Monday(17)));
        Assert.False(DownloadWindows.Covers(w, Monday(8, 59)));
        Assert.False(DownloadWindows.Covers(w, Monday(10).AddDays(1)));
    }

    [Fact]
    public void OvernightWindowRunsIntoTheNextMorningOfItsStartDay()
    {
        var w = Window(22, 6);
        Assert.True(DownloadWindows.Covers(w, Monday(22)));
        Assert.True(DownloadWindows.Covers(w, Monday(23, 59)));
        Assert.True(DownloadWindows.Covers(w, Monday(5, 59).AddDays(1)));
        Assert.False(DownloadWindows.Covers(w, Monday(6).AddDays(1)));
        // Monday morning belongs to a Sunday-night window, which this is not.
        Assert.False(DownloadWindows.Covers(w, Monday(3)));
        Assert.False(DownloadWindows.Covers(w, Monday(21)));
    }

    [Fact]
    public void NoWindowsIsUnrestrictedAndTheFirstMatchingRuleWins()
    {
        Assert.Equal(ScheduleState.Unrestricted, DownloadWindows.Evaluate([], Monday(3)));
        var first = Window(0, 24, cap: 4);
        var second = Window(8, 20, cap: 1);
        var state = DownloadWindows.Evaluate([first, second], Monday(10));
        Assert.True(state is { Configured: true, Open: true });
        Assert.Same(first, state.Active);
        Assert.False(DownloadWindows.Evaluate([second], Monday(21)).Open);
    }

    [Theory]
    [InlineData(new int[0], 1, 2, "at least one day")]
    [InlineData(new[] { 7 }, 1, 2, "0 (Sunday) to 6")]
    [InlineData(new[] { 1 }, 24, 2, "startHour must be 0 to 23")]
    [InlineData(new[] { 1 }, 1, 0, "endHour must be 1 to 24")]
    [InlineData(new[] { 1 }, 5, 5, "must differ")]
    public void InvalidWindowsAreRejected(int[] days, int start, int end, string error) =>
        Assert.Contains(error, DownloadWindows.Validate(new DownloadWindow(days, start, end)));

    [Fact]
    public void StoredWindowsRoundTripAndGarbageIsIgnored()
    {
        var saved = DownloadWindows.Serialize([Window(22, 6, cap: 3, down: 2_000_000, days: [Tue, Mon, Mon])]);
        var parsed = Assert.Single(DownloadWindows.Parse(saved));
        Assert.Equal([Mon, Tue], parsed.Days);
        Assert.Equal((22, 6, 3, 2_000_000L), (parsed.StartHour, parsed.EndHour, parsed.MaxActiveDownloads!.Value, parsed.MaxDownloadRate!.Value));
        Assert.Null(parsed.MaxUploadRate);
        Assert.Empty(DownloadWindows.Parse("not json"));
        Assert.Empty(DownloadWindows.Parse("""[{"days":[9],"startHour":1,"endHour":2}]"""));
        Assert.Single(DownloadWindows.Parse("""[null,{"days":[1],"startHour":1,"endHour":2}]"""));
        Assert.Null(DownloadWindows.Serialize([]));
    }

    [Fact]
    public void LaneIsTheFirstSortKeyAndExplainsTheWait()
    {
        var t0 = DateTime.UtcNow;
        QueueRow Row(string hash, int lane, int ep, string status = "queued", string work = "a") =>
            new(hash, status, "user", t0.AddSeconds(ep), work, DownloadQueue.QueueKeyForEpisode(1, ep), Lane: lane);
        // Automation enqueued first, then the owner's pick of another work, then a request.
        var rows = new[] { Row("auto1", 2, 1), Row("auto2", 2, 2), Row("own", 0, 9, work: "b"), Row("req", 1, 5, work: "c"), Row("live", 2, 0, "downloading") };
        Assert.Equal(["own", "req", "auto1", "auto2"], DownloadQueue.Order(rows).Select(r => r.Hash));
        Assert.Equal(["own"], DownloadQueue.PromotionCandidates(rows, cap: 2));
        Assert.Equal(QueueWaitReason.QueueFull, DownloadQueue.WaitReason(rows[2], rows, windowOpen: true));
        Assert.Equal(QueueWaitReason.LowerLane, DownloadQueue.WaitReason(rows[3], rows, windowOpen: true));
        Assert.Equal(QueueWaitReason.LowerLane, DownloadQueue.WaitReason(rows[0], rows, windowOpen: true));
        Assert.Equal(QueueWaitReason.OutsideWindow, DownloadQueue.WaitReason(rows[2], rows, windowOpen: false));
        Assert.Null(DownloadQueue.WaitReason(rows[4], rows, windowOpen: true));
    }

    [Fact]
    public void ClosedWindowHoldsNewStartsButNotForcedOnes()
    {
        var t0 = DateTime.UtcNow;
        var rows = new List<QueueRow> { new("q", "queued", "user", t0), new("d", "downloading", "user", t0), new("f", "downloading", "user", t0, ForcedAt: t0) };
        Assert.Empty(DownloadQueue.PromotionCandidates(rows, cap: 5, windowOpen: false));
        Assert.True(DownloadQueue.ShouldQueueNewDownload([], cap: 5, "user", forced: false, windowOpen: false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload([], cap: 5, "user", forced: true, windowOpen: false));
        Assert.False(DownloadQueue.ShouldQueueNewDownload([], cap: 5, "stream", forced: false, windowOpen: false));
        var plan = DownloadQueue.PlanRehydrate(rows, cap: 5, windowOpen: false);
        Assert.Equal(["f"], plan.Active);
        Assert.Equal(["q", "d"], plan.Demote.Order().Reverse());
    }

    [Theory]
    [InlineData(0L, null, 0)]
    [InlineData(0L, 2_000_000L, 2_000_000)]
    [InlineData(65_536L, null, 65_536)]
    [InlineData(65_536L, 1_000_000L, 65_536)]
    [InlineData(1_000_000L, 65_536L, 65_536)]
    public void TheStricterOfTheBaseAndWindowRateWins(long baseRate, long? window, int expected) =>
        Assert.Equal(expected, MonoTorrentBackend.EffectiveRate(baseRate, window));

    // ------------------------------------------------------------ engine

    private static async Task<(EngineHarness H, ManualClock Clock)> CreateAsync(int cap, DateTimeOffset now, params DownloadWindow[] windows)
    {
        var clock = new ManualClock(now);
        var h = await EngineHarness.CreateAsync(cap: cap, time: clock);
        // Attach first, as startup does, so loading the (empty) saved settings cannot overwrite the test's schedule.
        await h.Engine.AttachLimitsAsync();
        h.Limits.SetWindows(windows);
        return (h, clock);
    }

    [Fact]
    public async Task InsideAWindowItsOwnDownloadsAtOnceApplies()
    {
        var (h, _) = await CreateAsync(1, Monday(10), Window(9, 17, cap: 3));
        await using var _h = h;
        for (var i = 1; i <= 4; i++) await h.Engine.AddAsync(Keep(i, ep: i));
        Assert.Equal(3, h.Backend.Live.Count);
        Assert.Equal("queued", (await h.RowAsync(4)).Status);
        Assert.Equal(QueueWaitReason.QueueFull, (await h.Engine.GetAsync(EngineHarness.Hash(4)))!.WaitReason);
    }

    [Fact]
    public async Task OutsideEveryWindowNewAddsWaitRunningOnesContinueAndTheOpeningTickStartsThem()
    {
        var (h, clock) = await CreateAsync(2, Monday(10), Window(9, 17));
        await using var _h = h;
        await h.Engine.AddAsync(Keep(1, ep: 1));
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));

        clock.Now = Monday(18);
        var queued = await h.Engine.AddAsync(Keep(2, ep: 2));
        Assert.Equal(EngineAddDetails.Queued, queued.Details!.Action);
        await h.Engine.TickAsync();
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));
        Assert.Equal("downloading", (await h.RowAsync(1)).Status);
        Assert.Equal("queued", (await h.RowAsync(2)).Status);
        var info = (await h.Engine.ListAsync()).Single(t => t.Hash == EngineHarness.Hash(2));
        Assert.Equal(QueueWaitReason.OutsideWindow, info.WaitReason);
        Assert.Equal(TorrentLane.Owner, info.Lane);

        clock.Now = Monday(9).AddDays(7);
        await h.Engine.TickAsync();
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(2)));
    }

    [Fact]
    public async Task ForceAndResumeStillStartOutsideTheWindow()
    {
        var (h, _) = await CreateAsync(2, Monday(20), Window(9, 17));
        await using var _h = h;
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        Assert.Empty(h.Backend.Live);

        Assert.True((await h.Engine.ForceAsync(EngineHarness.Hash(1))).Ok);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));
        Assert.True((await h.Engine.PauseAsync(EngineHarness.Hash(1))).Ok);
        Assert.Equal("Resumed", (await h.Engine.ResumeAsync(EngineHarness.Hash(1))).Message);
        Assert.Equal("downloading", (await h.RowAsync(1)).Status);
        Assert.Equal("started", (await h.Engine.AddAsync(Keep(3, forced: true))).Details!.Action);
        Assert.Equal("queued", (await h.RowAsync(2)).Status);
    }

    [Fact]
    public async Task RestartOutsideTheWindowStartsOnlyForcedRows()
    {
        var (h, _) = await CreateAsync(3, Monday(20), Window(9, 17));
        await using var _h = h;
        await h.SeedAsync(1, "downloading", ep: 1);
        await h.SeedAsync(2, "downloading", ep: 2);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var row = db.EngineTorrents.Single(r => r.Hash == EngineHarness.Hash(2));
            row.ForcedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        await h.Engine.RehydrateAsync();
        Assert.Equal([EngineHarness.Hash(2)], h.Backend.AddLog);
        Assert.Equal("queued", (await h.RowAsync(1)).Status);
    }

    [Fact]
    public async Task WindowSpeedCapsApplyWhileOpenAndTheBaseReturnsAfter()
    {
        var (h, clock) = await CreateAsync(2, Monday(10), Window(9, 17, down: 2_000_000, up: 500_000));
        await using var _h = h;
        await h.Engine.TickAsync();
        await h.Engine.TickAsync();
        Assert.Equal([(2_000_000L, 500_000L)], h.Backend.RateLog.Select(r => (r.Down!.Value, r.Up!.Value)));
        clock.Now = Monday(17);
        await h.Engine.TickAsync();
        Assert.Equal((null, null), h.Backend.RateLog[^1]);
        Assert.Equal(2, h.Backend.RateLog.Count);
    }

    [Theory]
    [InlineData(null, 0)]
    [InlineData("owner", 0)]
    [InlineData("Request", 1)]
    [InlineData("automation", 2)]
    [InlineData("typo", 2)]
    public void UnknownLanesSortLastInsteadOfJumpingTheQueue(string? lane, int rank) =>
        Assert.Equal(rank, TorrentLane.Rank(lane));

    [Fact]
    public async Task SavedHoursAreLoadedAtStartupAndTheOpeningTickStartsAnIdleQueue()
    {
        var clock = new ManualClock(Monday(20));
        await using var h = await EngineHarness.CreateAsync(cap: 2, time: clock);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            (await db.ClientSettings.SingleAsync()).DownloadWindows = DownloadWindows.Serialize([Window(22, 6)]);
            await db.SaveChangesAsync();
        }
        await h.Engine.AttachLimitsAsync();
        Assert.Single(h.Limits.Windows);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        Assert.Empty(h.Backend.Live);
        Assert.Equal(QueueWaitReason.OutsideWindow, (await h.Engine.GetAsync(EngineHarness.Hash(1)))!.WaitReason);
        await h.Engine.TickAsync();
        Assert.Empty(h.Backend.Live);

        clock.Now = Monday(23);
        await h.Engine.TickAsync();
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));
    }

    [Fact]
    public async Task ARefusedRateChangeIsLoggedAndRetriedOnTheNextTick()
    {
        var (h, _) = await CreateAsync(2, Monday(10));
        await using var _h = h;
        h.Backend.FailRates = true;
        h.Limits.SetWindows([Window(9, 17, down: 2_000_000)]);
        await h.Engine.TickAsync();
        Assert.DoesNotContain(h.Backend.RateLog, r => r.Down is not null);
        Assert.Equal("started", (await h.Engine.AddAsync(Keep(1))).Details!.Action);
        h.Backend.FailRates = false;
        await h.Engine.TickAsync();
        Assert.Equal((2_000_000L, (long?)null), h.Backend.RateLog[^1]);
    }

    [Fact]
    public async Task WithoutWindowsNothingIsThrottledOrHeld()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1, time: new ManualClock(Monday(3)));
        await h.Engine.TickAsync();
        Assert.Equal([(null, null)], h.Backend.RateLog);
        Assert.Equal("started", (await h.Engine.AddAsync(Keep(1))).Details!.Action);
        Assert.Equal(QueueWaitReason.QueueFull, (await h.Engine.GetAsync((await h.Engine.AddAsync(Keep(2))).Hash!))!.WaitReason);
    }

    [Fact]
    public async Task OwnerPicksJumpAheadOfQueuedAutomationAndReaddsOnlyRaiseTheLane()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1, lane: TorrentLane.Automation));
        await h.Engine.AddAsync(Keep(2, ep: 2, lane: TorrentLane.Automation));
        await h.Engine.AddAsync(Keep(3, ep: 3, lane: TorrentLane.Automation));
        await h.Engine.AddAsync(Keep(9, lane: TorrentLane.Owner, work: "other"));
        Assert.Equal(2, (await h.RowAsync(2)).Lane);
        Assert.Equal(0, (await h.RowAsync(9)).Lane);

        var list = await h.Engine.ListAsync();
        Assert.Equal(1, list.Single(t => t.Hash == EngineHarness.Hash(9)).QueuePosition);
        Assert.Equal(QueueWaitReason.QueueFull, list.Single(t => t.Hash == EngineHarness.Hash(9)).WaitReason);
        Assert.Equal(QueueWaitReason.LowerLane, list.Single(t => t.Hash == EngineHarness.Hash(2)).WaitReason);
        Assert.Equal(TorrentLane.Automation, list.Single(t => t.Hash == EngineHarness.Hash(2)).Lane);

        // The owner asks for episode 3 too: it moves to the owner's lane. Automation asking again never lowers it.
        await h.Engine.AddAsync(Keep(3, ep: 3, lane: TorrentLane.Owner));
        await h.Engine.AddAsync(Keep(3, ep: 3, lane: TorrentLane.Automation));
        Assert.Equal(0, (await h.RowAsync(3)).Lane);

        await h.Engine.PauseAsync(EngineHarness.Hash(1));
        Assert.Equal("downloading", (await h.RowAsync(3)).Status);
        Assert.Equal("queued", (await h.RowAsync(2)).Status);
    }
}
