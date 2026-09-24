using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>
/// Brings the SQLite database up to date. A database created by the old Next.js/Prisma app already has the
/// full schema, so the EF baseline migration is recorded as applied instead of re-creating tables.
/// </summary>
public sealed class DatabaseInitializer(IDbContextFactory<TorrentFlowDbContext> factory, ILogger<DatabaseInitializer> logger)
{
    public const string BaselineMigrationId = "20260924234437_PrismaBaseline";

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var conn = db.Database.GetDbConnection();
        await conn.OpenAsync(ct);
        await using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;";
            await pragma.ExecuteNonQueryAsync(ct);
        }

        if (await TableExistsAsync(conn, "_prisma_migrations", ct) && !await TableExistsAsync(conn, "__EFMigrationsHistory", ct))
        {
            logger.LogInformation("Adopting existing Prisma database; recording EF baseline {Migration}", BaselineMigrationId);
            var productVersion = typeof(DbContext).Assembly.GetName().Version?.ToString(3) ?? "10.0.0";
            await using var cmd = conn.CreateCommand();
            cmd.CommandText =
                "CREATE TABLE \"__EFMigrationsHistory\" (\"MigrationId\" TEXT NOT NULL CONSTRAINT \"PK___EFMigrationsHistory\" PRIMARY KEY, \"ProductVersion\" TEXT NOT NULL);" +
                "INSERT INTO \"__EFMigrationsHistory\" VALUES ($id, $v);";
            cmd.Parameters.Add(new SqliteParameter("$id", BaselineMigrationId));
            cmd.Parameters.Add(new SqliteParameter("$v", productVersion));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await db.Database.MigrateAsync(ct);

        if (!await db.Users.AnyAsync(u => u.Id == LocalUser.Id, ct))
        {
            var now = DateTime.UtcNow;
            db.Users.Add(new User { Id = LocalUser.Id, Name = LocalUser.Name, CreatedAt = now, UpdatedAt = now });
            await db.SaveChangesAsync(ct);
        }
    }

    private static async Task<bool> TableExistsAsync(System.Data.Common.DbConnection conn, string table, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=$n";
        var p = cmd.CreateParameter(); p.ParameterName = "$n"; p.Value = table; cmd.Parameters.Add(p);
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct)) > 0;
    }
}
