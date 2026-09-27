using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Engine.Tests;

public sealed class ReleaseSwapTests
{
    private static EngineReleaseSwap Swap(int n) => new("show", "s00001e00002", EngineHarness.Hash(n),
        "Example Show S01E02 1080p", EngineHarness.Magnet(n), 1000);

    [Fact]
    public async Task SwappingQueuedReleasePreservesPositionLaneAndEveryLink()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(1) });
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(2), WorkId = "show",
            QueueKey = "s00001e00002", Lane = "request", Category = "TV" });
        var old = await h.RowAsync(2);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.GrabJobs.Add(new() { Id = "grab", UserId = LocalUser.Id, Title = "show", Query = "show S01E02", Status = "sent",
                InfoHash = old.Hash, Magnet = old.Magnet, Kind = "library", ExternalId = "watch", Retention = "keep",
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            db.WatchListItems.Add(new() { Id = "watch", UserId = LocalUser.Id, Title = "show", MediaType = "tv", ExternalId = "show",
                Status = "watching", MonitorMode = "all",
                LatestReleaseMagnet = EngineHarness.Magnet(2), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            db.AcquisitionTargets.Add(new() { Id = "target", UserId = LocalUser.Id, WorkId = "show", WorkKey = "show",
                TargetKey = "show:1:2", Scope = "episode", Season = 1, Episode = 2, InfoHash = old.Hash,
                Status = "downloading", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            db.MediaRequests.Add(new() { Id = "request", RequestedByUserId = LocalUser.Id, WorkKey = "show", Provider = "tmdb",
                MediaType = "tv", Title = "show", Scope = "series", Status = "approved", WatchListItemId = "watch",
                GrabbedHashes = $"{old.Hash},{EngineHarness.Hash(1)}", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
            await db.SaveChangesAsync();
        }
        var result = await h.Engine.SwapAsync(old.Hash, Swap(3));
        Assert.True(result.Ok, result.Message);
        var next = await h.RowAsync(3);
        Assert.Equal(old.CreatedAt, next.CreatedAt);
        Assert.Equal(old.WorkId, next.WorkId);
        Assert.Equal(old.QueueKey, next.QueueKey);
        Assert.Equal(old.Lane, next.Lane);
        Assert.Equal(old.Category, next.Category);
        Assert.Equal(old.SavePath, next.SavePath);
        Assert.Equal("queued", next.Status);
        Assert.False(h.Backend.Contains(next.Hash));
        Assert.Equal(1, (await h.Engine.GetAsync(next.Hash))!.QueuePosition);
        await using var verify = await h.Db.CreateDbContextAsync();
        Assert.Equal(next.Hash, (await verify.GrabJobs.SingleAsync()).InfoHash);
        Assert.Equal("watch", (await verify.GrabJobs.SingleAsync()).ExternalId);
        Assert.Equal(next.Magnet, (await verify.WatchListItems.SingleAsync()).LatestReleaseMagnet);
        Assert.Equal(next.Hash, (await verify.AcquisitionTargets.SingleAsync()).InfoHash);
        Assert.Equal($"{next.Hash},{EngineHarness.Hash(1)}", (await verify.MediaRequests.SingleAsync()).GrabbedHashes);
        Assert.Equal(2, await verify.ReleaseAttempts.CountAsync());
        Assert.False((await h.Engine.SwapAsync(next.Hash, Swap(2))).Ok);
    }

    [Fact]
    public async Task RemovesOnlyPartialOwnedDataAndKeepsForcedLane()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(1), Forced = true, Lane = "automation" });
        var old = await h.RowAsync(1);
        var partial = h.Backend.Live[old.Hash].Files[0].FullPath;
        File.WriteAllText(partial, "partial");
        File.WriteAllText(partial + ".part", "partial");
        var unrelated = Path.Combine(old.SavePath!, "another-episode.mkv");
        File.WriteAllText(unrelated, "do not delete");
        var completed = Path.Combine(old.SavePath!, "completed-extra.mkv");
        File.WriteAllText(completed, "complete");
        h.Backend.Update(old.Hash, s => s with { Files = s.Files.Append(new(1, "completed-extra.mkv", completed, 8, true, 1)).ToList() });
        var result = await h.Engine.SwapAsync(old.Hash, Swap(2));
        Assert.True(result.Ok, result.Message);
        Assert.False(File.Exists(partial));
        Assert.False(File.Exists(partial + ".part"));
        Assert.True(File.Exists(unrelated));
        Assert.True(File.Exists(completed));
        var next = await h.RowAsync(2);
        Assert.NotNull(next.ForcedAt);
        Assert.Equal(old.Lane, next.Lane);
        Assert.True(h.Backend.Contains(next.Hash));
    }

    [Fact]
    public async Task ConcurrentSwapAndExistingCandidateCannotDeleteAnotherDownload()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(1) });
        var results = await Task.WhenAll(h.Engine.SwapAsync(EngineHarness.Hash(1), Swap(2)),
            h.Engine.SwapAsync(EngineHarness.Hash(1), Swap(3)));
        Assert.Single(results, r => r.Ok);
        Assert.Single(await h.RowsAsync());
        Assert.Equal(0, h.Engine.HashLockCount);
    }

    [Fact]
    public async Task StorageRefusalLeavesOldTransferAndDataUntouched()
    {
        await using var h = await EngineHarness.CreateAsync();
        await h.Engine.AddAsync(new() { Purpose = "keep", Magnet = EngineHarness.Magnet(1) });
        h.Storage.FreeBytesProvider = _ => 0;
        Assert.False((await h.Engine.SwapAsync(EngineHarness.Hash(1), Swap(2))).Ok);
        Assert.Equal(EngineHarness.Hash(1), Assert.Single(await h.RowsAsync()).Hash);
        Assert.True(h.Backend.Contains(EngineHarness.Hash(1)));
        await using var db = await h.Db.CreateDbContextAsync();
        Assert.Empty(await db.ReleaseAttempts.ToListAsync());
    }

    [Fact]
    public async Task SharedRecordedFilesAreProtected()
    {
        await using var h = await EngineHarness.CreateAsync();
        var file = Path.Combine(h.Root, "shared.mkv");
        Assert.Empty(TorrentEngineService.PartialFilesToRemove([file], h.Root, [file]));
        Assert.Empty(TorrentEngineService.PartialFilesToRemove([Path.Combine(h.Root, "..", "outside")], h.Root, []));
    }

    [Fact]
    public void HealthCountsOnlyObservedStallsAndResetsOnProgress()
    {
        var tracker = new TransferHealthTracker();
        var start = DateTime.UtcNow;
        var row = new EngineTorrentInfo { Hash = "a", Name = "a", State = "stalledDL", Peers = 2, Seeders = 1 };
        Assert.Equal(0, tracker.Observe(row, start).StalledForSeconds);
        Assert.Equal(60, tracker.Observe(row, start.AddMinutes(1)).StalledForSeconds);
        Assert.Equal(0, tracker.Observe(row with { Progress = .1 }, start.AddMinutes(2)).StalledForSeconds);
        Assert.Equal(0, tracker.Observe(row with { State = "queued" }, start.AddMinutes(3)).StalledForSeconds);
    }
}
