using Microsoft.Data.Sqlite;
using TorrentFlow.Engine;

namespace TorrentFlow.Api;

// Reads the transfers the pre-rebuild TorrentFlow had, from the backups HostPaths set aside.
internal static class OldAppDownloads
{
    public static IReadOnlyList<OldAppTorrent> Read(IConfiguration configuration)
    {
        var data = configuration["TorrentFlow:DataDirectory"];
        if (string.IsNullOrWhiteSpace(data) || !Directory.Exists(data)) return [];
        var rows = new List<OldAppTorrent>();
        // Newest backup first so a later copy of the same torrent wins.
        foreach (var backup in Directory.EnumerateDirectories(data, "old-app-backup-*").OrderDescending())
        {
            var database = Path.Combine(backup, "torrentflow.db");
            if (!File.Exists(database)) continue;
            try { ReadBackup(database, Path.Combine(backup, "engine"), rows); }
            catch (SqliteException) { }
        }
        return [.. rows.DistinctBy(r => r.Hash, StringComparer.OrdinalIgnoreCase)];
    }

    private static void ReadBackup(string database, string engine, List<OldAppTorrent> rows)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        // Rows the old app made for loose files have no torrent behind them; Import a folder covers those.
        command.CommandText = """
            SELECT hash, name, savePath FROM EngineTorrent
            WHERE status <> 'removed' AND COALESCE(torrentUrl, '') <> 'imported:local'
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            rows.Add(new(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), engine));
    }
}
