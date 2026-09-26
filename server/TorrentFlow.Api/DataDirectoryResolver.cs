using Microsoft.Data.Sqlite;

namespace TorrentFlow.Api;

/// <summary>One location for the database, engine resume state, settings secrets and caches in every launch mode.</summary>
public static class DataDirectoryResolver
{
    public static string DefaultDirectory() => OperatingSystem.IsMacOS()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Application Support", "TorrentFlow")
        : OperatingSystem.IsWindows()
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TorrentFlow")
            : Path.Combine(Environment.GetEnvironmentVariable("XDG_DATA_HOME") is { Length: > 0 } xdg && Path.IsPathFullyQualified(xdg)
                ? xdg : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share"), "TorrentFlow");

    public static string Resolve(string? configured, string contentRoot, string applicationDirectory,
        string defaultDirectory, Action<string> log)
    {
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        if (File.Exists(Path.Combine(applicationDirectory, "portable")))
            return Path.GetFullPath(Path.Combine(applicationDirectory, "data"));

        var target = Path.GetFullPath(defaultDirectory);
        Directory.CreateDirectory(target);
        // Serialize first-use migration across processes. A second launch must not initialize an empty database
        // while the first is copying resume state. A failed migration deliberately prevents startup.
        using var migrationLock = AcquireLock(Path.Combine(target, ".migration.lock"));
        if (File.Exists(Path.Combine(target, "torrentflow.db"))) return target;
        var candidates = new[] { Path.Combine(contentRoot, "data"), Path.Combine(applicationDirectory, "data") };
        var source = candidates.Select(Path.GetFullPath).FirstOrDefault(p =>
            !string.Equals(p, target, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)
            && File.Exists(Path.Combine(p, "torrentflow.db")));
        if (source is null) return target;

        var staging = Path.Combine(target, ".migration-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            CopyState(source, staging);
            // Raw copies of a live DB + WAL/SHM are not atomic. SQLite's backup API takes a consistent committed
            // snapshot INCLUDING WAL frames; SHM is transient and rebuilt by SQLite, never copied independently.
            using (var input = new SqliteConnection(new SqliteConnectionStringBuilder
                   { DataSource = Path.Combine(source, "torrentflow.db"), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()))
            using (var output = new SqliteConnection(new SqliteConnectionStringBuilder
                   { DataSource = Path.Combine(staging, "torrentflow.db"), Pooling = false }.ToString()))
            {
                input.Open();
                output.Open();
                input.BackupDatabase(output);
            }
            // Publish the database LAST, so an interrupted copy retries rather than adopting partial state.
            foreach (var entry in Directory.EnumerateFileSystemEntries(staging).Where(p => Path.GetFileName(p) != "torrentflow.db"))
                Publish(entry, Path.Combine(target, Path.GetFileName(entry)));
            File.Move(Path.Combine(staging, "torrentflow.db"), Path.Combine(target, "torrentflow.db"), overwrite: false);
            log($"Migrated TorrentFlow data from '{source}' to '{target}'. SQLite backup included committed WAL data; SHM is rebuilt. Source retained; existing files were not overwritten.");
        }
        catch (Exception ex)
        {
            throw new IOException($"Could not migrate TorrentFlow data from '{source}' to '{target}'. Source retained; startup stopped to avoid an empty download list.", ex);
        }
        finally { Directory.Delete(staging, recursive: true); }
        return target;
    }

    private static FileStream AcquireLock(string path)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 100) { Thread.Sleep(100); }
        }
    }

    private static void CopyState(string source, string target)
    {
        foreach (var entry in new DirectoryInfo(source).EnumerateFileSystemInfos())
        {
            if (entry.Name.StartsWith(".migration", StringComparison.Ordinal) || entry.Name.StartsWith("torrentflow.db", StringComparison.OrdinalIgnoreCase)) continue;
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("Legacy data contains a symbolic link or junction; use an explicit data directory to inspect it safely.");
            var destination = Path.Combine(target, entry.Name);
            if (entry is DirectoryInfo) { Directory.CreateDirectory(destination); CopyState(entry.FullName, destination); }
            else File.Copy(entry.FullName, destination, overwrite: false);
        }
    }

    private static void Publish(string source, string target)
    {
        if (Directory.Exists(source))
        {
            Directory.CreateDirectory(target);
            foreach (var entry in Directory.EnumerateFileSystemEntries(source))
                Publish(entry, Path.Combine(target, Path.GetFileName(entry)));
        }
        else if (!File.Exists(target)) File.Move(source, target, overwrite: false);
        else if (!SameFileContents(source, target))
            throw new IOException($"Existing app state conflicts with the legacy copy: '{target}'. Nothing was overwritten.");
    }

    private static bool SameFileContents(string source, string target)
    {
        using var left = File.OpenRead(source);
        using var right = File.OpenRead(target);
        if (left.Length != right.Length) return false;
        var a = new byte[64 * 1024];
        var b = new byte[a.Length];
        int count;
        while ((count = left.Read(a)) > 0)
        {
            right.ReadExactly(b.AsSpan(0, count));
            if (!a.AsSpan(0, count).SequenceEqual(b.AsSpan(0, count))) return false;
        }
        return true;
    }
}
