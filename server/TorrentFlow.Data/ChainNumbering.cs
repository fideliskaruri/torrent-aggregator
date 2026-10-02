using System.Data;
using System.Data.Common;
using System.Globalization;
using Microsoft.EntityFrameworkCore;

namespace TorrentFlow.Data;

/// <summary>
/// When this database began numbering anime seasons along the AniList sequel chain: the first start that ran
/// <see cref="Migrations.AddWorkNumbering"/>. Rows written before it carry the old numbering (a sequel entry's own Season 1,
/// the show listing's seasons on a first season's page) and are translated once; rows written since already number the
/// show's seasons. Kept in the SQLite header's <c>user_version</c>, which nothing else in TorrentFlow uses, as whole seconds
/// since 2020-01-01 UTC, so it travels with the database file and its backups, and a database restored from before the
/// chain numbering takes a new moment on its next start.
/// </summary>
public static class ChainNumbering
{
    private static readonly DateTime Epoch = new(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>The moment, or null when the database has none (one no start of TorrentFlow initialized).</summary>
    public static async Task<DateTime?> SinceAsync(TorrentFlowDbContext db, CancellationToken ct)
    {
        var conn = db.Database.GetDbConnection();
        var opened = conn.State != ConnectionState.Open;
        if (opened) await db.Database.OpenConnectionAsync(ct);
        try { return await ReadAsync(conn, ct); }
        finally { if (opened) await db.Database.CloseConnectionAsync(); }
    }

    /// <summary>Records <paramref name="now"/> (to the second, rounded down) when the database has no moment yet.</summary>
    /// <returns>The moment, and whether this call recorded it.</returns>
    internal static async Task<(DateTime Since, bool Recorded)> EnsureAsync(DbConnection conn, DateTime now, CancellationToken ct)
    {
        if (await ReadAsync(conn, ct) is { } since) return (since, false);
        var seconds = (int)Math.Floor((now.ToUniversalTime() - Epoch).TotalSeconds);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"PRAGMA user_version = {seconds.ToString(CultureInfo.InvariantCulture)};";
        await cmd.ExecuteNonQueryAsync(ct);
        return (Epoch.AddSeconds(seconds), true);
    }

    private static async Task<DateTime?> ReadAsync(DbConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA user_version;";
        var seconds = Convert.ToInt64(await cmd.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
        return seconds > 0 ? Epoch.AddSeconds(seconds) : null;
    }
}
