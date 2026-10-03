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

    public async Task SubscribeAsync(PushSubscriptionRow row, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "PushSubscription" ("id","userId","endpoint","p256dh","auth","createdAt")
            VALUES ({row.Id},{row.UserId},{row.Endpoint},{row.P256dh},{row.Auth},{row.CreatedAt.ToString("O")})
            ON CONFLICT("endpoint") DO UPDATE SET "userId"=excluded."userId",
                "p256dh"=excluded."p256dh", "auth"=excluded."auth";
            """, ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM "PushSubscription" WHERE "id" IN (
                SELECT "id" FROM "PushSubscription" WHERE "userId"={row.UserId}
                ORDER BY "createdAt" DESC, "id" DESC LIMIT -1 OFFSET 10);
            """, ct);
        await transaction.CommitAsync(ct);
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

    public async Task CompletePushAsync(string id, bool pending, CancellationToken ct) =>
        await db.Set<Dictionary<string, object>>("Notification")
            .Where(x => EF.Property<string>(x, "id") == id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => EF.Property<bool>(x, "pushPending"), pending)
                .SetProperty(x => EF.Property<string>(x, "pushAttemptAt"), DateTimeOffset.UtcNow.ToString("O"))
                .SetProperty(x => EF.Property<int>(x, "pushAttempts"), x => EF.Property<int>(x, "pushAttempts") + 1), ct);
}
