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
