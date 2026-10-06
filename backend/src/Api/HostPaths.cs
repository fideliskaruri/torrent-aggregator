using System.Globalization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.FileProviders;

namespace TorrentFlow.Api;

internal static class HostPaths
{
    public static string DataDirectory(IConfiguration configuration)
    {
        var configured = configuration["TorrentFlow:DataDirectory"];
        var portable = File.Exists(Path.Combine(AppContext.BaseDirectory, "portable"));
        var defaultRoot = OperatingSystem.IsWindows()
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : OperatingSystem.IsMacOS()
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support")
                : Environment.GetEnvironmentVariable("XDG_DATA_HOME") is { Length: > 0 } xdg && Path.IsPathFullyQualified(xdg)
                    ? xdg : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
        var result = Path.GetFullPath(!string.IsNullOrWhiteSpace(configured) ? configured
            : portable ? Path.Combine(AppContext.BaseDirectory, "data")
            : Path.Combine(defaultRoot, "TorrentFlow"));
        Directory.CreateDirectory(result);
        configuration["TorrentFlow:OldAppBackup"] = SetAsideOldAppData(result);
        configuration["TorrentFlow:DataDirectory"] = result;
        return result;
    }

    // The old app used this folder with a database and engine state the rebuild can't read.
    // Keep them untouched in a backup folder so the rebuild starts clean beside the old settings files.
    private static string? SetAsideOldAppData(string directory)
    {
        var database = Path.Combine(directory, "torrentflow.db");
        if (!File.Exists(database) || IsRebuildDatabase(database)) return null;
        var backup = Path.Combine(directory, "old-app-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(backup);
        try
        {
            // The database goes first: if the old app still has it open, nothing else moves.
            foreach (var name in new[] { "torrentflow.db", "torrentflow.db-wal", "torrentflow.db-shm", "engine" })
            {
                var source = Path.Combine(directory, name);
                if (File.Exists(source)) File.Move(source, Path.Combine(backup, name));
                else if (Directory.Exists(source)) Directory.Move(source, Path.Combine(backup, name));
            }
        }
        catch (IOException ex)
        {
            if (!Directory.EnumerateFileSystemEntries(backup).Any()) Directory.Delete(backup);
            throw new IOException($"The old TorrentFlow data in '{directory}' is still in use. Close the old TorrentFlow and start again.", ex);
        }
        return backup;
    }

    private static bool IsRebuildDatabase(string path)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table'";
        var tables = new List<string>();
        using (var reader = command.ExecuteReader())
            while (reader.Read()) tables.Add(reader.GetString(0));
        if (tables.Count == 0) return true;
        if (!tables.Contains("__EFMigrationsHistory")) return false;
        command.CommandText = "SELECT COUNT(*) FROM __EFMigrationsHistory WHERE MigrationId = '20261004151352_InitialSchema'";
        return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) > 0;
    }

    public static PhysicalFileProvider? WebFiles(IConfiguration configuration, string contentRoot)
    {
        var configured = configuration["TorrentFlow:WebRoot"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var path = Path.GetFullPath(configured);
            if (!File.Exists(Path.Combine(path, "index.html")))
                throw new InvalidOperationException("The configured web build is missing index.html. Build web with pnpm build first.");
            return new PhysicalFileProvider(path);
        }
        var roots = new[] { AppContext.BaseDirectory, contentRoot };
        foreach (var root in roots)
        {
            for (var directory = new DirectoryInfo(root); directory is not null; directory = directory.Parent)
            {
                foreach (var path in new[] { Path.Combine(directory.FullName, "wwwroot"), Path.Combine(directory.FullName, "web", "dist") })
                    if (File.Exists(Path.Combine(path, "index.html"))) return new PhysicalFileProvider(path);
            }
        }
        return null;
    }
}
