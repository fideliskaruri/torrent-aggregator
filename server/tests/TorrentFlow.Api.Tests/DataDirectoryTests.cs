using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TorrentFlow.Api;
using TorrentFlow.Engine;
using System.Net.Http.Json;
using System.Text.Json;

namespace TorrentFlow.Api.Tests;

public sealed class DataDirectoryTests : IDisposable
{
    private readonly string root = Path.Combine(AppContext.BaseDirectory, "testdata", Guid.NewGuid().ToString("N"));
    private string Dir(string name) { var path = Path.Combine(root, name); Directory.CreateDirectory(path); return path; }
    private string Resolve(string? configured = null, string content = "clone", string app = "app") =>
        DataDirectoryResolver.Resolve(configured, Dir(content), Dir(app), Dir("default"), _ => { });

    [Fact]
    public void DevAndPublishedAndDifferentClonesShareDefault()
    {
        Assert.Equal(Resolve(content: "clone-a", app: "debug"), Resolve(content: "clone-b", app: "published"));
        Assert.Equal(Dir("default"), Resolve());
    }

    [Fact]
    public void ExplicitOverrideWinsOverPortableAndDoesNotMigrate()
    {
        File.WriteAllText(Path.Combine(Dir("app"), "portable"), "");
        var legacy = Dir(Path.Combine("clone", "data"));
        File.WriteAllText(Path.Combine(legacy, "torrentflow.db"), "must not copy");
        Assert.Equal(Dir("explicit"), Resolve(Dir("explicit")));
        Assert.False(File.Exists(Path.Combine(Dir("explicit"), "torrentflow.db")));
    }

    [Fact]
    public void PortableMarkerWorksForDllAndExecutable()
    {
        File.WriteAllText(Path.Combine(Dir("app"), "portable"), "");
        Assert.Equal(Path.Combine(Dir("app"), "data"), Resolve());
    }

    [Theory]
    [InlineData("clone")]
    [InlineData("app")]
    public void MigratesCommittedWalAndEngineStateWithoutChangingSource(string location)
    {
        var source = Dir(Path.Combine(location, "data"));
        var sourceDb = Path.Combine(source, "torrentflow.db");
        using var connection = new SqliteConnection($"Data Source={sourceDb};Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('survived');";
        command.ExecuteNonQuery();
        Assert.True(File.Exists(sourceDb + "-wal"));
        var resume = Path.Combine(source, "engine", "fastresume");
        Directory.CreateDirectory(resume);
        File.WriteAllText(Path.Combine(resume, "one.resume"), "resume-data");
        var target = Resolve();
        using var migrated = new SqliteConnection($"Data Source={Path.Combine(target, "torrentflow.db")};Pooling=False");
        migrated.Open();
        using var query = migrated.CreateCommand();
        query.CommandText = "SELECT value FROM proof";
        Assert.Equal("survived", query.ExecuteScalar());
        Assert.Equal("resume-data", File.ReadAllText(Path.Combine(target, "engine", "fastresume", "one.resume")));
        Assert.True(File.Exists(sourceDb));
    }

    [Fact]
    public void NeverOverwritesExistingDatabase()
    {
        File.WriteAllText(Path.Combine(Dir("default"), "torrentflow.db"), "existing");
        File.WriteAllText(Path.Combine(Dir(Path.Combine("clone", "data")), "torrentflow.db"), "legacy");
        Assert.Equal("existing", File.ReadAllText(Path.Combine(Resolve(), "torrentflow.db")));
    }

    [Fact]
    public void InvalidLegacyDatabaseFailsClosed()
    {
        File.WriteAllText(Path.Combine(Dir(Path.Combine("clone", "data")), "torrentflow.db"), "not sqlite");
        Assert.Throws<IOException>(() => Resolve());
        Assert.False(File.Exists(Path.Combine(Dir("default"), "torrentflow.db")));
    }

    [Fact]
    public void ConflictingStateFailsClosedRatherThanMixingSecrets()
    {
        var source = Dir(Path.Combine("clone", "data"));
        using (var connection = new SqliteConnection($"Data Source={Path.Combine(source, "torrentflow.db")};Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE proof(value TEXT)";
            command.ExecuteNonQuery();
        }
        File.WriteAllText(Path.Combine(source, ".torrentflow.key"), "legacy key");
        File.WriteAllText(Path.Combine(Dir("default"), ".torrentflow.key"), "different key");
        Assert.Throws<IOException>(() => Resolve());
        Assert.Equal("different key", File.ReadAllText(Path.Combine(Dir("default"), ".torrentflow.key")));
        Assert.False(File.Exists(Path.Combine(Dir("default"), "torrentflow.db")));
    }

    [Fact]
    public void HostPropagatesSameDirectoryIntoEngine()
    {
        using var host = new HostFactory();
        using var client = host.CreateClient();
        Assert.Equal(host.Root, host.Services.GetRequiredService<IOptions<EngineOptions>>().Value.DataDirectory);
    }

    [Fact]
    public async Task ImportedFilesAppearInLibraryWithoutEnablingAutomation()
    {
        using var host = new HostFactory();
        using var client = host.CreateClient();
        var downloads = Path.Combine(host.Root, "media");
        Directory.CreateDirectory(downloads);
        File.WriteAllText(Path.Combine(downloads, "Example Show S01E01.mkv"), "media");
        File.WriteAllText(Path.Combine(downloads, "Example Show S01E02.mkv"), "media");
        (await client.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = downloads, maxStorageGb = 1 })).EnsureSuccessStatusCode();
        (await client.PostAsync("/api/settings/download-recovery", null)).EnsureSuccessStatusCode();
        (await client.PostAsync("/api/settings/download-recovery", null)).EnsureSuccessStatusCode();
        var library = await client.GetFromJsonAsync<JsonElement>("/api/watchlist");
        var item = Assert.Single(library.GetProperty("items").EnumerateArray());
        Assert.Equal("Example Show", item.GetProperty("title").GetString());
        Assert.False(item.GetProperty("monitored").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(item.GetProperty("workId").GetString()));
    }

    [Fact]
    public async Task ForwardedRequestsCannotReadPathsOrTriggerImport()
    {
        using var host = new HostFactory();
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "192.0.2.5");
        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
        {
            using var response = await client.SendAsync(new HttpRequestMessage(method, "/api/settings/download-recovery"));
            Assert.Equal(System.Net.HttpStatusCode.NotFound, response.StatusCode);
            Assert.DoesNotContain(host.Root, await response.Content.ReadAsStringAsync());
        }
        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
        {
            using var request = new HttpRequestMessage(method, "/api/settings/download-recovery/sources");
            if (method == HttpMethod.Post) request.Content = JsonContent.Create(new { ids = new[] { "fixture" }, acknowledged = true });
            using var response = await client.SendAsync(request);
            Assert.Equal(System.Net.HttpStatusCode.NotFound, response.StatusCode);
            Assert.DoesNotContain(host.Root, await response.Content.ReadAsStringAsync());
        }
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
