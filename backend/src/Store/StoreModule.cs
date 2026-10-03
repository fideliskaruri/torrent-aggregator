using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using System.Text.Json;
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
        services.AddDbContext<TorrentFlowDbContext>(options => options.UseSqlite(connection)
            .AddInterceptors(new SqlitePragmas()));
        services.AddScoped(sp => new StoreDatabase(sp.GetRequiredService<TorrentFlowDbContext>()));
        services.AddKeyedScoped<IStore, MetadataStoreCapability>("metadata");
        services.AddKeyedScoped<IStore, FindStoreCapability>("find");
        services.AddKeyedScoped<IStore, TargetsStoreCapability>("targets");
        services.AddKeyedScoped<IStore, AccessStoreCapability>("access");
        services.AddSingleton<ITargetEvents, TargetEvents>();
        services.AddScoped<NotificationRepository>(sp => new NotificationRepository(sp.GetRequiredService<TorrentFlowDbContext>()));
        services.AddSingleton<ICheckRepository, CheckRepository>();
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
        var settings = db.Set<Dictionary<string, object>>("Setting");
        foreach (var row in SettingsCatalog.Defaults(tmdb, schedulerDisabled))
        {
            if (!await settings.AnyAsync(s => EF.Property<string>(s, "section") == row.Id, ct))
                settings.Add(Schema.Table(typeof(SettingRow)).ToEntity(row));
        }
        await db.SaveChangesAsync(ct);
        if (tmdb is not null)
        {
            var entity = await settings.SingleAsync(s => EF.Property<string>(s, "section") == "metadata", ct);
            var row = (SettingRow)Schema.Table("Setting").ToRow(entity);
            var value = SettingsCatalog.Read<MetadataSettings>(row);
            if (value.TmdbCredential != tmdb)
            {
                var updated = row with { Value = JsonSerializer.SerializeToElement(value with { TmdbCredential = tmdb }, Schema.Json),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                db.Entry(entity).CurrentValues.SetValues(Schema.Table("Setting").ToEntity(updated));
                await db.SaveChangesAsync(ct);
            }
        }
        if (schedulerDisabled)
        {
            var entity = await settings.SingleAsync(s => EF.Property<string>(s, "section") == "scheduler", ct);
            var row = (SettingRow)Schema.Table("Setting").ToRow(entity);
            var value = SettingsCatalog.Read<SchedulerSettings>(row);
            if (value.Enabled)
            {
                var updated = row with { Value = JsonSerializer.SerializeToElement(value with { Enabled = false }, Schema.Json),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                db.Entry(entity).CurrentValues.SetValues(Schema.Table("Setting").ToEntity(updated));
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
            foreach (var table in Schema.Tables)
                _ = await db.Set<Dictionary<string, object>>(table.Name).AnyAsync(ct);
            var rows = await db.Set<Dictionary<string, object>>("Setting").AsNoTracking().ToListAsync(ct);
            var required = SettingsCatalog.Defaults(null, false).Select(s => s.Id).ToHashSet();
            var actual = rows.Select(r => ((SettingRow)Schema.Table("Setting").ToRow(r)).Id).ToHashSet();
            if (!actual.SetEquals(required)) return false;
            foreach (var row in rows) SettingsCatalog.Validate((SettingRow)Schema.Table("Setting").ToRow(row));
            return true;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is SqliteException or InvalidOperationException or JsonException or ArgumentException)
        {
            return false;
        }
    }
}
