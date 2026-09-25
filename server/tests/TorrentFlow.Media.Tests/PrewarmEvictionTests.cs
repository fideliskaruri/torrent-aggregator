using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;
using static TorrentFlow.Media.Tests.PrewarmHarness;

namespace TorrentFlow.Media.Tests;

/// <summary>Ports src/lib/prewarm/eviction.test.ts — origin=user rows are never deleted. Every assertion re-reads the DB.</summary>
public class PrewarmEvictionTests
{
    [Fact]
    public void OnDiskBytesCountsOnlyWhatIsOnDiskAndClampsNonsense()
    {
        Assert.Equal(500, PrewarmEviction.OnDiskBytes(1000, 0.5));
        Assert.Equal(1000, PrewarmEviction.OnDiskBytes(1000, 1));
        Assert.Equal(0, PrewarmEviction.OnDiskBytes(1000, 0));
        Assert.Equal(1000, PrewarmEviction.OnDiskBytes(1000, 5));
        Assert.Equal(0, PrewarmEviction.OnDiskBytes(1000, -1));
        Assert.Equal(0, PrewarmEviction.OnDiskBytes(-5, 0.5));
        Assert.Equal(0, PrewarmEviction.OnDiskBytes(1000, double.NaN));
    }

    [Fact]
    public async Task ExtremePressureNeverEvictsAUserTorrent()
    {
        await using var h = await CreateAsync();
        var old = h.Time.GetUtcNow().UtcDateTime.AddDays(-30);
        await h.SeedTorrentAsync(1, "user", "user-ancient", lastUsedAt: old.AddDays(-100));
        await h.SeedTorrentAsync(2, "user", "user-old", lastUsedAt: old.AddDays(-50));
        await h.SeedTorrentAsync(3, "prewarm", "pw-a", lastUsedAt: old);
        await h.SeedTorrentAsync(4, "prewarm", "pw-b", lastUsedAt: old.AddDays(1));
        List<string> deleted = [];

        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, long.MaxValue / 2, seams: new PrewarmEviction.Seams
        {
            Delete = async hash => { deleted.Add(hash); return await h.Engine.RemoveAsync(hash, true); },
        });

        Assert.DoesNotContain(Hash(1), deleted);
        Assert.DoesNotContain(Hash(2), deleted);
        Assert.All(result.Evicted, c => Assert.Equal("prewarm", c.Origin));
        Assert.False(result.Satisfied);
        Assert.Equal(2000, result.FreedBytes);
        var rows = await h.RowsAsync();
        Assert.Equal(["user-ancient", "user-old"], rows.Select(r => r.Name).Order());
    }

    [Fact]
    public async Task EvictionStopsAtTheBudgetLeastRecentlyUsedFirst()
    {
        await using var h = await CreateAsync();
        var t0 = h.Time.GetUtcNow().UtcDateTime;
        await h.SeedTorrentAsync(1, "prewarm", "newest", lastUsedAt: t0);
        await h.SeedTorrentAsync(2, "prewarm", "oldest", lastUsedAt: t0.AddHours(-3));
        await h.SeedTorrentAsync(3, "prewarm", "middle", lastUsedAt: t0.AddHours(-2));

        var listed = await h.Eviction.ListEvictableAsync(LocalUser.Id);
        Assert.Equal(["oldest", "middle", "newest"], listed.Candidates.Select(c => c.Name));

        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 1000, seams: new() { Delete = hash => h.Engine.RemoveAsync(hash, true) });
        Assert.True(result.Satisfied);
        Assert.Equal(["oldest"], result.Evicted.Select(c => c.Name));
        Assert.Equal(2, (await h.RowsAsync()).Count);
    }

    [Fact]
    public async Task WatchedAndProtectedPrewarmsAreNotEvictable()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "watched");
        await h.SeedTorrentAsync(2, "prewarm", "on-screen");
        await h.SeedTorrentAsync(3, "prewarm", "free");
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.PlaybackProgresses.Add(new PlaybackProgress
            {
                Id = Ids.New(), UserId = LocalUser.Id, InfoHash = Hash(1), FilePath = "a.mkv", Title = "watched",
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var listed = await h.Eviction.ListEvictableAsync(LocalUser.Id, [Hash(2)]);
        Assert.Equal(["free"], listed.Candidates.Select(c => c.Name));
        Assert.Contains(listed.Skipped, s => s.Hash == Hash(1) && s.Reason == "watched");
        Assert.Contains(listed.Skipped, s => s.Hash == Hash(2) && s.Reason == "protected");

        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, long.MaxValue / 2, [Hash(2)], new() { Delete = hash => h.Engine.RemoveAsync(hash, true) });
        Assert.Equal([Hash(3)], result.Evicted.Select(c => c.Hash));
        Assert.Equal(2, (await h.RowsAsync()).Count);
    }

    [Fact]
    public async Task ARowHoldingNothingIsNotEvictedAndZeroBytesDeletesNothing()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "empty", progress: 0);
        var none = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 0);
        Assert.Empty(none.Evicted);
        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 500, seams: new() { Delete = hash => h.Engine.RemoveAsync(hash, true) });
        Assert.Empty(result.Evicted);
        Assert.Contains(result.Skipped, s => s.Hash == Hash(1) && s.Reason == "frees-nothing");
        Assert.Single(await h.RowsAsync());
    }

    [Fact]
    public async Task WhenTheClientRefusesTheRowStaysAndNothingIsClaimedFreed()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "stubborn");
        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 500, seams: new() { Delete = _ => Task.FromResult(new EngineActionResult(false, "nope")) });
        Assert.Empty(result.Evicted);
        Assert.Equal(0, result.FreedBytes);
        Assert.Contains(result.Skipped, s => s.Reason == "client-refused: nope");
        var row = Assert.Single(await h.RowsAsync());
        Assert.Equal("prewarm", row.Origin);
        Assert.Null(row.EvictLease);
    }

    [Fact]
    public async Task ADownloadPromotingMidEvictionKeepsItsFiles()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "promoted");
        List<string> deleted = [];
        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 500, seams: new()
        {
            Delete = hash => { deleted.Add(hash); return Task.FromResult(new EngineActionResult(true, "ok")); },
            BeforeClaim = async c =>
            {
                await using var db = await h.Db.CreateDbContextAsync();
                await db.EngineTorrents.Where(t => t.Hash == c.Hash).ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, "user"));
            },
        });
        Assert.Empty(deleted);
        Assert.Empty(result.Evicted);
        Assert.Equal("user", Assert.Single(await h.RowsAsync()).Origin);
    }

    [Fact]
    public async Task ADownloadStealingTheLeaseMidEvictionKeepsItsFiles()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "prewarm", "stolen");
        List<string> deleted = [];
        var result = await h.Eviction.EvictForBytesAsync(LocalUser.Id, 500, seams: new()
        {
            Delete = hash => { deleted.Add(hash); return Task.FromResult(new EngineActionResult(true, "ok")); },
            AfterClaim = async c =>
            {
                await using var db = await h.Db.CreateDbContextAsync();
                await db.EngineTorrents.Where(t => t.Hash == c.Hash)
                    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Origin, "user").SetProperty(t => t.EvictLease, (string?)null).SetProperty(t => t.EvictFrom, (string?)null));
            },
        });
        Assert.Empty(deleted);
        Assert.Empty(result.Evicted);
        Assert.Contains(result.Skipped, s => s.Reason == "lease-stolen");
        Assert.Equal("user", Assert.Single(await h.RowsAsync()).Origin);
    }

    [Fact]
    public async Task StaleLeasesRecoverToPrewarmButFreshOnesAreLeftClaimed()
    {
        await using var h = await CreateAsync();
        var stale = await h.SeedTorrentAsync(1, "evicting", "stale");
        var fresh = await h.SeedTorrentAsync(2, "evicting", "fresh");
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var now = h.Time.GetUtcNow();
            await db.EngineTorrents.Where(t => t.Id == stale.Id).ExecuteUpdateAsync(s => s
                .SetProperty(t => t.EvictLease, PrewarmEviction.NewEvictLease(now - TimeSpan.FromMinutes(11))).SetProperty(t => t.EvictFrom, "prewarm"));
            await db.EngineTorrents.Where(t => t.Id == fresh.Id).ExecuteUpdateAsync(s => s
                .SetProperty(t => t.EvictLease, PrewarmEviction.NewEvictLease(now - TimeSpan.FromMinutes(1))).SetProperty(t => t.EvictFrom, "prewarm"));
        }
        var recovered = await h.Eviction.RecoverStaleLeasesAsync(LocalUser.Id);
        Assert.Equal([(Hash(1), "prewarm")], recovered);
        var rows = (await h.RowsAsync()).ToDictionary(r => r.Name);
        Assert.Equal("prewarm", rows["stale"].Origin);
        Assert.Null(rows["stale"].EvictLease);
        Assert.Equal("evicting", rows["fresh"].Origin);
    }

    [Fact]
    public async Task MarkUsedMovesARowToTheBackAndIsQuietForUnknownHashes()
    {
        await using var h = await CreateAsync();
        var t0 = h.Time.GetUtcNow().UtcDateTime;
        await h.SeedTorrentAsync(1, "prewarm", "first", lastUsedAt: t0.AddHours(-2));
        await h.SeedTorrentAsync(2, "prewarm", "second", lastUsedAt: t0.AddHours(-1));
        Assert.True(await h.Eviction.MarkUsedAsync(LocalUser.Id, Hash(1)));
        var after = await h.Eviction.ListEvictableAsync(LocalUser.Id);
        Assert.Equal(["second", "first"], after.Candidates.Select(c => c.Name));
        Assert.False(await h.Eviction.MarkUsedAsync(LocalUser.Id, Hash(99)));
    }
}
