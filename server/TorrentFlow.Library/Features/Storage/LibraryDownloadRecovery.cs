using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Features.Storage;

internal sealed class LibraryDownloadRecovery(IDbContextFactory<TorrentFlowDbContext> factory) : ILibraryDownloadRecovery
{
    public async Task RegisterAsync(IReadOnlyCollection<string> hashes, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rows = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id && hashes.Contains(r.Hash) && r.Status != "removed").ToListAsync(ct);
        var watchlist = await db.WatchListItems.Where(w => w.UserId == LocalUser.Id).ToListAsync(ct);
        foreach (var row in rows)
        {
            var identity = ReleaseNames.IdentityFor(row.Name);
            var key = ReleaseNames.WorkKeyFor(identity.Name, identity.Year);
            if (key.Length == 0) key = "local-" + row.Hash;
            var now = DateTime.UtcNow;
            var work = await db.Works.FirstOrDefaultAsync(w => w.WorkKey == key, ct);
            if (work is null)
            {
                work = new Work { Id = Ids.New(), WorkKey = key, CanonicalTitle = identity.Name,
                    MediaType = identity.IsSeries ? "tv" : "movie", Year = identity.Year, CreatedAt = now, UpdatedAt = now };
                db.Works.Add(work);
            }
            row.WorkId = work.Id;
            var item = watchlist.FirstOrDefault(w => w.WorkId == work.Id
                || w.MediaType == work.MediaType && w.ExternalId == "local:" + key);
            if (item is null)
            {
                item = new WatchListItem
                {
                    Id = Ids.New(), UserId = LocalUser.Id, WorkId = work.Id, ExternalId = "local:" + key,
                    Title = identity.Name, MediaType = work.MediaType, Status = "planned", Monitored = false,
                    MonitorMode = "ongoing", LastChecked = now, CreatedAt = now, UpdatedAt = now,
                };
                db.WatchListItems.Add(item);
                watchlist.Add(item);
            }
            await db.SaveChangesAsync(ct);
        }
    }
}
