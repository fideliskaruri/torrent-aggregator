using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Media.Features.Prewarm;
using static TorrentFlow.Media.Tests.PrewarmHarness;

namespace TorrentFlow.Media.Tests;

/// <summary>Ports src/lib/prewarm/foreground.test.ts — foreground playback wins; only pre-warms/streams are ever touched.</summary>
public class PrewarmForegroundTests
{
    [Fact]
    public async Task ForegroundIsATimestampThatExpiresOnItsOwnWithAGracePeriod()
    {
        await using var h = await CreateAsync();
        Assert.False(h.Foreground.IsActive());
        Assert.Null(h.Foreground.GetSnapshot().IdleMs);

        h.Foreground.MarkActive(Hash(1));
        Assert.True(h.Foreground.IsActive());
        h.Time.Advance(TimeSpan.FromSeconds(15));
        Assert.True(h.Foreground.IsActive());
        h.Time.Advance(TimeSpan.FromSeconds(6));
        Assert.False(h.Foreground.IsActive());

        var snapshot = h.Foreground.GetSnapshot();
        Assert.False(snapshot.Active);
        Assert.Equal(21_000, snapshot.IdleMs);
        Assert.Equal(Hash(1), snapshot.Hash);
        Assert.Equal(ForegroundTracker.IdleMs, snapshot.GraceMs);
    }

    [Fact]
    public async Task AMovingNonPrewarmIsForegroundButAMovingPrewarmOrIdleTorrentIsNot()
    {
        await using var h = await CreateAsync();
        var prewarms = new HashSet<string> { Hash(2) };
        Assert.Null(h.Foreground.Observe([Info(Hash(2), 50_000)], prewarms));
        Assert.False(h.Foreground.IsActive());
        Assert.Null(h.Foreground.Observe([Info(Hash(3), 10)], prewarms));
        Assert.False(h.Foreground.IsActive());
        Assert.Equal(Hash(1), h.Foreground.Observe([Info(Hash(1), 50_000)], prewarms));
        Assert.True(h.Foreground.IsActive());
    }

    [Fact]
    public async Task ARunningPrewarmIsSuspendedWhenAStreamStartsAndAUserTorrentNeverIs()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "user", "user-download");
        await h.SeedTorrentAsync(2, "prewarm", "speculative");
        h.Engine.Live(Hash(1), dlspeed: 200_000);
        h.Engine.Live(Hash(2), dlspeed: 100_000);

        var result = await h.Foreground.SyncAsync(LocalUser.Id);
        Assert.True(result.Foreground);
        Assert.Equal([Hash(2)], result.Suspended);
        Assert.Equal([Hash(2)], h.Engine.Deselected);

        // Idempotent under repeated pings; the user torrent is never touched.
        var again = await h.Foreground.SyncAsync(LocalUser.Id);
        Assert.Empty(again.Suspended);
        Assert.Equal([Hash(2)], h.Engine.Deselected);
        Assert.Equal([Hash(2)], again.Parked);
    }

    [Fact]
    public async Task IdleClearsTheParkedMarkerWithoutTouchingTheEngine()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(2, "prewarm", "speculative");
        h.Engine.Live(Hash(2));
        await h.Foreground.SyncAsync(LocalUser.Id, foregroundOverride: true);
        var idle = await h.Foreground.SyncAsync(LocalUser.Id, foregroundOverride: false);
        Assert.False(idle.Foreground);
        Assert.Empty(idle.Parked);
        Assert.Single(h.Engine.Deselected);
    }

    [Fact]
    public async Task ATorrentTheEngineHoldsButTheDbDoesNotKnowIsLeftAlone()
    {
        await using var h = await CreateAsync();
        h.Engine.Live(Hash(7));
        var result = await h.Foreground.SyncAsync(LocalUser.Id, foregroundOverride: true);
        Assert.Empty(result.Suspended);
        Assert.Empty(h.Engine.Deselected);
    }

    [Fact]
    public async Task NoEngineAndAFailingDeselectAreSurvivable()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "a");
        await h.SeedTorrentAsync(2, "prewarm", "b");
        h.Engine.ListThrows = () => new InvalidOperationException("engine down");
        var none = await h.Foreground.SyncAsync(LocalUser.Id, foregroundOverride: true);
        Assert.Empty(none.Suspended);

        h.Engine.ListThrows = null;
        h.Engine.Live(Hash(1));
        h.Engine.Live(Hash(2));
        h.Engine.OnSelect = hash => hash == Hash(1) ? throw new InvalidOperationException("boom") : null!;
        var result = await h.Foreground.SyncAsync(LocalUser.Id, foregroundOverride: true);
        Assert.Equal([Hash(2)], result.Suspended);
    }

    [Fact]
    public async Task AStreamNobodyIsWatchingIsParkedButTheOneOnScreenIsNot()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "stream", "on-screen");
        await h.SeedTorrentAsync(2, "stream", "abandoned");
        await h.SeedTorrentAsync(3, "user", "kept");
        h.Engine.Live(Hash(1));
        h.Engine.Live(Hash(2));
        h.Engine.Live(Hash(3));
        h.Foreground.MarkActive(Hash(1));

        var result = await h.Foreground.SyncAsync(LocalUser.Id);
        Assert.Equal([Hash(2)], result.Suspended);

        // Closing the player parks the stream that was on screen at once.
        h.Foreground.Release(Hash(1));
        var closed = await h.Foreground.SyncAsync(LocalUser.Id);
        Assert.Equal([Hash(1)], closed.Suspended);
        Assert.DoesNotContain(Hash(3), h.Engine.Deselected);
    }

    [Fact]
    public async Task ForegroundCancellationFiresWhenPlaybackStarts()
    {
        await using var h = await CreateAsync();
        using var signal = h.Foreground.CancellationSignal();
        Assert.False(signal.IsCancellationRequested);
        h.Foreground.MarkActive(Hash(1));
        Assert.True(signal.IsCancellationRequested);
    }

    [Fact]
    public async Task AProgressPingSuspendsARunningPrewarm()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(2, "prewarm", "speculative");
        h.Engine.Live(Hash(2));
        var outcome = await h.Prewarm.OnPlaybackProgressAsync(new PrewarmService.PlaybackContext
        {
            UserId = LocalUser.Id, InfoHash = Hash(1), Title = "Show S01E01", PositionSec = 1, DurationSec = 1000,
        }, new PrewarmService.RunOptions { UserId = LocalUser.Id, Next = null!, ForegroundActive = true });
        Assert.Equal("below-trigger", outcome.Reason);
        Assert.Equal([Hash(2)], h.Engine.Deselected);
    }

    private static EngineTorrentInfo Info(string hash, long dlspeed) => new() { Hash = hash, Name = hash, State = "downloading", Dlspeed = dlspeed };
}
