using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public static class StoreModule
{
    public static IServiceCollection AddStore(this IServiceCollection services, string databasePath)
    {
        var connection = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath, ForeignKeys = true, DefaultTimeout = 5, Pooling = true,
        }.ToString();
        services.AddDbContextFactory<TorrentFlowDbContext>(options => options.UseSqlite(connection)
            .AddInterceptors(new SqlitePragmas()));
        services.AddScoped(sp => new StoreDatabase(sp.GetRequiredService<TorrentFlowDbContext>()));
        services.AddScoped(sp => new TargetStore(sp.GetRequiredService<TorrentFlowDbContext>(),
            sp.GetRequiredService<ITargetEvents>()));
        services.AddSingleton<ITargetEvents, TargetEvents>();
        services.AddScoped<NotificationRepository>(sp => new NotificationRepository(sp.GetRequiredService<TorrentFlowDbContext>()));
        services.AddScoped<ILibraryRepository>(sp => new LibraryRepository(sp.GetRequiredService<TorrentFlowDbContext>()));
        services.AddScoped<ImportReviewRepository>(sp => new ImportReviewRepository(sp.GetRequiredService<TorrentFlowDbContext>()));
        return services;
    }
}

internal sealed class SqlitePragmas : DbConnectionInterceptor
{
    public override void ConnectionOpened(System.Data.Common.DbConnection connection, ConnectionEndEventData eventData)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
        command.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(System.Data.Common.DbConnection connection,
        ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}

public sealed class StoreDatabase
{
    private readonly TorrentFlowDbContext db;
    internal StoreDatabase(TorrentFlowDbContext db) => this.db = db;

    public async Task InitializeAsync(SecretReference? tmdb, bool schedulerDisabled, CancellationToken ct = default)
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;", ct);
        await db.Database.MigrateAsync(ct);
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS ImportReview(
                id TEXT PRIMARY KEY, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)));
            CREATE TABLE IF NOT EXISTS ImportDecision(
                reviewId TEXT NOT NULL REFERENCES ImportReview(id),
                itemId TEXT NOT NULL, decision TEXT NOT NULL, decidedAt TEXT NOT NULL,
                PRIMARY KEY(reviewId,itemId));
            """, ct);
        var settings = db.Settings;
        foreach (var row in SettingsCatalog.Defaults(tmdb, schedulerDisabled))
        {
            if (!await settings.AnyAsync(s => s.Id == row.Id, ct))
                settings.Add(row);
        }
        await db.SaveChangesAsync(ct);
        if (tmdb is not null)
        {
            var row = await settings.SingleAsync(s => s.Id == "metadata", ct);
            var value = SettingsCatalog.Read<MetadataSettings>(row);
            if (value.TmdbCredential != tmdb)
            {
                var updated = row with { Value = System.Text.Json.JsonSerializer.SerializeToElement(value with { TmdbCredential = tmdb }, StoreJson.Options),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                db.Entry(row).CurrentValues.SetValues(updated);
                await db.SaveChangesAsync(ct);
            }
        }
        if (schedulerDisabled)
        {
            var row = await settings.SingleAsync(s => s.Id == "scheduler", ct);
            var value = SettingsCatalog.Read<SchedulerSettings>(row);
            if (value.Enabled)
            {
                var updated = row with { Value = System.Text.Json.JsonSerializer.SerializeToElement(value with { Enabled = false }, StoreJson.Options),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                db.Entry(row).CurrentValues.SetValues(updated);
                await db.SaveChangesAsync(ct);
            }
        }
        db.ChangeTracker.Clear();
        await db.Database.CloseConnectionAsync();
    }

    public async Task<bool> IsReadyAsync(CancellationToken ct = default)
    {
        try
        {
            if ((await db.Database.GetPendingMigrationsAsync(ct)).Any()) return false;
            var existingTables = await db.Database.SqlQueryRaw<string>(
                "SELECT name AS Value FROM sqlite_master WHERE type='table'").ToListAsync(ct);
            var requiredTables = db.Model.GetEntityTypes()
                .Where(entity => !entity.ClrType.IsAbstract && typeof(StoreRow).IsAssignableFrom(entity.ClrType))
                .Select(entity => entity.GetTableName()).Where(name => name is not null).ToHashSet();
            if (!requiredTables.IsSubsetOf(existingTables)) return false;
            var rows = await db.Settings.AsNoTracking().ToListAsync(ct);
            var required = SettingsCatalog.Defaults(null, false).Select(s => s.Id).ToHashSet();
            var actual = rows.Select(r => r.Id).ToHashSet();
            if (!actual.SetEquals(required)) return false;
            foreach (var row in rows) SettingsCatalog.Validate(row);
            return true;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is SqliteException or InvalidOperationException or System.Text.Json.JsonException or ArgumentException)
        {
            return false;
        }
    }
}
