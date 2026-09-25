using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using Xunit;

namespace TorrentFlow.Engine.Tests;

public sealed class SettingsParityTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private readonly HttpClient _http = factory.CreateClient();

    private async Task<JsonElement> Read(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    [Theory]
    [InlineData("""{"preferredResolution":1080.5}""", "preferredResolution", "preferredResolution must be an integer")]
    [InlineData("""{"automationIntervalMinutes":30.5}""", "automationIntervalMinutes", "automationIntervalMinutes must be an integer")]
    [InlineData("""{"maxStorageGb":"10"}""", "maxStorageGb", "maxStorageGb must be a finite number")]
    [InlineData("""{"maxStorageBytes":-1}""", "maxStorageBytes", "maxStorageBytes must be at least 0")]
    [InlineData("""{"categories":[1]}""", "categories", "categories[0] must be a string")]
    [InlineData("""{"categories":[""]}""", "categories", "categories[0] may not be empty")]
    [InlineData("""{"pathRules":{"TV":false}}""", "pathRules", "pathRules keys and values must be non-empty strings")]
    [InlineData("""{"defaultRetentionPolicy":"INVALID"}""", "defaultRetentionPolicy", "defaultRetentionPolicy must be one of: EPHEMERAL, KEPT, STREAM, KEEP")]
    [InlineData("""{"host":"ftp://example.com"}""", "host", "host must use http or https")]
    [InlineData("""{"verboseDiagnostics":"true"}""", "verboseDiagnostics", "verboseDiagnostics must be a boolean")]
    [InlineData("""{"switchToBuiltin":true,"test":"yes"}""", "test", "test must be a boolean")]
    [InlineData("""{"maxActiveDownloads":0}""", "maxActiveDownloads", "maxActiveDownloads must be a whole number from 1 to 20")]
    [InlineData("""{"maxActiveDownloads":2.5}""", "maxActiveDownloads", "maxActiveDownloads must be a whole number from 1 to 20")]
    [InlineData("""{"maxActiveDownloads":"3"}""", "maxActiveDownloads", "maxActiveDownloads must be a whole number from 1 to 20")]
    public async Task RejectsMalformedFieldsBeforeMutation(string body, string field, string error)
    {
        var before = await Read(await _http.GetAsync("/api/settings/client"));
        var response = await _http.PutAsync("/api/settings/client", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var result = await Read(response);
        Assert.Equal(field, result.GetProperty("field").GetString());
        Assert.Equal(error, result.GetProperty("error").GetString());
        var after = await Read(await _http.GetAsync("/api/settings/client"));
        Assert.Equal(before.GetProperty("settings").GetProperty("clientType").GetString(), after.GetProperty("settings").GetProperty("clientType").GetString());
    }

    [Fact]
    public async Task MaxActiveDownloadsIsSavedAppliedAndClearable()
    {
        var limits = factory.Services.GetRequiredService<TorrentFlow.Engine.Queue.DownloadLimits>();
        try
        {
            var saved = (await Read(await _http.PutAsJsonAsync("/api/settings/client", new { maxActiveDownloads = 5 }))).GetProperty("settings");
            Assert.Equal(5, saved.GetProperty("maxActiveDownloads").GetInt32());
            Assert.Equal(5, limits.MaxActiveOverride);
            var read = (await Read(await _http.GetAsync("/api/settings/client"))).GetProperty("settings");
            Assert.Equal(5, read.GetProperty("maxActiveDownloads").GetInt32());

            var cleared = (await Read(await _http.PutAsJsonAsync("/api/settings/client", new { maxActiveDownloads = (int?)null }))).GetProperty("settings");
            Assert.Null(limits.MaxActiveOverride);
            Assert.Equal(cleared.GetProperty("maxActiveDownloadsDefault").GetInt32(), cleared.GetProperty("maxActiveDownloads").GetInt32());
        }
        finally
        {
            await _http.PutAsJsonAsync("/api/settings/client", new { maxActiveDownloads = (int?)null });
        }
    }

    [Fact]
    public async Task SupportsClearExternalNullDefaultsAndRetentionAliases()
    {
        var response = await _http.PutAsJsonAsync("/api/settings/client", new
        {
            clientType = "builtin", externalClientType = "none", preferredResolution = (int?)null,
            automationIntervalMinutes = (int?)null, defaultRetentionPolicy = "KEEP", host = "",
            categories = (object?)null, pathRules = (object?)null,
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var settings = (await Read(response)).GetProperty("settings");
        Assert.Equal(JsonValueKind.Null, settings.GetProperty("externalClientType").ValueKind);
        Assert.Equal(1080, settings.GetProperty("preferredResolution").GetInt32());
        Assert.Equal(0, settings.GetProperty("automationIntervalMinutes").GetInt32());
        Assert.Equal("KEPT", settings.GetProperty("defaultRetentionPolicy").GetString());
    }

    [Fact]
    public async Task SwitchingBackToBuiltinRetainsExternalConnection()
    {
        var response = await _http.PutAsJsonAsync("/api/settings/client", new { clientType = "qbittorrent", externalClientType = "none" });
        Assert.Equal("qbittorrent", (await Read(response)).GetProperty("settings").GetProperty("externalClientType").GetString());
        response = await _http.PutAsJsonAsync("/api/settings/client", new { switchToBuiltin = true });
        var settings = (await Read(response)).GetProperty("settings");
        Assert.Equal("builtin", settings.GetProperty("clientType").GetString());
        Assert.Equal("qbittorrent", settings.GetProperty("externalClientType").GetString());
    }

    [Fact]
    public async Task DisabledExternalClientsStayBuiltInAndRejectExternalRequests()
    {
        var handler = new ExternalHandler(_ => throw new InvalidOperationException("external client should not be contacted"));
        using var disabledFactory = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("TorrentFlow:ExternalClients:Enabled", "false");
            builder.UseSetting("TorrentFlow:Engine:RefreshTrackers", "false");
            builder.UseSetting("TorrentFlow:Engine:Streaming", "true");
            builder.ConfigureTestServices(services =>
            {
                services.AddHttpClient<QBittorrentClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
                services.AddHttpClient<TransmissionClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
            });
        });
        using var http = disabledFactory.CreateClient();

        await using (var scope = disabledFactory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
            await using var context = await db.CreateDbContextAsync();
            var row = await context.ClientSettings.SingleAsync();
            row.ClientType = "qbittorrent";
            row.ExternalClientType = "qbittorrent";
            row.Host = "http://client.invalid:9091";
            row.Username = "alice";
            row.Password = "enc:v1:ignored";
            await context.SaveChangesAsync();
        }

        var get = await Read(await http.GetAsync("/api/settings/client"));
        var settings = get.GetProperty("settings");
        Assert.False(settings.GetProperty("externalClientsEnabled").GetBoolean());
        Assert.Equal("builtin", settings.GetProperty("clientType").GetString());
        Assert.Equal(JsonValueKind.Null, settings.GetProperty("externalClientType").ValueKind);

        await using (var scope = disabledFactory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
            await using var context = await db.CreateDbContextAsync();
            var stored = await context.ClientSettings.AsNoTracking().SingleAsync();
            Assert.Equal("builtin", stored.ClientType);
            Assert.Equal("qbittorrent", stored.ExternalClientType);
        }

        var switchBad = await http.PutAsync("/api/settings/client", new StringContent("""{"clientType":"qbittorrent"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, switchBad.StatusCode);
        Assert.Contains("built-in downloader only", (await Read(switchBad)).GetProperty("error").GetString() ?? "");

        var testBad = await http.PutAsync("/api/settings/client", new StringContent("""{"test":true,"testTarget":"external"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, testBad.StatusCode);
        Assert.Contains("built-in downloader only", (await Read(testBad)).GetProperty("error").GetString() ?? "");

        var sendExternal = await http.PostAsJsonAsync("/api/torrent/send", new
        {
            magnet = EngineHarness.Magnet(990),
            target = "external",
        });
        Assert.Equal(HttpStatusCode.BadRequest, sendExternal.StatusCode);
        Assert.Equal("No external client", (await Read(sendExternal)).GetProperty("error").GetString());

        var torrents = await Read(await http.GetAsync("/api/client/torrents"));
        Assert.Equal("builtin", torrents.GetProperty("clientType").GetString());
        Assert.False(torrents.GetProperty("hasExternal").GetBoolean());
        Assert.Empty(handler.Requests);

        var configure = await http.PutAsJsonAsync("/api/settings/client", new
        {
            baseDownloadPath = Path.Combine(factory.Root, "downloads"),
            maxStorageBytes = 1L << 40,
        });
        Assert.Equal(HttpStatusCode.OK, configure.StatusCode);
        var send = await http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(991) });
        Assert.Equal(HttpStatusCode.OK, send.StatusCode);
        var remove = await http.PostAsJsonAsync("/api/client/torrents", new
        {
            action = "delete",
            hash = EngineHarness.Hash(991),
            ownerClientType = "builtin",
        });
        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
        Assert.DoesNotContain("Could not verify whether another configured client still uses these files", await remove.Content.ReadAsStringAsync());

        foreach (var n in new[] { 992, 993 })
            Assert.Equal(HttpStatusCode.OK, (await http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(n) })).StatusCode);
        var removeMany = await http.PostAsJsonAsync("/api/client/torrents", new
        {
            action = "delete",
            hashes = new[] { EngineHarness.Hash(992), EngineHarness.Hash(993), EngineHarness.Hash(994) },
            ownerClientType = "builtin",
        });
        var many = await Read(removeMany);
        Assert.Equal(HttpStatusCode.BadGateway, removeMany.StatusCode);
        Assert.Equal([true, true, false], many.GetProperty("results").EnumerateArray().Select(r => r.GetProperty("ok").GetBoolean()));
        Assert.Equal("1 of 3 could not be removed.", many.GetProperty("message").GetString());
        var badMany = await http.PostAsJsonAsync("/api/client/torrents", new { action = "pause", hashes = new[] { EngineHarness.Hash(992) }, ownerClientType = "builtin" });
        Assert.Equal(HttpStatusCode.BadRequest, badMany.StatusCode);
    }

    [Fact]
    public async Task InventoryCountsAllocatedBytesAndProtectsUnverifiedTrackedFiles()
    {
        var root = Path.Combine(factory.Root, "tracked-inventory");
        Directory.CreateDirectory(Path.Combine(root, "Incomplete"));
        var file = Path.Combine(root, "Incomplete", "payload.txt");
        await File.WriteAllBytesAsync(file, new byte[100]);
        var factoryDb = factory.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        await using var db = await factoryDb.CreateDbContextAsync();
        var row = new EngineTorrent
        {
            Id = Ids.New(), UserId = LocalUser.Id, Hash = EngineHarness.Hash(990), Name = "Incomplete", SavePath = root,
            Status = "paused", Origin = "user", SizeBytes = 100, Progress = 0.25, CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow,
        };
        db.EngineTorrents.Add(row);
        await db.SaveChangesAsync();
        try
        {
            var response = await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = root });
            var usage = (await Read(response)).GetProperty("settings").GetProperty("storageUsage");
            Assert.Equal(100, usage.GetProperty("keptBytes").GetInt64());
            Assert.Equal(100, usage.GetProperty("disk").GetProperty("trackedBytes").GetInt64());
            Assert.Empty(usage.GetProperty("orphans").EnumerateArray());
            var item = Assert.Single(usage.GetProperty("items").EnumerateArray());
            Assert.Equal("KEPT", item.GetProperty("retentionPolicy").GetString());
            Assert.Equal(100, item.GetProperty("sizeBytes").GetInt64());
            Assert.Equal(JsonValueKind.Null, item.GetProperty("category").ValueKind);
            response = await _http.PostAsJsonAsync("/api/settings/untracked-files", new { relativePath = "Incomplete/payload.txt" });
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            Assert.True(File.Exists(file));
        }
        finally
        {
            db.EngineTorrents.Remove(row);
            await db.SaveChangesAsync();
        }
    }

    [Fact]
    public async Task InventoryReportsRealUntrackedFilesAndUnavailableRoots()
    {
        var root = Path.Combine(factory.Root, "inventory");
        Directory.CreateDirectory(Path.Combine(root, "Movies", "Legal fixture"));
        Directory.CreateDirectory(Path.Combine(root, ".state"));
        await File.WriteAllBytesAsync(Path.Combine(root, "Movies", "Legal fixture", "sample.txt"), new byte[123]);
        await File.WriteAllBytesAsync(Path.Combine(root, ".state", "state.txt"), new byte[10]);
        var response = await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = root, maxStorageGb = 100 });
        var usage = (await Read(response)).GetProperty("settings").GetProperty("storageUsage");
        Assert.Equal(133, usage.GetProperty("diskBytes").GetInt64());
        Assert.Equal(123, usage.GetProperty("orphanBytes").GetInt64());
        Assert.Equal(10, usage.GetProperty("disk").GetProperty("internalBytes").GetInt64());
        Assert.Equal(21_474_836_480, usage.GetProperty("budgetBytes").GetInt64());
        Assert.Equal(21_600_000, usage.GetProperty("graceMs").GetInt64());
        var orphan = Assert.Single(usage.GetProperty("orphans").EnumerateArray());
        Assert.Equal("Movies/Legal fixture", orphan.GetProperty("relativePath").GetString());
        Assert.True(orphan.GetProperty("folderDeletable").GetBoolean());
        Assert.Equal(123, Assert.Single(orphan.GetProperty("files").EnumerateArray()).GetProperty("bytes").GetInt64());
        var delete = await _http.PostAsJsonAsync("/api/settings/untracked-files", new { relativePath = "Movies/Legal fixture" });
        Assert.Equal(HttpStatusCode.OK, delete.StatusCode);
        var afterDelete = (await Read(delete)).GetProperty("usage");
        Assert.Equal(10, afterDelete.GetProperty("diskBytes").GetInt64());
        Assert.Empty(afterDelete.GetProperty("items").EnumerateArray());
        Assert.Empty(afterDelete.GetProperty("orphans").EnumerateArray());
        Assert.False(Directory.Exists(Path.Combine(root, "Movies", "Legal fixture")));
        var internalDelete = await _http.PostAsJsonAsync("/api/settings/untracked-files", new { relativePath = ".state/state.txt" });
        Assert.Equal(HttpStatusCode.Forbidden, internalDelete.StatusCode);
        response = await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = Path.Combine(root, "missing") });
        usage = (await Read(response)).GetProperty("settings").GetProperty("storageUsage");
        Assert.Equal(JsonValueKind.Null, usage.GetProperty("diskBytes").ValueKind);
        Assert.False(usage.GetProperty("disk").GetProperty("authoritative").GetBoolean());
        Assert.Equal("unavailable", usage.GetProperty("disk").GetProperty("status").GetString());
    }

    [Fact]
    public async Task BrowseDriveRootReturnsDriveListParent()
    {
        if (!OperatingSystem.IsWindows()) return;
        var result = await Read(await _http.GetAsync("/api/settings/browse-folders?path=" + Uri.EscapeDataString(Path.GetPathRoot(factory.Root)!)));
        Assert.Equal("", result.GetProperty("parent").GetString());
    }

    [Fact]
    public async Task BrowseUsesCaseInsensitiveLocaleOrdering()
    {
        var root = Path.Combine(factory.Root, "sorted");
        foreach (var name in new[] { "$release", ".hidden", "alpha", "Zulu" }) Directory.CreateDirectory(Path.Combine(root, name));
        var result = await Read(await _http.GetAsync("/api/settings/browse-folders?path=" + Uri.EscapeDataString(root)));
        Assert.Equal(new[] { ".hidden", "$release", "alpha", "Zulu" },
            result.GetProperty("entries").EnumerateArray().Select(e => e.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task BuiltinListDoesNotAdvertiseAnExternalHost()
    {
        await _http.PutAsJsonAsync("/api/settings/client", new { clientType = "builtin" });
        var result = await Read(await _http.GetAsync("/api/client/torrents"));
        Assert.Equal("", result.GetProperty("host").GetString());
    }

    [Fact]
    public async Task SweepDefaultsToPreviewAndReturnsCompleteUsage()
    {
        var root = Path.Combine(factory.Root, "sweep");
        Directory.CreateDirectory(root);
        await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = root, maxStorageGb = 100 });
        var response = await _http.PostAsJsonAsync("/api/settings/retention-sweep", new { });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await Read(response);
        Assert.Equal("preview", result.GetProperty("result").GetProperty("mode").GetString());
        Assert.Empty(result.GetProperty("usage").GetProperty("items").EnumerateArray());
        Assert.Equal(21_474_836_480, result.GetProperty("usage").GetProperty("budgetBytes").GetInt64());
    }

    [Fact]
    public async Task PathWarningsMatchDisposablePathReasons()
    {
        var root = Path.Combine(factory.Root, "playwright-report", "node_modules", "tmp");
        var response = await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = root });
        var warning = (await Read(response)).GetProperty("settings").GetProperty("pathWarnings")[0];
        var reasons = warning.GetProperty("reasons").EnumerateArray().Select(r => r.GetString()).ToList();
        Assert.Contains("test-directory", reasons);
        Assert.Contains("dependencies", reasons);
        Assert.Contains("temporary-directory", reasons);
        Assert.Contains("Choose a permanent media folder", warning.GetProperty("message").GetString());
    }

    [Fact]
    public async Task OpenFolderAcceptsFilesAndMissingChildrenWithoutRevealing()
    {
        var root = Path.Combine(factory.Root, "open");
        Directory.CreateDirectory(root);
        await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = root });
        var file = Path.Combine(root, "file.txt");
        await File.WriteAllTextAsync(file, "test");
        foreach (var path in new[] { file, Path.Combine(root, "not-created-yet") })
        {
            var response = await _http.PostAsJsonAsync("/api/settings/open-folder", new { path, reveal = false });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var result = await Read(response);
            Assert.Equal(path, result.GetProperty("path").GetString());
            Assert.False(result.GetProperty("revealed").GetBoolean());
        }
    }
}
