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
/// Before any migration touches an existing database it is copied to <c>backups/</c> next to it (the newest
/// <see cref="BackupsKept"/> are kept), and the row count of every table is logged before and after.
/// </summary>
public sealed class DatabaseInitializer(IDbContextFactory<TorrentFlowDbContext> factory, ILogger<DatabaseInitializer> logger)
{
    public const string BaselineMigrationId = "20260924234437_PrismaBaseline";
    public const int BackupsKept = 5;

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

        var adoptPrisma = await TableExistsAsync(conn, "_prisma_migrations", ct) && !await TableExistsAsync(conn, "__EFMigrationsHistory", ct);
        var pending = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();
        // Empty for a new database (nothing to back up) and when nothing is pending (nothing will change).
        var before = adoptPrisma || pending.Count > 0 ? await RowCountsAsync(conn, ct) : new SortedDictionary<string, long>();
        if (before.Count > 0)
        {
            var backup = await BackupAsync(conn, pending.LastOrDefault() ?? BaselineMigrationId, ct);
            logger.LogInformation("Updating the database ({Count} migrations pending: {Migrations}). Backed it up first to {Backup}. Rows before: {Rows}",
                pending.Count, string.Join(", ", pending), backup ?? "(not a file, no backup)", Describe(before));
        }

        if (adoptPrisma)
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

        if (before.Count > 0)
        {
            var after = await RowCountsAsync(conn, ct);
            var changes = before.Keys.Union(after.Keys).Order(StringComparer.Ordinal)
                .Where(t => !before.TryGetValue(t, out var b) || !after.TryGetValue(t, out var a) || a != b)
                .Select(t => $"{t} {(before.TryGetValue(t, out var b) ? b.ToString(System.Globalization.CultureInfo.InvariantCulture) : "new")}"
                    + $" -> {(after.TryGetValue(t, out var a) ? a.ToString(System.Globalization.CultureInfo.InvariantCulture) : "dropped")}")
                .ToList();
            logger.LogInformation("Database updated. Row changes: {Changes}", changes.Count == 0 ? "none" : string.Join(", ", changes));
            if (pending.Any(m => m.EndsWith("_" + nameof(Migrations.AddReleaseBlocks), StringComparison.Ordinal)))
                await LogReleaseBlockBackfillAsync(conn, ct);
        }

        if (!await db.Users.AnyAsync(u => u.Id == LocalUser.Id, ct))
        {
            var now = DateTime.UtcNow;
            db.Users.Add(new User { Id = LocalUser.Id, Name = LocalUser.Name, CreatedAt = now, UpdatedAt = now });
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>
    /// A consistent copy (WAL included) of the database file in <c>backups/</c> beside it, named after the newest pending
    /// migration. Null for a database that is not a file. Updating without a backup is refused: the error says why.
    /// </summary>
    private async Task<string?> BackupAsync(System.Data.Common.DbConnection conn, string migration, CancellationToken ct)
    {
        var source = (conn as SqliteConnection)?.DataSource;
        if (string.IsNullOrEmpty(source) || source == ":memory:" || !File.Exists(source)) return null;
        var full = Path.GetFullPath(source);
        var dir = Path.Combine(Path.GetDirectoryName(full)!, "backups");
        var prefix = Path.GetFileNameWithoutExtension(full) + "-before-";
        var target = Path.Combine(dir, $"{prefix}{migration}-{DateTime.UtcNow:yyyyMMdd-HHmmss}.db");
        try
        {
            Directory.CreateDirectory(dir);
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "VACUUM INTO $target;";
            cmd.Parameters.Add(new SqliteParameter("$target", target));
            await cmd.ExecuteNonQueryAsync(ct);
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                $"TorrentFlow needs to update its database and backs it up first, but the backup to {target} failed ({ex.Message}). " +
                "Make room on that drive or fix its permissions, then start TorrentFlow again. The database was not changed.", ex);
        }

        foreach (var old in new DirectoryInfo(dir).GetFiles(prefix + "*.db").OrderByDescending(f => f.LastWriteTimeUtc).Skip(BackupsKept))
        {
            try { old.Delete(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { logger.LogWarning(ex, "Could not remove old database backup {Path}", old.FullName); }
        }
        return target;
    }

    /// <summary>Once, after <see cref="Migrations.AddReleaseBlocks"/> ran: what its back-fill blocked and what it left alone.</summary>
    private async Task LogReleaseBlockBackfillAsync(System.Data.Common.DbConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            WITH {Migrations.AddReleaseBlocks.SwapsCte},
            "Classified" AS ({Migrations.AddReleaseBlocks.ClassifiedAttemptsSelect})
            SELECT (SELECT count(*) FROM "ReleaseBlock" WHERE "Origin" = 'migrated'),
                count(CASE WHEN "Class" = 'replaced' THEN 1 END),
                count(CASE WHEN "Class" = 'owner-selected' THEN 1 END),
                count(CASE WHEN "Class" = 'ambiguous' THEN 1 END)
            FROM "Classified"
            """;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return;
        logger.LogInformation("Release blocks: {Blocks} migrated as replaced (from {Replaced} replaced attempt rows). {OwnerPicked} owner-picked and {Other} other attempts left unblocked.",
            reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2), reader.GetInt64(3));
    }

    private static async Task<SortedDictionary<string, long>> RowCountsAsync(System.Data.Common.DbConnection conn, CancellationToken ct)
    {
        var tables = new List<string>();
        await using (var list = conn.CreateCommand())
        {
            list.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
            await using var reader = await list.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) tables.Add(reader.GetString(0));
        }
        var counts = new SortedDictionary<string, long>(StringComparer.Ordinal);
        foreach (var table in tables)
        {
            await using var count = conn.CreateCommand();
            count.CommandText = $"SELECT count(*) FROM \"{table.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
            counts[table] = Convert.ToInt64(await count.ExecuteScalarAsync(ct), System.Globalization.CultureInfo.InvariantCulture);
        }
        return counts;
    }

    private static string Describe(SortedDictionary<string, long> counts) =>
        string.Join(", ", counts.Select(c => $"{c.Key} {c.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)}"));

    private static async Task<bool> TableExistsAsync(System.Data.Common.DbConnection conn, string table, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=$n";
        var p = cmd.CreateParameter(); p.ParameterName = "$n"; p.Value = table; cmd.Parameters.Add(p);
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct), System.Globalization.CultureInfo.InvariantCulture) > 0;
    }
}
