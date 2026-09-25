using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Clients.External;

namespace TorrentFlow.Engine.Tests;

internal sealed class ExternalRouteHarness : IDisposable
{
    public ApiFactory Factory { get; } = new();
    private readonly WebApplicationFactory<Program> _app;
    public HttpClient Http { get; }
    public ExternalHandler Handler { get; }
    public string Hash { get; } = EngineHarness.Hash(1200);
    public string? SavePath { get; set; } = @"D:\Remote\TV";
    public bool Present { get; set; } = true;
    public bool Offline { get; set; }
    public bool LoginFailure { get; set; }
    public bool ActionFailure { get; set; }
    public bool IgnoreDelete { get; set; }
    public string State { get; private set; } = "downloading";
    public string? ExpectedPassword { get; set; }
    public string? LastAction { get; private set; }

    public ExternalRouteHarness()
    {
        Handler = new ExternalHandler(Respond);
        _app = Factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("TorrentFlow:ExternalClients:Enabled", "true");
            b.UseSetting("TorrentFlow:Engine:RefreshTrackers", "false");
            b.ConfigureTestServices(s =>
            {
                s.AddHttpClient<QBittorrentClient>().ConfigurePrimaryHttpMessageHandler(() => Handler);
                s.AddHttpClient<TransmissionClient>().ConfigurePrimaryHttpMessageHandler(() => Handler);
            });
        });
        Http = _app.CreateClient();
    }

    private HttpResponseMessage Respond(ExternalRequest request)
    {
        if (Offline) throw new HttpRequestException("ECONNREFUSED");
        if (request.Url.EndsWith("/auth/login", StringComparison.Ordinal))
        {
            if (LoginFailure) return ExternalHandler.Response("Fails.", HttpStatusCode.Unauthorized);
            return ExternalHandler.Login();
        }
        if (request.Url.EndsWith("/app/version", StringComparison.Ordinal)) return ExternalHandler.Response("v5.0.3");
        if (request.Url.EndsWith("/torrents/info", StringComparison.Ordinal))
            return ExternalHandler.Response(JsonSerializer.Serialize(Present ? new object[]
            {
                new { hash = Hash.ToUpperInvariant(), name = "Show", progress = 0.5, size = 1000, dlspeed = 200, upspeed = 10,
                    state = State, eta = 30, num_seeds = 3, num_leechs = 2, category = "TV", save_path = SavePath },
            } : []));
        if (request.Url.EndsWith("/transmission/rpc", StringComparison.Ordinal))
        {
            if (ExpectedPassword is not null)
                Assert.Equal("Basic " + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("alice:" + ExpectedPassword)), request.Headers["Authorization"]);
            if (LoginFailure) return ExternalHandler.Response("", HttpStatusCode.Unauthorized);
            if (!request.Headers.ContainsKey("X-Transmission-Session-Id"))
                return ExternalHandler.Response("", HttpStatusCode.Conflict, "X-Transmission-Session-Id", "session");
            using var document = JsonDocument.Parse(request.Body);
            var method = document.RootElement.GetProperty("method").GetString();
            if (method == "session-get") return ExternalHandler.Response("""{"result":"success","arguments":{"version":"4.0.6"}}""");
            if (method == "torrent-get")
                return ExternalHandler.Response(JsonSerializer.Serialize(new
                {
                    result = "success",
                    arguments = new
                    {
                        torrents = Present ? new object[] {
                            new { hashString = Hash.ToUpperInvariant(), name = "Show", percentDone = 0.5, totalSize = 1000,
                                rateDownload = 200, rateUpload = 10, status = State == "stopped" ? 0 : 4, eta = 30, labels = new[] { "TV" }, downloadDir = SavePath },
                        } : [],
                    },
                }));
            LastAction = method;
            if (ActionFailure) return ExternalHandler.Response("""{"result":"permission denied"}""");
            if (method == "torrent-stop") State = "stopped";
            if (method == "torrent-start") State = "downloading";
            if (method == "torrent-remove" && !IgnoreDelete) Present = false;
            if (method == "torrent-add") Present = true;
            return ExternalHandler.Response("""{"result":"success","arguments":{}}""");
        }
        LastAction = request.Url.Split('/').Last();
        if (ActionFailure) return ExternalHandler.Response("Fails.", HttpStatusCode.InternalServerError);
        if (LastAction == "pause") State = "pausedDL";
        if (LastAction == "resume") State = "downloading";
        if (LastAction == "delete" && !IgnoreDelete) Present = false;
        if (LastAction == "add") Present = true;
        return ExternalHandler.Response("Ok.");
    }

    public async Task<JsonElement> ConfigureAsync(string type, bool preferred = true, bool test = false)
    {
        using var response = await Http.PutAsJsonAsync("/api/settings/client", new
        {
            clientType = preferred ? type : "builtin", externalClientType = type, host = "http://client.invalid:9091",
            username = "alice", password = ExpectedPassword ?? "secret", test, testTarget = preferred ? "primary" : "external",
            baseDownloadPath = Path.Combine(Factory.Root, "downloads"), maxStorageBytes = 1L << 40,
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    public Task<HttpResponseMessage> ActAsync(string type, string action, bool deleteFiles = false, string? hash = null) =>
        Http.PostAsJsonAsync("/api/client/torrents", new { ownerClientType = type, action, hash = hash ?? Hash, deleteFiles });

    public static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.Clone();
    }

    public IServiceProvider Services => _app.Services;

    public void Dispose()
    {
        Http.Dispose();
        _app.Dispose();
        Factory.Dispose();
    }
}

public class ExternalRouteTests
{
    [Theory]
    [InlineData("qbittorrent", "qBittorrent", "Connected to qBittorrent v5.0.3")]
    [InlineData("transmission", "Transmission", "Connected to Transmission 4.0.6")]
    public async Task SelectTestSaveCredentialsSwitchAndPreserveOwnership(string type, string label, string connected)
    {
        using var h = new ExternalRouteHarness { ExpectedPassword = "secret-value" };
        var settings = await h.ConfigureAsync(type, test: true);
        Assert.Equal(connected, settings.GetProperty("testResult").GetProperty("message").GetString());
        Assert.True(settings.GetProperty("settings").GetProperty("hasPassword").GetBoolean());
        Assert.DoesNotContain("secret-value", settings.GetRawText());
        await using (var scope = h.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
            var stored = await db.ClientSettings.SingleAsync();
            Assert.StartsWith("enc:v1:", stored.Password);
            Assert.DoesNotContain("secret-value", stored.Password!);
        }
        var switched = await ExternalRouteHarness.Json(await h.Http.PutAsJsonAsync("/api/settings/client", new { switchToBuiltin = true }));
        Assert.Equal(type, switched.GetProperty("settings").GetProperty("externalClientType").GetString());
        var list = await ExternalRouteHarness.Json(await h.Http.GetAsync("/api/client/torrents"));
        Assert.Equal("", list.GetProperty("host").GetString());
        Assert.Equal("builtin", list.GetProperty("clientType").GetString());
        Assert.True(list.GetProperty("hasExternal").GetBoolean());
        Assert.False(list.GetProperty("partial").GetBoolean());
        var torrent = Assert.Single(list.GetProperty("torrents").EnumerateArray());
        Assert.Equal(type, torrent.GetProperty("ownerClientType").GetString());
        Assert.Equal(label, torrent.GetProperty("ownerClientLabel").GetString());
        Assert.Equal(type + ":" + h.Hash, torrent.GetProperty("transferId").GetString());
        Assert.Equal(0.5, torrent.GetProperty("progress").GetDouble());
        Assert.Equal(h.SavePath, torrent.GetProperty("savePath").GetString());
        Assert.False(torrent.TryGetProperty("retentionState", out _));
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "pause")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "resume")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await h.ActAsync(type, "force")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await h.ActAsync(type, "pause", hash: "unknown")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "delete")).StatusCode);
        list = await ExternalRouteHarness.Json(await h.Http.GetAsync("/api/client/torrents"));
        Assert.Empty(list.GetProperty("torrents").EnumerateArray());
    }

    [Theory]
    [InlineData("qbittorrent", true)]
    [InlineData("transmission", true)]
    [InlineData("qbittorrent", false)]
    [InlineData("transmission", false)]
    public async Task SendUsesSelectedTargetAndAdapterShape(string type, bool primary)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type, preferred: primary);
        var target = primary ? "primary" : "external";
        using var response = await h.Http.PostAsJsonAsync("/api/torrent/send", new
        {
            magnet = EngineHarness.Magnet(1200), target, category = "TV", categoryManual = true,
            savePath = @"D:\Remote\Show\Season 01", retention = "stream",
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var sent = await ExternalRouteHarness.Json(response);
        Assert.True(sent.GetProperty("ok").GetBoolean());
        Assert.False(sent.GetProperty("offline").GetBoolean());
        Assert.Equal(type, sent.GetProperty("clientType").GetString());
        Assert.Equal(target, sent.GetProperty("sendTarget").GetString());
        Assert.Equal("TV", sent.GetProperty("target").GetProperty("category").GetString());
        Assert.Equal(@"D:\Remote\Show\Season 01", sent.GetProperty("target").GetProperty("savePath").GetString());
        Assert.Equal("stream", sent.GetProperty("retentionState").GetString());
        Assert.True(sent.GetProperty("streamDegraded").GetBoolean());
        Assert.Empty(h.Factory.Backend.AddLog);
        await using var scope = h.Services.CreateAsyncScope();
        var history = await scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>().DownloadHistories.SingleAsync();
        Assert.Equal("sent", history.Status);
        Assert.Equal(type, history.ClientType);
        Assert.Equal("keep", history.Retention);
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task BothOwnersOfSameHashRemainSeparateAndActionsDoNotFollowPreference(string type)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type, preferred: false);
        var added = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200) });
        Assert.Equal(HttpStatusCode.OK, added.StatusCode);
        await h.Http.PutAsJsonAsync("/api/settings/client", new { clientType = type });
        var list = await ExternalRouteHarness.Json(await h.Http.GetAsync("/api/client/torrents"));
        Assert.Equal(2, list.GetProperty("torrents").GetArrayLength());
        Assert.Equal(2, list.GetProperty("torrents").EnumerateArray().Select(t => t.GetProperty("transferId").GetString()).Distinct().Count());
        Assert.True(h.Factory.Backend.Contains(h.Hash));
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "pause")).StatusCode);
        Assert.NotEqual("paused", h.Factory.Backend.Get(h.Hash)!.State);
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync("builtin", "pause")).StatusCode);
        Assert.Equal("paused", h.Factory.Backend.Get(h.Hash)!.State);
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "delete")).StatusCode);
        Assert.True(h.Factory.Backend.Contains(h.Hash));
    }

    [Theory]
    [InlineData("qbittorrent", "builtin")]
    [InlineData("qbittorrent", "qbittorrent")]
    [InlineData("transmission", "builtin")]
    [InlineData("transmission", "transmission")]
    public async Task DeleteFilesProtectsOverlappingOwners(string type, string owner)
    {
        using var h = new ExternalRouteHarness();
        h.SavePath = Path.Combine(h.Factory.Root, "downloads");
        await h.ConfigureAsync(type, preferred: false);
        await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200) });
        var result = await h.ActAsync(owner, "delete", deleteFiles: true);
        Assert.Equal(HttpStatusCode.Conflict, result.StatusCode);
        Assert.Equal("Another torrent client still uses the same files. Remove only this transfer or delete the other copy first.",
            (await ExternalRouteHarness.Json(result)).GetProperty("message").GetString());
        Assert.True(h.Present);
        Assert.True(h.Factory.Backend.Contains(h.Hash));
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task DeleteMustBeConfirmedByOwner(string type)
    {
        using var h = new ExternalRouteHarness { IgnoreDelete = true };
        await h.ConfigureAsync(type);
        var result = await h.ActAsync(type, "delete");
        Assert.Equal(HttpStatusCode.BadGateway, result.StatusCode);
        var body = await ExternalRouteHarness.Json(result);
        Assert.False(body.GetProperty("ok").GetBoolean());
        Assert.Equal("Torrent action failed.", body.GetProperty("message").GetString());
        Assert.False(body.TryGetProperty("detail", out _));
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task OfflineIsPartialForList503ForSendAndControlAndBlocksSharedDelete(string type)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type, preferred: false);
        await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200) });
        h.Offline = true;
        var list = await ExternalRouteHarness.Json(await h.Http.GetAsync("/api/client/torrents"));
        Assert.True(list.GetProperty("partial").GetBoolean());
        Assert.False(list.GetProperty("offline").GetBoolean());
        Assert.Single(list.GetProperty("torrents").EnumerateArray());
        var issue = Assert.Single(list.GetProperty("clientIssues").EnumerateArray());
        Assert.True(issue.GetProperty("offline").GetBoolean());
        Assert.Equal(type, issue.GetProperty("clientType").GetString());
        var action = await h.ActAsync(type, "pause");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, action.StatusCode);
        Assert.True((await ExternalRouteHarness.Json(action)).GetProperty("offline").GetBoolean());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await h.ActAsync("builtin", "delete", deleteFiles: true)).StatusCode);
        Assert.True(h.Factory.Backend.Contains(h.Hash));
        var send = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200), target = "external" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, send.StatusCode);
        Assert.True((await ExternalRouteHarness.Json(send)).GetProperty("offline").GetBoolean());
    }

    [Theory]
    [InlineData("qbittorrent", "qBittorrent login failed — check username/password in Settings.")]
    [InlineData("transmission", "Transmission RPC HTTP 401")]
    public async Task AuthenticationFailureIsNotOffline(string type, string message)
    {
        using var h = new ExternalRouteHarness { LoginFailure = true };
        var configured = await h.ConfigureAsync(type, test: true);
        var action = await h.ActAsync(type, "pause");
        Assert.Equal(HttpStatusCode.BadGateway, action.StatusCode);
        var body = await ExternalRouteHarness.Json(action);
        Assert.Equal(message, body.GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task UnconfiguredOwnerNeverReceivesCommands(string type)
    {
        using var h = new ExternalRouteHarness();
        var result = await h.ActAsync(type, "pause");
        Assert.Equal(HttpStatusCode.NotFound, result.StatusCode);
        Assert.Empty(h.Handler.Requests);
        var send = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200), target = "external" });
        Assert.Equal(HttpStatusCode.BadRequest, send.StatusCode);
        Assert.Equal("No external client", (await ExternalRouteHarness.Json(send)).GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task NullSavePathAndInvalidSourceRemainHonest(string type)
    {
        using var h = new ExternalRouteHarness { SavePath = null };
        await h.ConfigureAsync(type);
        var list = await ExternalRouteHarness.Json(await h.Http.GetAsync("/api/client/torrents"));
        Assert.Equal(JsonValueKind.Null, list.GetProperty("torrents")[0].GetProperty("savePath").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/torrent/send", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = "bad" })).StatusCode);
    }

    [Theory]
    [InlineData("qbittorrent", false)]
    [InlineData("transmission", false)]
    [InlineData("qbittorrent", true)]
    [InlineData("transmission", true)]
    public async Task ConfirmedFileDeletionClearsRememberedRowsOnlyWhenFilesWereDeleted(string type, bool deleteFiles)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type);
        await using var scope = h.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        db.GrabJobs.Add(new GrabJob { Id = Ids.New(), UserId = LocalUser.Id, Title = "Show", Query = "Show", Status = "sent", InfoHash = h.Hash.ToUpperInvariant() });
        db.AcquisitionTargets.Add(new AcquisitionTarget
        {
            Id = Ids.New(), UserId = LocalUser.Id, WorkKey = "show", TargetKey = "show:episode:1:1", Scope = "episode",
            Status = "downloading", InfoHash = h.Hash,
        });
        db.PlaybackProgresses.Add(new PlaybackProgress { Id = Ids.New(), UserId = LocalUser.Id, Title = "Show", FilePath = "Show.mkv", InfoHash = h.Hash });
        await db.SaveChangesAsync();
        Assert.Equal(HttpStatusCode.OK, (await h.ActAsync(type, "delete", deleteFiles)).StatusCode);
        Assert.Equal(deleteFiles ? 0 : 1, await db.GrabJobs.CountAsync());
        Assert.Equal(deleteFiles ? 0 : 1, await db.AcquisitionTargets.CountAsync());
        Assert.Equal(deleteFiles ? 0 : 1, await db.PlaybackProgresses.CountAsync());
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task ExternalSendCannotBypassStorageSetupOrCap(string type)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type);
        await h.Http.PutAsJsonAsync("/api/settings/client", new { maxStorageBytes = 1 });
        using var response = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200), retention = "keep" });
        Assert.Equal((HttpStatusCode)507, response.StatusCode);
        var body = await ExternalRouteHarness.Json(response);
        Assert.Equal("cap", body.GetProperty("storage").GetProperty("limit").GetString());
        Assert.True(body.GetProperty("storage").GetProperty("overridable").GetBoolean());
        Assert.Empty(h.Handler.Requests);
        await using var scope = h.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        Assert.Equal("failed", (await db.DownloadHistories.SingleAsync()).Status);
        Assert.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync("/api/torrent/send", new
        {
            magnet = EngineHarness.Magnet(1200), retention = "keep", overrideStorageCap = true,
        })).StatusCode);
        await h.Http.PutAsJsonAsync("/api/settings/client", new { maxStorageBytes = (long?)null });
        using var missing = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200), overrideStorageCap = true });
        Assert.Equal((HttpStatusCode)507, missing.StatusCode);
        Assert.Equal("setup", (await ExternalRouteHarness.Json(missing)).GetProperty("storage").GetProperty("limit").GetString());
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task RemoteActionFailuresAre502WithGenericMessage(string type)
    {
        using var h = new ExternalRouteHarness { ActionFailure = true };
        await h.ConfigureAsync(type);
        var action = await h.ActAsync(type, "pause");
        Assert.Equal(HttpStatusCode.BadGateway, action.StatusCode);
        var body = await ExternalRouteHarness.Json(action);
        Assert.False(body.GetProperty("ok").GetBoolean());
        Assert.False(body.GetProperty("offline").GetBoolean());
        Assert.Equal("Torrent action failed.", body.GetProperty("message").GetString());
        var send = await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200) });
        Assert.Equal(HttpStatusCode.BadGateway, send.StatusCode);
        Assert.False((await ExternalRouteHarness.Json(send)).GetProperty("offline").GetBoolean());
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task RetentionOnlyExternalSendDoesNotChangeBuiltinOwner(string type)
    {
        using var h = new ExternalRouteHarness();
        await h.ConfigureAsync(type, preferred: false);
        await h.Http.PostAsJsonAsync("/api/torrent/send", new { magnet = EngineHarness.Magnet(1200) });
        var response = await h.Http.PostAsJsonAsync("/api/torrent/send", new { infoHash = h.Hash, retention = "stream", target = "external" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("kept", (await ExternalRouteHarness.Json(response)).GetProperty("retentionState").GetString());
        Assert.Empty(h.Handler.Requests);
        await using var scope = h.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        Assert.Equal("user", (await db.EngineTorrents.SingleAsync()).Origin);
    }
}
