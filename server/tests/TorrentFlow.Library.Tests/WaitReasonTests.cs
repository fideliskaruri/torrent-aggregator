using TorrentFlow.Core.Scheduling;

namespace TorrentFlow.Library.Tests;

public sealed class WaitReasonTests
{
    private static readonly DateTime Now = new(2026, 9, 26, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ClosedWindowWinsOverLaneAndReturnsOpening()
    {
        var opening = Now.AddHours(3);
        var wait = WaitReasonService.Evaluate(new()
        {
            Queued = true, WindowOpen = false, NextWindowStart = opening, Lane = 2, BestQueuedLane = 0
        }, Now);
        Assert.Equal(WaitReasonKind.OutsideWindow, wait.Reason);
        Assert.Equal(opening, wait.Until);
        Assert.Contains("download hours", wait.Text);
    }

    [Fact]
    public void QueueFullExplainsConfiguredMaximum()
    {
        var wait = WaitReasonService.Evaluate(new() { Queued = true, MaxActive = 3 }, Now);
        Assert.Equal(WaitReasonKind.QueueFull, wait.Reason);
        Assert.Contains("maximum 3 active", wait.Text);
        Assert.Null(wait.Until);
    }

    [Theory]
    [InlineData(1, 0, WaitReasonKind.LowerLane)]
    [InlineData(2, 1, WaitReasonKind.LowerLane)]
    [InlineData(0, 0, WaitReasonKind.QueueFull)]
    public void QueueLanePrecedence(int lane, int best, WaitReasonKind expected) =>
        Assert.Equal(expected, WaitReasonService.Evaluate(new() { Queued = true, Lane = lane, BestQueuedLane = best }, Now).Reason);

    [Fact]
    public void SeederWaitIncludesStartAndTimeout()
    {
        var since = Now.AddHours(-1);
        var wait = WaitReasonService.Evaluate(new()
        {
            SeederWaitSince = since, MinimumSeeders = 3, SeederWaitTimeoutMinutes = 360, NextCheckAt = Now.AddMinutes(15)
        }, Now);
        Assert.Equal(WaitReasonKind.WaitingForSeeders, wait.Reason);
        Assert.Equal(since, wait.Since);
        Assert.Equal(since.AddHours(6), wait.Until);
    }

    [Theory]
    [InlineData(3, 360)]
    [InlineData(0, 1)]
    public void ExpiredOrDisabledSeederWaitDoesNotBlock(int minimum, int elapsed) =>
        Assert.Equal(WaitReasonKind.None, WaitReasonService.Evaluate(new()
        {
            SeederWaitSince = Now.AddMinutes(-elapsed), MinimumSeeders = minimum, SeederWaitTimeoutMinutes = 360
        }, Now).Reason);

    [Fact]
    public void AirDateWinsOverSeedersAndNextCheck()
    {
        var air = Now.AddDays(2);
        var wait = WaitReasonService.Evaluate(new()
        {
            AirDate = air, NextCheckAt = Now.AddHours(1), SeederWaitSince = Now, MinimumSeeders = 3, SeederWaitTimeoutMinutes = 360
        }, Now);
        Assert.Equal(WaitReasonKind.NotAiredYet, wait.Reason);
        Assert.Equal(air, wait.Until);
    }

    [Fact]
    public void FutureCheckReportsTimeAndDueCheckIsReady()
    {
        var at = Now.AddMinutes(15);
        var context = new WaitContext { NextCheckAt = at };
        var wait = WaitReasonService.Evaluate(context, Now);
        Assert.Equal(WaitReasonKind.NextCheckScheduled, wait.Reason);
        Assert.Equal(at, wait.Until);
        Assert.Equal(WaitReasonKind.None, WaitReasonService.Evaluate(context, at).Reason);
        Assert.Equal(WaitReasonKind.None, WaitReasonService.Evaluate(new() { AirDate = Now }, Now).Reason);
    }
}
