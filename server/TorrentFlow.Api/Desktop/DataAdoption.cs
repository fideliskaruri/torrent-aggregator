using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace TorrentFlow.Api.Desktop;

/// <summary>
/// Moves a <c>run.ps1</c> library (<c>server\TorrentFlow.Api\data</c> or <c>&lt;repo&gt;\data</c>) into the installed app's
/// data directory for install.ps1.
/// Copy first, verify every file by SHA-256, open the copied database read-only, rewrite the absolute paths that
/// pointed into the old folder, publish the database last, then rename the source to <c>data.migrated-&lt;stamp&gt;</c>.
/// Nothing is ever deleted and an existing library is never overwritten. It keeps to the rules of the app's in-app
/// migration from legacy folders (same target, never overwrite, keep the source) and takes a <c>.migration.lock</c>
/// in the target while it works; <c>.migration*</c> entries are never copied.
/// </summary>
public static class DataAdoption
{
    public const string AdoptArg = "--adopt-data";
    public const string CheckArg = "--check-db";
    public const string DatabaseFile = "torrentflow.db";

    public sealed record Result(bool Ok, string Message, string? SourceBackup = null, string? TargetBackup = null,
        long Files = 0, long Bytes = 0, int RewrittenValues = 0);

    /// <summary>
    /// <c>--check-db &lt;db&gt;</c> or <c>--adopt-data &lt;source&gt; &lt;target&gt; [--replace-existing]</c>. Returns an exit
    /// code when <paramref name="args"/> is one of these commands, otherwise null (normal startup).
    /// </summary>
    public static int? RunCli(string[] args, TextWriter output)
    {
        if (args.Length == 0) return null;
        try
        {
            if (args[0] == CheckArg)
            {
                if (args.Length < 2) { output.WriteLine("usage: --check-db <torrentflow.db>"); return 2; }
                var check = CheckDatabase(args[1]);
                output.WriteLine(check.Message);
                return check.Ok ? 0 : 1;
            }
            if (args[0] == AdoptArg)
            {
                if (args.Length < 3) { output.WriteLine("usage: --adopt-data <source dir> <target dir> [--replace-existing]"); return 2; }
                var result = Adopt(args[1], args[2], args.Contains("--replace-existing"), DateTimeOffset.Now, output.WriteLine);
                output.WriteLine(result.Message);
                return result.Ok ? 0 : 1;
            }
        }
        catch (Exception ex)
        {
            output.WriteLine($"failed: {ex.Message}");
            return 1;
        }
        return null;
    }

    /// <summary>Opens the database read-only and runs SQLite's quick_check.</summary>
    public static Result CheckDatabase(string dbPath)
    {
        if (!File.Exists(dbPath)) return new Result(false, $"no database at {dbPath}");
        try
        {
            using var connection = Open(dbPath, SqliteOpenMode.ReadOnly);
            var check = Scalar(connection, "PRAGMA quick_check") as string;
            var tables = Convert.ToInt64(Scalar(connection, "SELECT count(*) FROM sqlite_master WHERE type = 'table'"));
            return check == "ok" && tables > 0
                ? new Result(true, $"ok: {tables} tables")
                : new Result(false, $"database check failed: {check ?? "no result"}, {tables} tables");
        }
        catch (SqliteException ex)
        {
            return new Result(false, $"database could not be opened: {ex.Message}");
        }
    }

    public static Result Adopt(string source, string target, bool replaceExisting, DateTimeOffset now, Action<string>? log = null)
    {
        log ??= _ => { };
        source = Path.TrimEndingDirectorySeparator(Path.GetFullPath(source));
        target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(target));
        var stamp = now.ToString("yyyyMMdd-HHmmss");
        if (!File.Exists(Path.Combine(source, DatabaseFile)))
            return new Result(false, $"no library to move: {Path.Combine(source, DatabaseFile)} does not exist");
        if (PathsEqual(source, target) || IsUnder(target, source) || IsUnder(source, target))
            return new Result(false, "the old and new data folders overlap; nothing was changed");
        if (FindReparsePoint(source) is { } link)
            return new Result(false, $"{link} is a symbolic link or junction; move this library by hand. Nothing was changed.");

        var sourceCheck = CheckDatabase(Path.Combine(source, DatabaseFile));
        if (!sourceCheck.Ok) return new Result(false, $"the old library failed its check ({sourceCheck.Message}); nothing was changed");

        string? targetBackup = null;
        if (File.Exists(Path.Combine(target, DatabaseFile)))
        {
            if (!replaceExisting)
                return new Result(false, $"{target} already has a library; it was not overwritten");
            // Keep the installed library as a backup beside it rather than overwriting anything.
            targetBackup = UniquePath($"{target}.replaced-{stamp}");
            Directory.Move(target, targetBackup);
            log($"Kept the installed library as {targetBackup}");
        }

        Result result;
        try
        {
            result = AdoptInto(source, target, stamp, targetBackup, log);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            result = new Result(false, FailureMessage(ex.Message, source, target, targetBackup), TargetBackup: targetBackup);
        }
        if (result.Ok || targetBackup is null) return result;
        return RestoreTarget(target, targetBackup)
            ? result with { Message = result.Message + " The installed library was put back.", TargetBackup = null }
            : result with { Message = result.Message + $" The installed library is kept as {targetBackup}." };
    }

    private static Result AdoptInto(string source, string target, string stamp, string? targetBackup, Action<string> log)
    {
        Directory.CreateDirectory(target);
        var lockPath = Path.Combine(target, ".migration.lock");
        try
        {
            using var migrationLock = AcquireLock(lockPath);
            return CopyAndPublish(source, target, stamp, targetBackup, log);
        }
        finally
        {
            try { File.Delete(lockPath); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    // Puts the installed library back when a replace failed. Anything still in the target (files another
    // process wrote mid-copy) is moved aside to *.failed-* rather than deleted.
    private static bool RestoreTarget(string target, string targetBackup)
    {
        try
        {
            if (Directory.Exists(target))
            {
                if (Directory.EnumerateFileSystemEntries(target).Any())
                    Directory.Move(target, UniquePath($"{target}.failed-{DateTime.UtcNow:yyyyMMddHHmmss}"));
                else
                    Directory.Delete(target);
            }
            Directory.Move(targetBackup, target);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static Result CopyAndPublish(string source, string target, string stamp, string? targetBackup, Action<string> log)
    {
        if (File.Exists(Path.Combine(target, DatabaseFile)))
            return new Result(false, $"{target} gained a library while waiting (TorrentFlow started?); it was not overwritten", TargetBackup: targetBackup);

        var files = SourceFiles(source).ToList();
        var bytes = files.Sum(f => new FileInfo(f).Length);
        var root = Path.GetPathRoot(target);
        if (!string.IsNullOrEmpty(root))
        {
            var free = new DriveInfo(root).AvailableFreeSpace;
            if (free < bytes + (64L << 20))
                return new Result(false, $"not enough free space on {root}: {bytes >> 20} MB needed, {free >> 20} MB free. Nothing was changed.", TargetBackup: targetBackup);
        }
        // Refuse up front if any destination file already exists with different contents: never overwrite.
        foreach (var file in files)
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            if (File.Exists(destination) && !SameContents(file, destination))
                return new Result(false, $"{destination} already exists with different contents; nothing was overwritten", TargetBackup: targetBackup);
        }

        var staging = Path.Combine(target, ".migration-" + Guid.NewGuid().ToString("N"));
        int rewritten;
        try
        {
            log($"Copying {files.Count} files ({bytes / 1048576.0:0.#} MB) from {source}");
            foreach (var file in files)
            {
                var destination = Path.Combine(staging, Path.GetRelativePath(source, file));
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                var before = new FileInfo(file);
                var (length, written) = (before.Length, before.LastWriteTimeUtc);
                var expected = CopyWithHash(file, destination);
                var after = new FileInfo(file);
                if (after.Length != length || after.LastWriteTimeUtc != written)
                    throw new IOException($"{file} changed while it was being copied (is TorrentFlow still running from this folder?)");
                if (!HashFile(destination).AsSpan().SequenceEqual(expected))
                    throw new IOException($"the copy of {file} does not match the original");
            }
            foreach (var dir in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories)
                         .Where(d => !IsSkipped(Path.GetRelativePath(source, d))))
                Directory.CreateDirectory(Path.Combine(staging, Path.GetRelativePath(source, dir)));
            log("Every file matches its SHA-256");

            var stagedDb = Path.Combine(staging, DatabaseFile);
            var copyCheck = CheckDatabase(stagedDb);
            if (!copyCheck.Ok) throw new IOException($"the copied database failed its check: {copyCheck.Message}");
            log($"Copied database opens read-only ({copyCheck.Message})");

            rewritten = RewriteDatabasePaths(stagedDb, source, target) + RewriteJsonFiles(staging, source, target);
            var finalCheck = CheckDatabase(stagedDb);
            if (!finalCheck.Ok) throw new IOException($"the database failed its check after updating paths: {finalCheck.Message}");
            if (rewritten > 0) log($"Pointed {rewritten} stored paths at {target}");

            // Publish everything, the database last, so an interrupted run leaves no half-adopted library.
            // Track moves so a mid-publish failure can undo them (source is still intact; staging holds the rest).
            var published = new List<string>();
            try
            {
                var dbFiles = new[] { DatabaseFile, DatabaseFile + "-wal", DatabaseFile + "-shm" };
                foreach (var entry in Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories)
                             .Where(f => Path.GetDirectoryName(f) != staging
                                         || !dbFiles.Contains(Path.GetFileName(f), StringComparer.OrdinalIgnoreCase)))
                    Publish(entry, Path.Combine(target, Path.GetRelativePath(staging, entry)), published);
                foreach (var dir in Directory.EnumerateDirectories(staging, "*", SearchOption.AllDirectories))
                    Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(staging, dir)));
                foreach (var suffix in new[] { "-wal", "-shm" })
                    if (File.Exists(stagedDb + suffix))
                        Publish(stagedDb + suffix, Path.Combine(target, DatabaseFile + suffix), published);
                var targetDb = Path.Combine(target, DatabaseFile);
                File.Move(stagedDb, targetDb, overwrite: false);
                published.Add(targetDb);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SqliteException)
            {
                UndoPublished(published, target);
                throw new IOException(ex.Message, ex);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SqliteException)
        {
            return new Result(false, FailureMessage(ex.Message, source, target, targetBackup), TargetBackup: targetBackup);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        }

        var sourceBackup = UniquePath(Path.Combine(Path.GetDirectoryName(source)!, $"{Path.GetFileName(source)}.migrated-{stamp}"));
        try
        {
            Directory.Move(source, sourceBackup);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new Result(true, $"Moved the library to {target}, but could not rename {source} ({ex.Message}). Rename or delete it yourself once you have checked the installed app.",
                null, targetBackup, files.Count, bytes, rewritten);
        }
        return new Result(true, $"Moved the library to {target}. The old folder is kept as {sourceBackup}.",
            sourceBackup, targetBackup, files.Count, bytes, rewritten);
    }

    /// <summary>Points TEXT values that referenced the old data folder (plain or JSON-escaped) at the new one.</summary>
    internal static int RewriteDatabasePaths(string dbPath, string source, string target)
    {
        using var connection = Open(dbPath, SqliteOpenMode.ReadWrite);
        var tables = new List<string>();
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) tables.Add(reader.GetString(0));
        }
        var total = 0;
        using var transaction = connection.BeginTransaction();
        foreach (var table in tables)
        {
            var columns = new List<string>();
            using (var cmd = connection.CreateCommand())
            {
                cmd.Transaction = transaction;
                cmd.CommandText = $"SELECT name, type FROM pragma_table_info({Quote(table, '\'')})";
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var type = reader.IsDBNull(1) ? "" : reader.GetString(1);
                    if (type.Length == 0 || type.Contains("CHAR", StringComparison.OrdinalIgnoreCase)
                        || type.Contains("TEXT", StringComparison.OrdinalIgnoreCase) || type.Contains("CLOB", StringComparison.OrdinalIgnoreCase))
                        columns.Add(reader.GetString(0));
                }
            }
            foreach (var column in columns)
                foreach (var (from, to) in Replacements(source, target))
                    total += ReplacePrefix(connection, transaction, table, column, from, to);
        }
        transaction.Commit();
        return total;
    }

    private static int ReplacePrefix(SqliteConnection connection, SqliteTransaction transaction, string table, string column, string from, string to)
    {
        var t = Quote(table, '"');
        var c = Quote(column, '"');
        var values = new List<string>();
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            // instr() on lower() matches regardless of drive-letter case.
            select.CommandText = $"SELECT DISTINCT {c} FROM {t} WHERE typeof({c}) = 'text' AND (instr(lower({c}), lower($from)) > 0 OR lower({c}) = lower($bare))";
            select.Parameters.AddWithValue("$from", from);
            select.Parameters.AddWithValue("$bare", from.TrimEnd('\\', '/'));
            using var reader = select.ExecuteReader();
            while (reader.Read()) values.Add(reader.GetString(0));
        }
        var changed = 0;
        foreach (var value in values)
        {
            var updated = string.Equals(value, from.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase)
                ? to.TrimEnd('\\', '/')
                : value.Replace(from, to, StringComparison.OrdinalIgnoreCase);
            if (updated == value) continue;
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = $"UPDATE {t} SET {c} = $new WHERE {c} = $old";
            update.Parameters.AddWithValue("$new", updated);
            update.Parameters.AddWithValue("$old", value);
            changed += update.ExecuteNonQuery();
        }
        return changed;
    }

    private static int RewriteJsonFiles(string staging, string source, string target)
    {
        var total = 0;
        foreach (var file in Directory.EnumerateFiles(staging, "*.json", SearchOption.AllDirectories))
        {
            if (new FileInfo(file).Length > 8 << 20) continue;
            var text = File.ReadAllText(file);
            var updated = text;
            foreach (var (from, to) in Replacements(source, target))
            {
                var index = updated.IndexOf(from, StringComparison.OrdinalIgnoreCase);
                while (index >= 0)
                {
                    updated = string.Concat(updated.AsSpan(0, index), to, updated.AsSpan(index + from.Length));
                    total++;
                    index = updated.IndexOf(from, index + to.Length, StringComparison.OrdinalIgnoreCase);
                }
            }
            if (updated != text) File.WriteAllText(file, updated, new UTF8Encoding(false));
        }
        return total;
    }

    /// <summary>The old folder with a trailing separator, plain and as it appears inside JSON strings.</summary>
    private static IEnumerable<(string From, string To)> Replacements(string source, string target)
    {
        var sep = Path.DirectorySeparatorChar.ToString();
        yield return (source + sep, target + sep);
        if (sep == "\\") yield return (source.Replace("\\", "\\\\") + "\\\\", target.Replace("\\", "\\\\") + "\\\\");
    }

    private static IEnumerable<string> SourceFiles(string source) =>
        Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories)
            .Where(f => !IsSkipped(Path.GetRelativePath(source, f)));

    // The host's own migration staging/lock files are never part of a library.
    private static bool IsSkipped(string relative) =>
        relative.Split(Path.DirectorySeparatorChar)[0].StartsWith(".migration", StringComparison.Ordinal);

    private static string? FindReparsePoint(string source) =>
        new DirectoryInfo(source).EnumerateFileSystemInfos("*", SearchOption.AllDirectories)
            .FirstOrDefault(e => e.Attributes.HasFlag(FileAttributes.ReparsePoint))?.FullName;

    private static void Publish(string staged, string destination, List<string> published)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        if (!File.Exists(destination))
        {
            File.Move(staged, destination, overwrite: false);
            published.Add(destination);
        }
        else if (!SameContents(staged, destination))
        {
            // Only claim nothing was overwritten when this is truly the first publish conflict.
            var suffix = published.Count == 0
                ? "nothing was overwritten"
                : $"{published.Count} file(s) had already been moved into the target and will be rolled back";
            throw new IOException($"{destination} appeared with different contents while copying; {suffix}");
        }
    }

    /// <summary>
    /// Removes files moved from staging into the target during a failed publish, then prunes empty
    /// directories left under the target. The source library is untouched; staged leftovers are
    /// deleted with the staging folder in the caller.
    /// </summary>
    private static void UndoPublished(List<string> published, string target)
    {
        foreach (var path in published)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(target, "*", SearchOption.AllDirectories)
                         .Where(d => !IsSkipped(Path.GetRelativePath(target, d)))
                         .OrderByDescending(d => d.Length))
            {
                try
                {
                    if (!Directory.EnumerateFileSystemEntries(dir).Any())
                        Directory.Delete(dir);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private static string FailureMessage(string detail, string source, string target, string? targetBackup)
    {
        var backup = targetBackup is null
            ? "no target backup was created"
            : $"target backup: {targetBackup}";
        return $"moving the library failed: {detail}. Source left at {source}. Target: {target}. {backup}. The old library was not deleted.";
    }

    private static byte[] CopyWithHash(string from, string to)
    {
        using var input = new FileStream(from, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new FileStream(to, FileMode.CreateNew, FileAccess.Write);
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[1 << 20];
        int read;
        while ((read = input.Read(buffer)) > 0)
        {
            sha.AppendData(buffer, 0, read);
            output.Write(buffer, 0, read);
        }
        output.Flush(flushToDisk: true);
        File.SetLastWriteTimeUtc(to, File.GetLastWriteTimeUtc(from));
        return sha.GetHashAndReset();
    }

    private static byte[] HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return SHA256.HashData(stream);
    }

    private static bool SameContents(string a, string b) =>
        new FileInfo(a).Length == new FileInfo(b).Length && HashFile(a).AsSpan().SequenceEqual(HashFile(b));

    private static FileStream AcquireLock(string path)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 100) { Thread.Sleep(100); }
        }
    }

    private static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
        connection.Open();
        return connection;
    }

    private static object? Scalar(SqliteConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    private static string Quote(string name, char quote) => quote + name.Replace(quote.ToString(), new string(quote, 2)) + quote;

    private static string UniquePath(string path)
    {
        var candidate = path;
        for (var n = 2; Directory.Exists(candidate) || File.Exists(candidate); n++) candidate = $"{path}-{n}";
        return candidate;
    }

    private static bool PathsEqual(string a, string b) =>
        string.Equals(a, b, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static bool IsUnder(string path, string parent) =>
        path.StartsWith(parent + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
}
