using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Tests;

// StorageEstimate + StorageBudget refusal arithmetic.

public sealed class StorageBudgetTests
{
    private static readonly long Gb = 1_000_000_000;

    [Fact]
    public void FromReleaseUsesChosenSizeOnly()
    {
        Assert.Equal(1_200_000_000, StorageEstimate.FromRelease(1_200_000_000));
        Assert.Equal(StorageEstimate.DefaultIncomingReserveBytes, StorageEstimate.FromRelease(null));
        Assert.Equal(StorageEstimate.DefaultIncomingReserveBytes, StorageEstimate.FromRelease(0));
        Assert.False(StorageEstimate.IsEstimated(1_200_000_000));
        Assert.True(StorageEstimate.IsEstimated(null));
    }

    [Fact]
    public void CapMessageSeparatesThisDownloadFromQueuedReservations()
    {
        // Social Network regression: 1.2 GB chosen release + ~44.6 GB already queued must not read as "needs 45.8 GB".
        var thisDownload = (long)(1.2 * Gb);
        var queued = (long)(44.6 * Gb);
        var message = StorageEstimate.CapMessage((long)(255.3 * Gb), 300 * Gb, thisDownload, estimated: false, queued);

        Assert.Contains("This download: 1.2 GB", message);
        Assert.Contains("Already queued: 44.6 GB", message);
        Assert.DoesNotContain("needs about 45.8", message);
        Assert.DoesNotContain("—", message);
    }

    [Fact]
    public void CheckReportsIncomingAndReservedSeparately()
    {
        var dir = Directory.CreateTempSubdirectory("tf-storage-est");
        try
        {
            var budget = new StorageBudget(TimeProvider.System) { FreeBytesProvider = _ => 500 * Gb };
            // 1 + 9.5 claimed against a 10 GB cap with nothing on disk yet.
            var check = budget.Check(dir.FullName, maxStorageBytes: 10 * Gb, incomingBytes: 1 * Gb, reservedQueuedBytes: (long)(9.5 * Gb));

            Assert.False(check.Ok);
            Assert.Equal("cap", check.Limit);
            Assert.Equal(1 * Gb, check.IncomingBytes);
            Assert.Equal((long)(9.5 * Gb), check.ReservedQueuedBytes);
            Assert.False(check.IncomingEstimated);
            Assert.Contains("This download: 1.0 GB", check.Message);
            Assert.Contains("Already queued: 9.5 GB", check.Message);
        }
        finally
        {
            try { dir.Delete(recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public void SmallChosenReleaseWithLargeQueueIsStillOverridableCap()
    {
        var dir = Directory.CreateTempSubdirectory("tf-storage-est-small");
        try
        {
            var budget = new StorageBudget(TimeProvider.System) { FreeBytesProvider = _ => 500 * Gb };
            // 255.3 used of 300, 1.2 this + 44.6 queued => over cap, but figures stay honest.
            // Seed the folder so DirectorySize reports ~255.3 GB without writing that much.
            // DirectorySize measures real files; for the unit test override by writing nothing and
            // checking the arithmetic path with used=0 and a tiny cap instead.
            var check = budget.Check(dir.FullName, maxStorageBytes: 5 * Gb, incomingBytes: (long)(1.2 * Gb), reservedQueuedBytes: (long)(4.5 * Gb));
            Assert.False(check.Ok);
            Assert.Equal("cap", check.Limit);
            Assert.True(check.Overridable);
            Assert.Equal((long)(1.2 * Gb), check.IncomingBytes);
            Assert.Equal((long)(4.5 * Gb), check.ReservedQueuedBytes);
            Assert.Contains("This download: 1.2 GB", check.Message!);
            Assert.Contains("Already queued: 4.5 GB", check.Message!);
        }
        finally
        {
            try { dir.Delete(recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public async Task EngineAddRefusalMessageUsesChosenReleaseSize()
    {
        const long gb = 1_000_000_000;
        // One active slot so the second add queues; tiny cap so 1.2 GB + 4 GB queue exceeds it.
        await using var h = await EngineHarness.CreateAsync(cap: 1, maxStorageBytes: 5 * gb);
        Assert.True((await h.Engine.AddAsync(Keep(1, size: 3 * gb))).Ok);
        Assert.True((await h.Engine.AddAsync(Keep(2, size: 4 * gb))).Ok); // queued 4 GB
        Assert.Equal(4 * gb, await h.Engine.QueuedReservedBytesAsync());

        var refused = await h.Engine.AddAsync(Keep(3, size: (long)(1.2 * gb)));
        Assert.False(refused.Ok);
        Assert.Equal("cap", refused.StorageLimit);
        Assert.Contains("This download: 1.2 GB", refused.Message);
        Assert.Contains("Already queued: 4.0 GB", refused.Message);
        Assert.DoesNotContain("needs about 5.2", refused.Message);
    }

    private static EngineAddRequest Keep(int n, long? size = null) => new()
    {
        Magnet = EngineHarness.Magnet(n),
        Name = $"Release {n}",
        Purpose = TorrentPurpose.Keep,
        ExpectedSizeBytes = size,
    };
}
