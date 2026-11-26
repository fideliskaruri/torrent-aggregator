using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class NotificationRepository
{
    private readonly TorrentFlowDbContext db;
    internal NotificationRepository(TorrentFlowDbContext db) => this.db = db;

    public async Task<T[]> AllAsync<T>(CancellationToken ct) where T : StoreRow
    {
        return await db.Set<T>().AsNoTracking().ToArrayAsync(ct);
    }

    public Task<int> CountUnreadAsync(string user, CancellationToken ct) =>
        db.Notifications.AsNoTracking().CountAsync(n => n.UserId == user && n.ReadAt == null, ct);

    public Task<NotificationRow[]> PageAsync(string user, int limit, CancellationToken ct) =>
        db.Notifications.AsNoTracking().Where(n => n.UserId == user)
            .OrderByDescending(n => n.CreatedAt).ThenByDescending(n => n.Id).Take(limit).ToArrayAsync(ct);

    public async Task<Dictionary<string, string?>> PostersAsync(string[] keys, string[] hashes, CancellationToken ct)
    {
        hashes = hashes.Select(h => h.ToLowerInvariant()).Distinct().ToArray();
        var result = (await db.Works.AsNoTracking().Where(w => keys.Contains(w.WorkKey))
            .Select(w => new { w.WorkKey, w.PosterUrl }).ToArrayAsync(ct)).ToDictionary(w => w.WorkKey, w => w.PosterUrl);
        if (hashes.Length > 0)
        {
            var rows = await (from download in db.Downloads.AsNoTracking()
                join link in db.DownloadTargets.AsNoTracking() on download.Id equals link.DownloadId
                join target in db.Targets.AsNoTracking() on link.TargetId equals target.Id
                join work in db.Works.AsNoTracking() on target.WorkId equals work.Id
                where hashes.Contains(download.Hash) && target.State != TargetState.Removed
                select new { download.Hash, target.Id, target.ChosenReleaseHash, work.PosterUrl }).ToArrayAsync(ct);
            foreach (var group in rows.GroupBy(r => r.Hash))
            {
                var chosen = group.Where(r => r.ChosenReleaseHash == r.Hash).ToArray();
                result.TryAdd("hash:" + group.Key, (chosen.Length > 0 ? chosen : group.ToArray())
                    .OrderBy(r => r.Id, StringComparer.Ordinal).First().PosterUrl);
            }
            // Unassociated/raw library copies can still have a catalog identity.
            var rawPosters = await (from download in db.Downloads.AsNoTracking()
                join file in db.MediaFiles.AsNoTracking() on download.Id equals file.DownloadId
                join work in db.Works.AsNoTracking() on file.WorkId equals work.Id
                where hashes.Contains(download.Hash) && file.Role == FileRole.Video
                orderby file.Id
                select new { download.Hash, work.PosterUrl }).ToArrayAsync(ct);
            foreach (var row in rawPosters) result.TryAdd("hash:" + row.Hash, row.PosterUrl);
        }
        return result;
    }

    public async Task<bool> PublishAsync(NotificationRow row, CancellationToken ct)
    {
        var existing = await db.Notifications.SingleOrDefaultAsync(x =>
            x.UserId == row.UserId && x.DedupeKey == row.DedupeKey, ct);
        if (existing is not null)
        {
            db.Entry(existing).CurrentValues.SetValues(existing with { Title = row.Title, Body = row.Body });
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
            return false;
        }
        db.Notifications.Add(row);
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
        return true;
    }

    public async Task DeleteAsync(StoreRow row, CancellationToken ct)
    {
        if (row is not NotificationRow notification)
            throw new ArgumentException("NotificationRepository only deletes notifications.", nameof(row));
        await db.Notifications.Where(value => value.Id == notification.Id).ExecuteDeleteAsync(ct);
    }

    public async Task<int> ReadAsync(string user, string? id, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return await db.Notifications
            .Where(x => x.UserId == user && (id == null || x.Id == id))
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ReadAt, x => x.ReadAt ?? now), ct);
    }

    public async Task<int> UnreadAsync(string user, string id, CancellationToken ct) =>
        await db.Notifications
            .Where(x => x.UserId == user && x.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ReadAt, (DateTimeOffset?)null), ct);

}
