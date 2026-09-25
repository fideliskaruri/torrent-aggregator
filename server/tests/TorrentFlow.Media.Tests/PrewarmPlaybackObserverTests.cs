using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;

namespace TorrentFlow.Media.Tests;

/// <summary>Library progress pings reach prewarm through <see cref="ILibraryPlaybackObserver"/> (TS progress route → onPlaybackProgress).</summary>
public sealed class PrewarmPlaybackObserverTests
{
    [Fact]
    public async Task ProgressUpdateReachesPrewarmAndMarksTheWatchedTorrentUsed()
    {
        using var factory = new PrewarmApiFactory();
        var observer = factory.Services.GetRequiredService<ILibraryPlaybackObserver>();
        Assert.IsType<PrewarmPlaybackObserver>(observer);

        var hash = new string('b', 40);
        var stale = DateTime.UtcNow.AddDays(-3);
        await using (var db = await factory.Db.CreateDbContextAsync())
        {
            db.EngineTorrents.Add(new EngineTorrent
            {
                Id = "watched", UserId = LocalUser.Id, Hash = hash, Name = "Example Show S01E01 1080p", Status = "seeding", Origin = "user",
                Progress = 1, CreatedAt = stale, UpdatedAt = stale, LastUsedAt = stale,
            });
            await db.SaveChangesAsync();
        }

        // Below the 15% trigger: prewarm only records the use, it never searches or adds.
        await observer.OnProgressAsync(new(LocalUser.Id, hash, "Example Show", 1, 1, null, 60, 1400), CancellationToken.None);

        await using var check = await factory.Db.CreateDbContextAsync();
        var row = await check.EngineTorrents.SingleAsync(x => x.Hash == hash);
        Assert.True(row.LastUsedAt > stale.AddDays(1));
        Assert.Empty(factory.Search.Calls);
    }
}
