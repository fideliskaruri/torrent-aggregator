using Microsoft.Data.Sqlite;
using TorrentFlow.Api.Desktop;

namespace TorrentFlow.Api.Tests;

public sealed class DataAdoptionTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 9, 26, 5, 0, 0, TimeSpan.Zero);
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tf-adopt-" + Guid.NewGuid().ToString("N"));
    private string Source => Path.Combine(_root, "repo", "data");
    private string Target => Path.Combine(_root, "LocalAppData", "TorrentFlow");

    public DataAdoptionTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void SeedLibrary(string dir, string name = "Old Show")
    {
        Directory.CreateDirectory(Path.Combine(dir, "engine", "metadata"));
        Directory.CreateDirectory(Path.Combine(dir, "downloads", name));
        File.WriteAllText(Path.Combine(dir, "downloads", name, "episode.mkv"), "video");
        File.WriteAllBytes(Path.Combine(dir, "engine", "metadata", "abc.torrent"), [1, 2, 3]);
        File.WriteAllText(Path.Combine(dir, "desktop.json"), $$"""{"folder":"{{Path.Combine(dir, "downloads").Replace("\\", "\\\\")}}"}""");
        using var db = new SqliteConnection($"Data Source={Path.Combine(dir, DataAdoption.DatabaseFile)};Pooling=False");
        db.Open();
        Exec(db, "PRAGMA journal_mode=WAL");
        Exec(db, "CREATE TABLE EngineTorrent (id INTEGER PRIMARY KEY, name TEXT, savePath TEXT, files TEXT, size INTEGER)");
        using var insert = db.CreateCommand();
        insert.CommandText = "INSERT INTO EngineTorrent (name, savePath, files, size) VALUES ($n, $p, $f, 5)";
        insert.Parameters.AddWithValue("$n", name);
        insert.Parameters.AddWithValue("$p", Path.Combine(dir, "downloads").ToUpperInvariant() is var upper && OperatingSystem.IsWindows() ? upper : Path.Combine(dir, "downloads"));
        insert.Parameters.AddWithValue("$f", $$"""["{{Path.Combine(dir, "downloads", name, "a.mkv").Replace("\\", "\\\\")}}","{{Path.Combine(dir, "downloads", name, "b.mkv").Replace("\\", "\\\\")}}"]""");
        insert.ExecuteNonQuery();
    }

    private static void Exec(SqliteConnection db, string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static (string Name, string SavePath, string Files) ReadRow(string dir)
    {
        using var db = new SqliteConnection($"Data Source={Path.Combine(dir, DataAdoption.DatabaseFile)};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT name, savePath, files FROM EngineTorrent";
        using var reader = cmd.ExecuteReader();
        Assert.True(reader.Read());
        return (reader.GetString(0), reader.GetString(1), reader.GetString(2));
    }

    [Fact]
    public void AdoptingCopiesTheWholeLibraryRepointsPathsAndKeepsTheOldFolder()
    {
        SeedLibrary(Source);

        var result = DataAdoption.Adopt(Source, Target, replaceExisting: false, Now);

        Assert.True(result.Ok, result.Message);
        Assert.False(Directory.Exists(Source));
        Assert.Equal(Source + ".migrated-20260926-050000", result.SourceBackup);
        Assert.True(File.Exists(Path.Combine(result.SourceBackup!, DataAdoption.DatabaseFile)), "the old library is renamed, never deleted");
        Assert.Equal("video", File.ReadAllText(Path.Combine(Target, "downloads", "Old Show", "episode.mkv")));
        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(Target, "engine", "metadata", "abc.torrent")));
        var row = ReadRow(Target);
        Assert.Equal("Old Show", row.Name);
        Assert.True(string.Equals(Path.Combine(Target, "downloads"), row.SavePath, StringComparison.OrdinalIgnoreCase), row.SavePath);
        Assert.DoesNotContain("repo", row.Files);
        Assert.Contains(Path.Combine(Target, "downloads", "Old Show", "b.mkv").Replace("\\", "\\\\"), row.Files);
        Assert.Contains(Path.Combine(Target, "downloads").Replace("\\", "\\\\"), File.ReadAllText(Path.Combine(Target, "desktop.json")));
        Assert.Empty(Directory.EnumerateDirectories(Target, ".migration-*"));
        Assert.True(DataAdoption.CheckDatabase(Path.Combine(Target, DataAdoption.DatabaseFile)).Ok);
    }

    [Fact]
    public void AnInstalledLibraryIsNeverOverwrittenUnlessReplacingWhichKeepsItAsABackup()
    {
        SeedLibrary(Source, "Old Show");
        SeedLibrary(Target, "Installed Show");

        var refused = DataAdoption.Adopt(Source, Target, replaceExisting: false, Now);

        Assert.False(refused.Ok);
        Assert.Equal("Installed Show", ReadRow(Target).Name);
        Assert.True(File.Exists(Path.Combine(Source, DataAdoption.DatabaseFile)), "the source is untouched when refused");

        var replaced = DataAdoption.Adopt(Source, Target, replaceExisting: true, Now);

        Assert.True(replaced.Ok, replaced.Message);
        Assert.Equal("Old Show", ReadRow(Target).Name);
        Assert.Equal(Target + ".replaced-20260926-050000", replaced.TargetBackup);
        Assert.Equal("Installed Show", ReadRow(replaced.TargetBackup!).Name);
    }

    [Fact]
    public void AdoptingIsIdempotentOnceTheSourceHasBeenRenamed()
    {
        SeedLibrary(Source);
        Assert.True(DataAdoption.Adopt(Source, Target, false, Now).Ok);

        var again = DataAdoption.Adopt(Source, Target, false, Now.AddMinutes(1));

        Assert.False(again.Ok);
        Assert.Contains("no library to move", again.Message);
        Assert.Equal("Old Show", ReadRow(Target).Name);
    }

    [Fact]
    public void AConflictingFileInTheTargetStopsBeforeAnythingIsCopied()
    {
        SeedLibrary(Source);
        Directory.CreateDirectory(Target);
        File.WriteAllText(Path.Combine(Target, "desktop.json"), "{\"mine\":true}");

        var result = DataAdoption.Adopt(Source, Target, false, Now);

        Assert.False(result.Ok);
        Assert.Contains("different contents", result.Message);
        Assert.Equal("{\"mine\":true}", File.ReadAllText(Path.Combine(Target, "desktop.json")));
        Assert.False(File.Exists(Path.Combine(Target, DataAdoption.DatabaseFile)));
        Assert.True(Directory.Exists(Source));
    }

    [Fact]
    public void ACorruptLibraryIsRefusedAndLeftInPlace()
    {
        Directory.CreateDirectory(Source);
        File.WriteAllText(Path.Combine(Source, DataAdoption.DatabaseFile), "not a database, just text that is long enough to not be empty");

        var result = DataAdoption.Adopt(Source, Target, false, Now);

        Assert.False(result.Ok);
        Assert.True(File.Exists(Path.Combine(Source, DataAdoption.DatabaseFile)));
        Assert.False(File.Exists(Path.Combine(Target, DataAdoption.DatabaseFile)));
    }

    [Fact]
    public void EveryStoredPathIsRepointedAndOtherDatabaseSidecarsAreKept()
    {
        SeedLibrary(Source);
        var pack = "[" + string.Join(",", Enumerable.Range(1, 120).Select(i => $"\"{Path.Combine(Source, "downloads", "Pack", $"e{i}.mkv").Replace("\\", "\\\\")}\"")) + "]";
        using (var db = new SqliteConnection($"Data Source={Path.Combine(Source, DataAdoption.DatabaseFile)};Pooling=False"))
        {
            db.Open();
            using var update = db.CreateCommand();
            update.CommandText = "UPDATE EngineTorrent SET files = $f";
            update.Parameters.AddWithValue("$f", pack);
            update.ExecuteNonQuery();
        }
        File.WriteAllText(Path.Combine(Source, DataAdoption.DatabaseFile + ".bak"), "user backup");

        var result = DataAdoption.Adopt(Source, Target, false, Now);

        Assert.True(result.Ok, result.Message);
        var files = ReadRow(Target).Files;
        Assert.DoesNotContain(Path.Combine("repo", "data").Replace("\\", "\\\\"), files);
        Assert.Contains(Path.Combine(Target, "downloads", "Pack", "e120.mkv").Replace("\\", "\\\\"), files);
        Assert.Equal("user backup", File.ReadAllText(Path.Combine(Target, DataAdoption.DatabaseFile + ".bak")));
        Assert.False(File.Exists(Path.Combine(Target, ".migration.lock")));
    }

    [Fact]
    public void AFailedReplacePutsTheInstalledLibraryBack()
    {
        if (!OperatingSystem.IsWindows()) return; // relies on Windows exclusive file locks
        SeedLibrary(Source, "Old Show");
        SeedLibrary(Target, "Installed Show");
        SqliteConnection.ClearAllPools();

        DataAdoption.Result result;
        using (new FileStream(Path.Combine(Source, "desktop.json"), FileMode.Open, FileAccess.Read, FileShare.None))
            result = DataAdoption.Adopt(Source, Target, replaceExisting: true, Now);

        Assert.False(result.Ok);
        Assert.Contains("put back", result.Message);
        Assert.Null(result.TargetBackup);
        Assert.Equal("Installed Show", ReadRow(Target).Name);
        Assert.False(Directory.Exists(Target + ".replaced-20260926-050000"));
        Assert.True(File.Exists(Path.Combine(Source, DataAdoption.DatabaseFile)));
    }

    /// <summary>
    /// Pre-check sees destination paths under target/downloads as missing when "downloads" is a file,
    /// so copy into staging succeeds and publish fails mid-way when CreateDirectory cannot replace that file.
    /// </summary>
    [Fact]
    public void AMidPublishFailureRollsBackFreshTargetAndLeavesSource()
    {
        SeedLibrary(Source);
        Directory.CreateDirectory(Target);
        File.WriteAllText(Path.Combine(Target, "downloads"), "not-a-directory");

        var result = DataAdoption.Adopt(Source, Target, replaceExisting: false, Now);

        Assert.False(result.Ok);
        Assert.Contains(Source, result.Message);
        Assert.Contains(Target, result.Message);
        Assert.Contains("not deleted", result.Message);
        Assert.True(Directory.Exists(Source));
        Assert.True(File.Exists(Path.Combine(Source, DataAdoption.DatabaseFile)));
        Assert.Equal("video", File.ReadAllText(Path.Combine(Source, "downloads", "Old Show", "episode.mkv")));
        Assert.False(File.Exists(Path.Combine(Target, DataAdoption.DatabaseFile)));
        Assert.False(File.Exists(Path.Combine(Target, "desktop.json")));
        Assert.False(Directory.Exists(Path.Combine(Target, "engine")));
        Assert.Equal("not-a-directory", File.ReadAllText(Path.Combine(Target, "downloads")));
        Assert.Empty(Directory.EnumerateDirectories(Target, ".migration-*"));
    }

    [Fact]
    public void AMidPublishFailureDuringReplaceRestoresInstalledLibrary()
    {
        SeedLibrary(Source, "Old Show");
        SeedLibrary(Target, "Installed Show");
        SqliteConnection.ClearAllPools();

        // After replace moves the installed library aside, plant a file where publish must create a directory.
        // Pre-check still passes: destination paths under target/downloads look missing when it is a file.
        var planter = new Thread(() =>
        {
            for (var i = 0; i < 20_000; i++)
            {
                try
                {
                    if (!Directory.Exists(Target)) { Thread.Sleep(0); continue; }
                    // Wait until the previous library has been moved out (replace backup exists).
                    if (!Directory.EnumerateDirectories(Path.GetDirectoryName(Target)!,
                            Path.GetFileName(Target) + ".replaced-*").Any())
                    {
                        Thread.Sleep(0);
                        continue;
                    }
                    var marker = Path.Combine(Target, "downloads");
                    if (!File.Exists(marker) && !Directory.Exists(marker))
                        File.WriteAllText(marker, "not-a-directory");
                    return;
                }
                catch (IOException) { Thread.Sleep(0); }
                catch (UnauthorizedAccessException) { Thread.Sleep(0); }
            }
        }) { IsBackground = true };
        planter.Start();

        var result = DataAdoption.Adopt(Source, Target, replaceExisting: true, Now);
        planter.Join(TimeSpan.FromSeconds(10));

        Assert.False(result.Ok, result.Message);
        Assert.Contains(Source, result.Message);
        Assert.Contains(Target, result.Message);
        Assert.Contains("not deleted", result.Message);
        Assert.True(File.Exists(Path.Combine(Source, DataAdoption.DatabaseFile)), "source must never be deleted");
        Assert.Equal("Old Show", ReadRow(Source).Name);
        Assert.Contains("put back", result.Message);
        Assert.Null(result.TargetBackup);
        Assert.Equal("Installed Show", ReadRow(Target).Name);
        Assert.False(Directory.Exists(Target + ".replaced-20260926-050000"));
        Assert.False(File.Exists(Path.Combine(Target, "downloads", "Old Show", "episode.mkv")));
    }

    [Fact]
    public void CliReportsCheckResultsThroughItsExitCode()
    {
        SeedLibrary(Source);
        var output = new StringWriter();

        Assert.Equal(0, DataAdoption.RunCli([DataAdoption.CheckArg, Path.Combine(Source, DataAdoption.DatabaseFile)], output));
        Assert.Contains("ok", output.ToString());
        Assert.Equal(1, DataAdoption.RunCli([DataAdoption.CheckArg, Path.Combine(_root, "missing.db")], output));
        Assert.Null(DataAdoption.RunCli(["--urls", "http://127.0.0.1:3924"], output));
        Assert.Null(DataAdoption.RunCli([], output));
    }
}
