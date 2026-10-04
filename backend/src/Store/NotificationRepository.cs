using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public sealed class NotificationRepository
{
    private readonly TorrentFlowDbContext db;
    internal NotificationRepository(TorrentFlowDbContext db) => this.db = db;

    public async Task<T[]> AllAsync<T>(CancellationToken ct) where T : StoreRow
    {
        var table = Schema.Table(typeof(T));
        return (await db.Set<Dictionary<string, object>>(table.Name).AsNoTracking().ToListAsync(ct))
            .Select(x => (T)table.ToRow(x)).ToArray();
    }

    public async Task<bool> PublishAsync(NotificationRow row, CancellationToken ct)
    {
        var set = db.Set<Dictionary<string, object>>("Notification");
        var existing = await set.SingleOrDefaultAsync(x => EF.Property<string>(x, "userId") == row.UserId &&
            EF.Property<string>(x, "dedupeKey") == row.DedupeKey, ct);
        if (existing is not null)
        {
            existing["title"] = row.Title;
            existing["body"] = row.Body!;
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
            return false;
        }
        set.Add(Schema.Table("Notification").ToEntity(row));
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
        return true;
    }

    public async Task DeleteAsync(StoreRow row, CancellationToken ct)
    {
        var table = Schema.Table(row.GetType());
        await db.Set<Dictionary<string, object>>(table.Name)
            .Where(x => EF.Property<string>(x, table.Key) == row.Id).ExecuteDeleteAsync(ct);
    }

    public async Task<int> ReadAsync(string user, string? id, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        return await db.Set<Dictionary<string, object>>("Notification")
            .Where(x => EF.Property<string>(x, "userId") == user &&
                (id == null || EF.Property<string>(x, "id") == id))
            .ExecuteUpdateAsync(s => s.SetProperty(x => EF.Property<string>(x, "readAt"),
                x => EF.Property<string>(x, "readAt") ?? now), ct);
    }

    public async Task<int> UnreadAsync(string user, string id, CancellationToken ct) =>
        await db.Set<Dictionary<string, object>>("Notification")
            .Where(x => EF.Property<string>(x, "userId") == user && EF.Property<string>(x, "id") == id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => EF.Property<string>(x, "readAt"), (string)null!), ct);

}
