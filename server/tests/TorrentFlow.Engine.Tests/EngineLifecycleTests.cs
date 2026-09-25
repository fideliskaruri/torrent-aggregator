using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Queue;

namespace TorrentFlow.Engine.Tests;

/// <summary>Regression tests for lifecycle races, cancellation, queue fairness, streams and rehydrate.</summary>
public class EngineLifecycleTests
{
    private static EngineAddRequest Keep(int n, int? ep = null, string work = "show") => new()
    {
        Magnet = EngineHarness.Magnet(n),
        Purpose = TorrentPurpose.Keep,
        WorkId = work,
        QueueKey = ep is { } e ? DownloadQueue.QueueKeyForEpisode(1, e) : null,
    };

    private static string H(int n) => EngineHarness.Hash(n);

    /// <summary>Holds the backend add of one hash until released, and reports when it got there.</summary>
    private sealed class StartGate
    {
        public readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Func<BackendAddSpec, Task> For(string hash) => async spec =>
        {
            if (spec.Hash != hash) return;
            Entered.TrySetResult();
            await Release.Task;
        };
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(10);
        Assert.True(condition());
    }

    // ---- 1: cancellation after persist

    [Fact]
    public async Task CancelledRequestAfterPersistStillMarksErrorAndPromotes()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.SeedAsync(2, "queued", ep: 2);
        using var cts = new CancellationTokenSource();
        // The client disconnects while the start is in flight, and the start then fails.
        h.Backend.BeforeAdd = spec => { if (spec.Hash == H(1)) cts.Cancel(); return Task.CompletedTask; };
        h.Backend.AddOverride = spec => spec.Hash == H(1) ? new BackendAddOutcome(false, "boom") : null;

        var r = await h.Engine.AddAsync(Keep(1, ep: 1), cts.Token);

        Assert.False(r.Ok);
        Assert.Equal("error", (await h.RowAsync(1)).Status);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(H(2)));
    }

    [Fact]
    public async Task TickRestartsARowMarkedDownloadingButNotLoaded()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.SeedAsync(1, "downloading", ep: 1);
        await h.Engine.TickAsync();
        Assert.True(h.Backend.Contains(H(1)));
        Assert.Equal("downloading", (await h.RowAsync(1)).Status);
    }

    [Fact]
    public async Task TickSurvivesARowDeletedMidPass()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        h.Backend.Update(H(1), s => s with { Progress = 0.5 });
        h.Backend.Update(H(2), s => s with { Progress = 0.5 });
        var deleted = false;
        h.Backend.OnGet = hash =>
        {
            if (hash != H(1) || deleted) return;
            deleted = true;
            using var db = h.Db.CreateDbContext();
            db.EngineTorrents.Where(r => r.Hash == H(1)).ExecuteDelete();
        };

        await h.Engine.TickAsync();

        Assert.True(deleted);
        Assert.Equal(0.5, (await h.RowAsync(2)).Progress);
    }

    [Fact]
    public async Task RehydrateContinuesPastAStartThatThrows()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.SeedAsync(1, "downloading", ep: 1);
        await h.SeedAsync(2, "downloading", ep: 2);
        h.Backend.AddOverride = spec => spec.Hash == H(1) ? throw new TaskCanceledException("internal timeout") : null;

        await h.Engine.RehydrateAsync();

        Assert.Equal("error", (await h.RowAsync(1)).Status);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(H(2)));
    }

    // ---- 2: delayed starts vs pause/delete

    [Fact]
    public async Task PauseDuringADelayedStartIsNotUndoneByTheStart()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        var gate = new StartGate();
        h.Backend.BeforeAdd = gate.For(H(1));
        var add = h.Engine.AddAsync(Keep(1, ep: 1));
        await gate.Entered.Task;
        var pause = h.Engine.PauseAsync(H(1));
        gate.Release.SetResult();
        await Task.WhenAll(add, pause);

        Assert.Equal("paused", (await h.RowAsync(1)).Status);
        Assert.Equal("paused", h.Backend.Get(H(1))?.State ?? "paused");
    }

    [Fact]
    public async Task DeleteDuringADelayedStartIsNotResurrected()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        var gate = new StartGate();
        h.Backend.BeforeAdd = gate.For(H(1));
        var add = h.Engine.AddAsync(Keep(1, ep: 1));
        await gate.Entered.Task;
        var remove = h.Engine.RemoveAsync(H(1), deleteFiles: false);
        gate.Release.SetResult();
        await Task.WhenAll(add, remove);

        Assert.Empty(await h.RowsAsync());
        Assert.False(h.Backend.Contains(H(1)));
    }

    [Fact]
    public async Task PauseDuringADelayedPromotionIsNotUndone()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        var gate = new StartGate();
        h.Backend.BeforeAdd = gate.For(H(2));
        var remove = h.Engine.RemoveAsync(H(1), deleteFiles: false);   // frees the slot: E2 is promoted
        await gate.Entered.Task;
        var pause = h.Engine.PauseAsync(H(2));
        gate.Release.SetResult();
        await Task.WhenAll(remove, pause);

        Assert.Equal("paused", (await h.RowAsync(2)).Status);
        Assert.Equal("paused", h.Backend.Get(H(2))?.State ?? "paused");
    }

    // ---- 3: queue fairness

    [Fact]
    public async Task NewAddJoinsTheLineWhenRowsAreWaitingEvenWithAFreeSlot()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.SeedAsync(2, "queued", ep: 2);   // waiting although a slot is free (e.g. a promotion that has not run yet)

        var r = await h.Engine.AddAsync(Keep(5, ep: 5));

        Assert.Equal("queued", r.Details!.Action);
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Contains(H(2)));
        Assert.False(h.Backend.Contains(H(5)));
    }

    [Fact]
    public async Task QueueHeadTakesTheFreeSlotWhenItIsTheNewArrival()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.SeedAsync(5, "queued", ep: 5);

        var r = await h.Engine.AddAsync(Keep(2, ep: 2));

        Assert.Equal("started", r.Details!.Action);
        Assert.Equal("queued", (await h.RowAsync(5)).Status);
    }

    [Fact]
    public async Task ResumeDoesNotJumpAheadOfWaitingRows()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(5, ep: 5));
        await h.Engine.PauseAsync(H(5));
        await h.SeedAsync(4, "queued", ep: 4);

        var r = await h.Engine.ResumeAsync(H(5));

        Assert.StartsWith("Queued", r.Message);
        Assert.Equal("downloading", (await h.RowAsync(4)).Status);
        Assert.Equal("queued", (await h.RowAsync(5)).Status);
        Assert.False(h.Backend.Contains(H(5)));
    }

    [Fact]
    public async Task EpisodeOrderSendsStartTheFirstEpisodes()
    {
        // grab.ts sends a season's releases in episode order, so arrival order is queueKey order.
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        for (var ep = 1; ep <= 5; ep++) await h.Engine.AddAsync(Keep(ep, ep: ep));
        Assert.Equal([H(1), H(2)], h.Backend.Live.Keys.Order());
    }

    [Fact]
    public async Task OutOfOrderArrivalsPromoteTheLowestWaitingEpisodeNext()
    {
        // Arrivals that beat the queue (3 and 1 found a free slot) keep their slots; everything after waits in
        // episode order, so the next slot goes to E2, not to the next arrival.
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        foreach (var ep in new[] { 3, 1, 5, 2, 4 }) await h.Engine.AddAsync(Keep(ep, ep: ep));
        h.Backend.Complete(H(3));
        await h.Engine.TickAsync();
        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.Equal([H(1), H(2)], h.Backend.Live.Keys.Order());
    }

    // ---- 4: purposes

    [Fact]
    public async Task PlayingAQueuedKeptDownloadKeepsEveryFileSelected()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        await using var s = await h.Engine.OpenFileStreamAsync(H(2), "0");
        Assert.True(h.Backend.Get(H(2))!.Files.All(f => f.Selected));
    }

    [Fact]
    public async Task PromotingAKeptRowLoadedAsAStreamReselectsItsFiles()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(Keep(1, ep: 1));
        await h.Engine.AddAsync(Keep(2, ep: 2));
        await h.Backend.AddAsync(new BackendAddSpec(H(2), EngineHarness.Magnet(2), null, h.Root, TorrentPurpose.Stream, null), default);
        Assert.False(h.Backend.Get(H(2))!.Files.All(f => f.Selected));

        await h.Engine.RemoveAsync(H(1), deleteFiles: false);

        Assert.Equal("downloading", (await h.RowAsync(2)).Status);
        Assert.True(h.Backend.Get(H(2))!.Files.All(f => f.Selected));
    }

    [Fact]
    public async Task ResumingAKeptRowLoadedAsAStreamReselectsItsFiles()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.SeedAsync(1, "paused", ep: 1);
        await h.Backend.AddAsync(new BackendAddSpec(H(1), EngineHarness.Magnet(1), null, h.Root, TorrentPurpose.Stream, null), default);

        Assert.True((await h.Engine.ResumeAsync(H(1))).Ok);

        Assert.True(h.Backend.Get(H(1))!.Files.All(f => f.Selected));
    }

    // ---- 5: completion under an open stream

    [Fact]
    public async Task CompletionDefersDetachUntilTheLastStreamCloses()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(Keep(1));
        var first = await h.Engine.OpenFileStreamAsync(H(1), "0");
        var second = await h.Engine.OpenFileStreamAsync(H(1), "0");
        h.Backend.Complete(H(1));

        await h.Engine.TickAsync();

        var row = await h.RowAsync(1);
        Assert.Equal("parked", row.Status);
        Assert.NotNull(row.VerifiedAt);
        // Library/Metadata readiness (TitleService, persistedTorrentIsDownloaded) requires the verified bitfield.
        Assert.Equal("/w==", row.VerifiedBitfield);
        Assert.True(h.Backend.Contains(H(1)));

        await first.DisposeAsync();
        await h.Engine.TickAsync();
        Assert.True(h.Backend.Contains(H(1)));

        await second.DisposeAsync();
        await WaitUntil(() => !h.Backend.Contains(H(1)));
        Assert.Equal(0, h.Engine.OpenStreamCount(H(1)));
    }

    // ---- 7: metadata deadline after rehydrate

    [Fact]
    public async Task RehydratedMagnetGetsAFreshMetadataDeadline()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.SeedAsync(1, "downloading", ep: 1, updatedAt: DateTime.UtcNow.AddHours(-1));
        h.Backend.AddOverride = spec =>
        {
            h.Backend.Live[spec.Hash] = new BackendSnapshot(spec.Hash, spec.Hash, 0, 0, 0, 0, 0, "metaDL", false, spec.SavePath, [], null);
            return new BackendAddOutcome(true, "");
        };

        await h.Engine.RehydrateAsync();
        await h.Engine.TickAsync();

        Assert.Equal("downloading", (await h.RowAsync(1)).Status);
        Assert.True(h.Backend.Contains(H(1)));
    }
}
