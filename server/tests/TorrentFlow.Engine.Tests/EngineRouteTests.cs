using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Engine.Client;

namespace TorrentFlow.Engine.Tests;

public sealed class ApiFactory : WebApplicationFactory<Program>
{
    public string Root { get; } = EngineHarness.NewRoot();
    internal FakeBackend Backend { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:Engine:MaxActiveDownloads", "1");
        builder.ConfigureTestServices(s =>
        {
            s.RemoveAll<ITorrentBackend>();
            s.AddSingleton<ITorrentBackend>(Backend);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public class EngineRouteTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private readonly HttpClient _http = factory.CreateClient();

    private async Task<JsonElement> Json(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    private async Task ConfigureStorageAsync()
    {
        var put = await _http.PutAsJsonAsync("/api/settings/client", new
        {
            baseDownloadPath = Path.Combine(factory.Root, "downloads"),
            maxStorageBytes = 1L << 40,
        });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
    }

    [Fact]
    public async Task SettingsRoundTrip()
    {
        var path = Path.Combine(factory.Root, "downloads");
        var put = await _http.PutAsJsonAsync("/api/settings/client", new { baseDownloadPath = path, maxStorageBytes = 123_000_000_000L });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var get = await Json(await _http.GetAsync("/api/settings/client"));
        var settings = get.TryGetProperty("settings", out var s) ? s : get;
        Assert.Equal(path, settings.GetProperty("baseDownloadPath").GetString());
        Assert.Equal(123_000_000_000L, settings.GetProperty("maxStorageBytes").GetInt64());
        Assert.Equal("builtin", settings.GetProperty("clientType").GetString());
    }

    [Fact]
    public async Task SendValidatesInput()
    {
        var r = await _http.PostAsJsonAsync("/api/torrent/send", new { });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.False((await Json(r)).TryGetProperty("ok", out var ok) && ok.GetBoolean());
    }

    [Fact]
    public async Task SendQueuesThenListAndForceShapes()
    {
        await ConfigureStorageAsync();
        var a = await Json(await _http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(101), queueKey = "s00001e00001" }));
        Assert.True(a.GetProperty("ok").GetBoolean());
        var b = await Json(await _http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(102), queueKey = "s00001e00002" }));
        Assert.True(b.GetProperty("ok").GetBoolean());
        Assert.Equal("builtin-transfer", b.GetProperty("details").GetProperty("type").GetString());
        Assert.Equal("queued", b.GetProperty("details").GetProperty("action").GetString());

        var list = await Json(await _http.GetAsync("/api/client/torrents"));
        Assert.Equal("builtin", list.GetProperty("clientType").GetString());
        Assert.Equal(JsonValueKind.Null, list.GetProperty("externalClientType").ValueKind);
        var torrents = list.GetProperty("torrents").EnumerateArray().ToList();
        var queued = torrents.Single(t => t.GetProperty("hash").GetString() == EngineHarness.Hash(102));
        Assert.Equal("queued", queued.GetProperty("state").GetString());
        Assert.Equal(1, queued.GetProperty("queuePosition").GetInt32());
        foreach (var field in new[] { "name", "progress", "sizeBytes", "dlspeed", "upspeed", "state", "retentionState" })
            Assert.True(queued.TryGetProperty(field, out _), field);
        Assert.Equal("builtin", queued.GetProperty("ownerClientType").GetString());
        Assert.Equal("Built-in", queued.GetProperty("ownerClientLabel").GetString());
        Assert.Equal("builtin:" + EngineHarness.Hash(102), queued.GetProperty("transferId").GetString());

        var force = await _http.PostAsJsonAsync("/api/client/torrents", new { action = "force", hash = EngineHarness.Hash(102), ownerClientType = "builtin" });
        Assert.Equal(HttpStatusCode.OK, force.StatusCode);
        var forced = await Json(force);
        Assert.True(forced.GetProperty("ok").GetBoolean());
        Assert.Equal(EngineHarness.Hash(102), forced.GetProperty("torrent").GetProperty("hash").GetString());
        Assert.NotEqual("queued", forced.GetProperty("torrent").GetProperty("state").GetString());
        Assert.Equal("builtin", forced.GetProperty("torrent").GetProperty("ownerClientType").GetString());
        Assert.Equal("Built-in", forced.GetProperty("torrent").GetProperty("ownerClientLabel").GetString());
        Assert.Equal("builtin:" + EngineHarness.Hash(102), forced.GetProperty("torrent").GetProperty("transferId").GetString());
        Assert.True(factory.Backend.Contains(EngineHarness.Hash(102)));
    }

    [Fact]
    public async Task UntrackedDeleteRefusesToFollowAJunctionUnderTheRoot()
    {
        await ConfigureStorageAsync();
        var downloads = Path.Combine(factory.Root, "downloads");
        var outside = Path.Combine(factory.Root, "outside-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(downloads);
        Directory.CreateDirectory(outside);
        var victim = Path.Combine(outside, "victim.txt");
        await File.WriteAllTextAsync(victim, "keep me");
        var link = Path.Combine(downloads, "link-" + Guid.NewGuid().ToString("N"));
        if (!TryCreateDirectoryLink(link, outside)) return;   // links unsupported here: nothing to test
        try
        {
            var r = await _http.PostAsJsonAsync("/api/settings/untracked-files", new { relativePath = Path.GetFileName(link) + "/victim.txt" });
            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.Equal("symlink", (await Json(r)).GetProperty("reason").GetString());
            Assert.True(File.Exists(victim));
        }
        finally
        {
            try { Directory.Delete(link); } catch (IOException) { }
        }
    }

    private static bool TryCreateDirectoryLink(string link, string target)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                // A junction needs no elevation, unlike a symlink.
                using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                })!;
                p.WaitForExit(10_000);
            }
            else
            {
                Directory.CreateSymbolicLink(link, target);
            }
            return Directory.Exists(link) && new DirectoryInfo(link).Attributes.HasFlag(FileAttributes.ReparsePoint);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    [Fact]
    public async Task UnknownActionAndMissingHashAreRejected()
    {
        var bad = await _http.PostAsJsonAsync("/api/client/torrents", new { action = "explode", hash = "abc", ownerClientType = "builtin" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var missing = await _http.PostAsJsonAsync("/api/client/torrents", new { action = "pause", hash = new string('f', 40), ownerClientType = "builtin" });
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.False((await Json(missing)).GetProperty("ok").GetBoolean());
        var noOwner = await _http.PostAsJsonAsync("/api/client/torrents", new { action = "pause", hash = "abc" });
        Assert.Equal("action, hash and ownerClientType required", (await Json(noOwner)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task BrowseFoldersListsDirectories()
    {
        Directory.CreateDirectory(Path.Combine(factory.Root, "browse", "child"));
        var r = await _http.GetAsync("/api/settings/browse-folders?path=" + Uri.EscapeDataString(Path.Combine(factory.Root, "browse")));
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("child", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task HealthReportsEnginePressure()
    {
        var r = await _http.GetAsync("/api/diagnostics/health");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("enginePressure", await r.Content.ReadAsStringAsync());
    }
}
