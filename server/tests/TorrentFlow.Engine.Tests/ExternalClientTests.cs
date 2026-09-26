using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Tests;

internal sealed record ExternalRequest(string Url, string Method, string Body, IReadOnlyDictionary<string, string> Headers);

internal sealed class ExternalHandler(Func<ExternalRequest, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<ExternalRequest> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var snapshot = new ExternalRequest(request.RequestUri!.AbsoluteUri, request.Method.Method,
            request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct),
            request.Headers.ToDictionary(h => h.Key, h => string.Join(", ", h.Value), StringComparer.OrdinalIgnoreCase));
        Requests.Add(snapshot);
        return respond(snapshot);
    }

    public static HttpResponseMessage Response(string content, HttpStatusCode status = HttpStatusCode.OK, string? header = null, string? value = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(content, Encoding.UTF8, "application/json") };
        if (header is not null) response.Headers.TryAddWithoutValidation(header, value);
        return response;
    }

    public static HttpResponseMessage Login(string sid = "session") =>
        Response("Ok.", header: "Set-Cookie", value: $"other=1; Path=/, SID={sid}; HttpOnly; Path=/");
}

public class ExternalClientTests
{
    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task ImportListingRetainsOriginalMagnetAndNeverChangesTorrentState(string type)
    {
        var magnet = EngineHarness.Magnet(97) + "&tr=" + Uri.EscapeDataString("https://private.example/fixture");
        var row = type == "qbittorrent"
            ? JsonSerializer.Serialize(new[] { new { hash = EngineHarness.Hash(97), name = "Fixture", progress = 0.1, size = 10, dlspeed = 0, upspeed = 0, state = "downloading", magnet_uri = magnet } })
            : JsonSerializer.Serialize(new { result = "success", arguments = new { torrents = new[] {
                new { hashString = EngineHarness.Hash(97), name = "Fixture", percentDone = 0.1, totalSize = 10, rateDownload = 0, rateUpload = 0, status = 4, magnetLink = magnet } } } });
        using var handler = new ExternalHandler(request => request.Url.EndsWith("/auth/login")
            ? ExternalHandler.Login() : ExternalHandler.Response(row));
        using var http = new HttpClient(handler);
        IExternalTorrentClient client = type == "qbittorrent" ? new QBittorrentClient(http) : new TransmissionClient(http);
        Assert.Equal(magnet, (await client.ListAsync(Config(type))).Single().Magnet);
        Assert.All(handler.Requests, r => Assert.True(r.Url.EndsWith("/auth/login") || r.Url.EndsWith("/torrents/info")
            || r.Body.Contains("\"method\":\"torrent-get\"")));
    }

    internal const string TransmissionRows = """
        {"result":"success","arguments":{"torrents":[
          {"hashString":"abc","name":"Show","percentDone":0.5,"totalSize":1000,"rateDownload":200,"rateUpload":10,
           "status":4,"eta":30,"labels":["TV"],"downloadDir":"D:\\Downloads\\TV"},
          {"malformed":true},null,[],{"hashString":"bad","name":"Bad","percentDone":0.1,"totalSize":"wrong"}
        ]}}
        """;
    internal const string QbittorrentRows = """
        [{"hash":"abc","name":"Show","progress":0.5,"size":1000,"dlspeed":200,"upspeed":10,"state":"stalledDL",
          "eta":30,"num_seeds":3,"num_leechs":2,"category":"TV","save_path":"D:\\Downloads\\TV","content_path":"D:\\Downloads\\TV\\Show.mkv"},
         {"hash":"def","name":"Movie","progress":1,"size":2000,"dlspeed":0,"upspeed":20,"state":"uploading",
          "eta":8640000,"save_path":"","content_path":"D:\\Downloads\\Movie.mkv"},
         {"hash":"ghi","name":"Unknown","progress":0,"size":0,"dlspeed":0,"upspeed":0,"state":"metaDL","eta":8640001}]
        """;
    private static ClientConfig Config(string type) => new()
    {
        ClientType = type, Host = "http://client.invalid:9091/", Username = "alice", Password = "secret",
        Category = "TV", SavePath = @"D:\Downloads",
    };
    private static EngineAddRequest Add() => new()
    {
        Magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
        Purpose = TorrentPurpose.Keep, Category = "Anime", SavePath = @"D:\Downloads\Anime",
    };

    [Fact]
    public async Task TransmissionHandshakeReplaysIdenticalBodyAndBasicAuth()
    {
        var replies = new Queue<HttpResponseMessage>([
            ExternalHandler.Response("", HttpStatusCode.Conflict, "X-Transmission-Session-Id", "fresh-session"),
            ExternalHandler.Response("""{"result":"success","arguments":{}}"""),
            ExternalHandler.Response(TransmissionRows),
        ]);
        using var handler = new ExternalHandler(_ => replies.Dequeue());
        using var http = new HttpClient(handler);
        var client = new TransmissionClient(http);
        var result = await client.AddAsync(Config("transmission"), Add());
        Assert.True(result.Ok);
        Assert.Equal("Torrent added to Transmission (label “Anime”, folder D:\\Downloads\\Anime)", result.Message);
        Assert.Equal(2, handler.Requests.Count);
        var first = handler.Requests[0];
        var replay = handler.Requests[1];
        Assert.Equal("http://client.invalid:9091/transmission/rpc", first.Url);
        Assert.Equal("POST", first.Method);
        Assert.Equal("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("alice:secret")), first.Headers["Authorization"]);
        Assert.Equal(first.Body, replay.Body);
        Assert.False(first.Headers.ContainsKey("X-Transmission-Session-Id"));
        Assert.Equal("fresh-session", replay.Headers["X-Transmission-Session-Id"]);
        using var body = JsonDocument.Parse(first.Body);
        Assert.Equal("torrent-add", body.RootElement.GetProperty("method").GetString());
        var args = body.RootElement.GetProperty("arguments");
        Assert.Equal(Add().Magnet, args.GetProperty("filename").GetString());
        Assert.Equal(@"D:\Downloads\Anime", args.GetProperty("download-dir").GetString());
        Assert.Equal("Anime", args.GetProperty("labels")[0].GetString());
        var torrent = Assert.Single(await client.ListAsync(Config("transmission")));
        Assert.Equal(new EngineTorrentInfo
        {
            Hash = "abc", Name = "Show", Progress = 0.5, SizeBytes = 1000, Dlspeed = 200, Upspeed = 10,
            State = "downloading", Eta = 30, Category = "TV", SavePath = @"D:\Downloads\TV",
        }, torrent);
    }

    [Theory]
    [InlineData(false, "Transmission CSRF handshake failed", 1)]
    [InlineData(true, "Transmission rejected the refreshed session", 2)]
    public async Task TransmissionHandshakeIsBounded(bool header, string message, int count)
    {
        using var handler = new ExternalHandler(_ => ExternalHandler.Response("", HttpStatusCode.Conflict,
            header ? "X-Transmission-Session-Id" : null, "session"));
        using var http = new HttpClient(handler);
        var result = await new TransmissionClient(http).AddAsync(Config("transmission"), Add());
        Assert.False(result.Ok);
        Assert.Equal(message, result.Message);
        Assert.Equal(count, handler.Requests.Count);
    }

    [Theory]
    [InlineData("[]", "Transmission returned an invalid RPC response")]
    [InlineData("{}", "Transmission RPC response is missing result")]
    [InlineData("{\"result\":\"invalid argument\"}", "invalid argument")]
    [InlineData("{\"result\":\"\"}", "Transmission RPC error")]
    public async Task TransmissionRpcErrorsAreNotSuccess(string json, string message)
    {
        using var handler = new ExternalHandler(_ => ExternalHandler.Response(json));
        using var http = new HttpClient(handler);
        var result = await new TransmissionClient(http).TestAsync(Config("transmission"));
        Assert.False(result.Ok);
        Assert.Equal(message, result.Message);
    }

    [Theory]
    [InlineData(0, "stopped")]
    [InlineData(1, "queuedCheck")]
    [InlineData(2, "checking")]
    [InlineData(3, "queuedDownload")]
    [InlineData(4, "downloading")]
    [InlineData(5, "queuedSeed")]
    [InlineData(6, "seeding")]
    [InlineData(9, "status_9")]
    public void TransmissionStatusParity(long code, string state) => Assert.Equal(state, TransmissionClient.Status(code));

    [Theory]
    [InlineData("pause", "torrent-stop", "Paused")]
    [InlineData("resume", "torrent-start", "Resumed")]
    [InlineData("delete", "torrent-remove", "Removed")]
    public async Task TransmissionActionsUseHashIds(string action, string method, string message)
    {
        using var handler = new ExternalHandler(_ => ExternalHandler.Response("""{"result":"success"}"""));
        using var http = new HttpClient(handler);
        var config = Config("transmission") with { Host = "http://client.invalid/transmission/rpc/", Username = null, Password = null };
        var result = await new TransmissionClient(http).ActAsync(config, action, "abc", true);
        Assert.Equal(new(true, message), result);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("http://client.invalid/transmission/rpc", request.Url);
        Assert.False(request.Headers.ContainsKey("Authorization"));
        using var body = JsonDocument.Parse(request.Body);
        Assert.Equal(method, body.RootElement.GetProperty("method").GetString());
        var args = body.RootElement.GetProperty("arguments");
        Assert.Equal("abc", args.GetProperty("ids")[0].GetString());
        if (action == "delete") Assert.True(args.GetProperty("delete-local-data").GetBoolean());
        else Assert.False(args.TryGetProperty("delete-local-data", out _));
    }

    [Fact]
    public async Task QbittorrentLoginCookiesAndListShape()
    {
        using var handler = new ExternalHandler(r => r.Url.EndsWith("/auth/login", StringComparison.Ordinal)
            ? ExternalHandler.Login() : ExternalHandler.Response(QbittorrentRows));
        using var http = new HttpClient(handler);
        var torrents = await new QBittorrentClient(http).ListAsync(Config("qbittorrent"));
        Assert.Equal(3, torrents.Count);
        var first = torrents[0];
        Assert.Equal("abc", first.Hash);
        Assert.Equal("stalledDL", first.State);
        Assert.Equal(0.5, first.Progress);
        Assert.Equal(1000, first.SizeBytes);
        Assert.Equal(200, first.Dlspeed);
        Assert.Equal(10, first.Upspeed);
        Assert.Equal(30, first.Eta);
        Assert.Equal(5, first.Peers);
        Assert.Equal("TV", first.Category);
        Assert.Equal(@"D:\Downloads\TV", first.SavePath);
        Assert.Null(torrents[1].Eta);
        Assert.Equal(@"D:\Downloads\Movie.mkv", torrents[1].SavePath);
        Assert.Null(torrents[2].SavePath);
        Assert.Equal(0, torrents[2].Peers);
        Assert.Equal("SID=session", handler.Requests[1].Headers["Cookie"]);
        var login = QueryHelpers.ParseQuery(handler.Requests[0].Body);
        Assert.Equal("alice", login["username"]);
        Assert.Equal("secret", login["password"]);
    }

    [Fact]
    public async Task QbittorrentRefreshesSidOnceAndDoesNotReuseCredentialsAcrossCalls()
    {
        var replies = new Queue<HttpResponseMessage>([
            ExternalHandler.Login("stale"), ExternalHandler.Response("", HttpStatusCode.Forbidden),
            ExternalHandler.Login("fresh"), ExternalHandler.Response("v5.0"),
            ExternalHandler.Login("other"), ExternalHandler.Response("v5.1"),
        ]);
        using var handler = new ExternalHandler(_ => replies.Dequeue());
        using var http = new HttpClient(handler);
        var client = new QBittorrentClient(http);
        Assert.Equal(new(true, "Connected to qBittorrent v5.0"), await client.TestAsync(Config("qbittorrent")));
        Assert.Equal("SID=stale", handler.Requests[1].Headers["Cookie"]);
        Assert.Equal("SID=fresh", handler.Requests[3].Headers["Cookie"]);
        Assert.Equal(new(true, "Connected to qBittorrent v5.1"), await client.TestAsync(Config("qbittorrent") with { Username = "bob", Password = "changed" }));
        Assert.Equal("SID=other", handler.Requests[5].Headers["Cookie"]);
        Assert.Contains("username=bob", handler.Requests[4].Body);
        Assert.DoesNotContain("secret", handler.Requests[4].Body);
    }

    [Fact]
    public async Task QbittorrentRepeatedForbiddenDoesNotLoop()
    {
        using var handler = new ExternalHandler(r => r.Url.EndsWith("/auth/login", StringComparison.Ordinal)
            ? ExternalHandler.Login() : ExternalHandler.Response("", HttpStatusCode.Forbidden));
        using var http = new HttpClient(handler);
        var result = await new QBittorrentClient(http).TestAsync(Config("qbittorrent"));
        Assert.Equal(new(false, "qBittorrent version check failed (403)"), result);
        Assert.Equal(4, handler.Requests.Count);
    }

    [Theory]
    [InlineData("pause", "Paused")]
    [InlineData("resume", "Resumed")]
    [InlineData("delete", "Removed from qBittorrent")]
    public async Task QbittorrentActionsAndDeleteFlag(string action, string message)
    {
        using var handler = new ExternalHandler(r => r.Url.EndsWith("/auth/login", StringComparison.Ordinal) ? ExternalHandler.Login() : ExternalHandler.Response(""));
        using var http = new HttpClient(handler);
        Assert.Equal(new(true, message), await new QBittorrentClient(http).ActAsync(Config("qbittorrent"), action, "abc", false));
        var request = handler.Requests[1];
        Assert.EndsWith("/api/v2/torrents/" + action, request.Url);
        var form = QueryHelpers.ParseQuery(request.Body);
        Assert.Equal("abc", form["hashes"]);
        if (action == "delete") Assert.Equal("false", form["deleteFiles"]);
    }

    [Fact]
    public async Task QbittorrentAddHonorsLayoutAndChecksFailureText()
    {
        var fail = false;
        using var handler = new ExternalHandler(r => r.Url.EndsWith("/auth/login", StringComparison.Ordinal)
            ? ExternalHandler.Login() : ExternalHandler.Response(fail ? "Fails." : "Ok."));
        using var http = new HttpClient(handler);
        var client = new QBittorrentClient(http);
        var result = await client.AddAsync(Config("qbittorrent"), Add());
        Assert.Equal(new(true, "Torrent added to qBittorrent (category “Anime”, folder D:\\Downloads\\Anime)"), result);
        var form = QueryHelpers.ParseQuery(handler.Requests[1].Body);
        Assert.Equal(@"D:\Downloads\Anime", form["savepath"]);
        Assert.Equal("NoSubfolder", form["contentLayout"]);
        Assert.Equal("false", form["autoTMM"]);
        Assert.Equal("Anime", form["category"]);
        Assert.Equal(Add().Magnet, form["urls"]);
        fail = true;
        Assert.Equal(new(false, "Fails."), await client.AddAsync(Config("qbittorrent"), Add()));
    }

    [Fact]
    public void AddBuildersPortAllTypeScriptTargetFixtures()
    {
        var config = Config("qbittorrent") with { BaseDownloadPath = @"D:\Torrents", PathRules = new Dictionary<string, string> { ["TV"] = @"D:\Torrents\TV" } };
        var request = Add() with { Category = "TV", SavePath = @"D:\Torrents\TV\Family Guy\Season 24" };
        var explicitPath = QBittorrentClient.BuildAddForm(config, request)!;
        Assert.Equal(request.SavePath, explicitPath["savepath"]);
        Assert.Equal("NoSubfolder", explicitPath["contentLayout"]);
        Assert.Equal("false", explicitPath["autoTMM"]);
        var rulePath = QBittorrentClient.BuildAddForm(config, request with { SavePath = null })!;
        Assert.Equal(@"D:\Torrents\TV", rulePath["savepath"]);
        Assert.Equal("NoSubfolder", rulePath["contentLayout"]);
        Assert.Equal("false", rulePath["autoTMM"]);
        Assert.Null(QBittorrentClient.BuildAddForm(config, new() { Purpose = "keep" }));
        Assert.Null(TransmissionClient.BuildAddArguments(config, new() { Purpose = "keep" }));
        var noPath = QBittorrentClient.BuildAddForm(new(), request with { Category = null, SavePath = null })!;
        Assert.False(noPath.ContainsKey("savepath"));
        Assert.False(noPath.ContainsKey("autoTMM"));
        Assert.False(noPath.ContainsKey("contentLayout"));
        var url = QBittorrentClient.BuildAddForm(new(), request with { Magnet = null, TorrentUrl = "https://example.invalid/file.torrent" })!;
        Assert.Equal("https://example.invalid/file.torrent", url["urls"]);
    }

    [Theory]
    [InlineData("qbittorrent")]
    [InlineData("transmission")]
    public async Task ConnectionFailuresAndCallerCancellation(string type)
    {
        using var handler = new ExternalHandler(_ => throw new HttpRequestException("ECONNREFUSED"));
        using var http = new HttpClient(handler);
        IExternalTorrentClient client = type == "qbittorrent" ? new QBittorrentClient(http) : new TransmissionClient(http);
        var result = await client.TestAsync(Config(type));
        Assert.False(result.Ok);
        Assert.True(ExternalClientErrors.IsOffline(result.Message));
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.TestAsync(Config(type), cts.Token));
    }

    [Fact]
    public void HttpFactoryRegistrationsHaveExplicitTimeouts()
    {
        using var services = new ServiceCollection().AddExternalClients().BuildServiceProvider();
        var factory = services.GetRequiredService<IHttpClientFactory>();
        using var qbittorrent = factory.CreateClient(nameof(QBittorrentClient));
        using var transmission = factory.CreateClient(nameof(TransmissionClient));
        Assert.Equal(TimeSpan.FromSeconds(15), qbittorrent.Timeout);
        Assert.Equal(TimeSpan.FromSeconds(12), transmission.Timeout);
    }

    [Theory]
    [InlineData(null, @"D:\Downloads", true)]
    [InlineData(@"D:\Downloads\TV", @"d:/downloads/tv", true)]
    [InlineData(@"D:\Downloads\TV", @"D:\Downloads\TV\Show", true)]
    [InlineData(@"D:\Downloads\TV", @"D:\Downloads\TV2", false)]
    [InlineData(@"D:\A", @"D:\B", false)]
    public void OwnershipStorageOverlapMatchesTypeScript(string? a, string? b, bool expected) =>
        Assert.Equal(expected, ExternalClientRegistry.PathsOverlap(a, b));

    [Fact]
    public void EmptyFolderPruningNeverDeletesRootOrNonemptyFolder()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var leaf = Path.Combine(root, "Show", "Season 01");
            Directory.CreateDirectory(leaf);
            Assert.Equal(2, ExternalClientRegistry.PruneEmptyParents(leaf, root));
            Assert.True(Directory.Exists(root));
            Directory.CreateDirectory(leaf);
            File.WriteAllText(Path.Combine(leaf, "keep.mkv"), "content");
            Assert.Equal(0, ExternalClientRegistry.PruneEmptyParents(leaf, root));
            Assert.True(File.Exists(Path.Combine(leaf, "keep.mkv")));
            Assert.Equal(0, ExternalClientRegistry.PruneEmptyParents(root, leaf));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
