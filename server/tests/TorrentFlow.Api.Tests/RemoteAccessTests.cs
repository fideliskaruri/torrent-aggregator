using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using TorrentFlow.Api.RemoteAccess;

namespace TorrentFlow.Api.Tests;

/// <summary>In-memory Cloudflare Access keys; the production build has no such backdoor.</summary>
public sealed class FakeKeySource : IAccessKeySource
{
    private readonly object _gate = new();
    private readonly List<SecurityKey> _keys = [];
    public int Fetches;
    public bool Fail;

    public void Add(SecurityKey key) { lock (_gate) _keys.Add(key); }

    public Task<IReadOnlyList<SecurityKey>> FetchSigningKeysAsync(string teamDomain, CancellationToken ct)
    {
        Interlocked.Increment(ref Fetches);
        if (Fail) throw new HttpRequestException("simulated outage");
        lock (_gate) return Task.FromResult<IReadOnlyList<SecurityKey>>(_keys.ToList());
    }
}

/// <summary>TestServer has no real sockets, so the test header stands in for the connection's local port.</summary>
public sealed class TestLocalPortStartupFilter : IStartupFilter
{
    public const string Header = "X-Test-Local-Port";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, nextMiddleware) =>
        {
            if (int.TryParse(context.Request.Headers[Header], out var port)) context.Connection.LocalPort = port;
            context.Request.Headers.Remove(Header);
            return nextMiddleware(context);
        });
        next(app);
    };
}

public sealed class ManualTime : TimeProvider
{
    public DateTimeOffset Now { get; set; } = new(2026, 9, 26, 0, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => Now;
}

public class RemoteHostFactory : WebApplicationFactory<Program>
{
    public const int TunnelPort = 3941;
    public const string Team = "tfteam";
    public const string Audience = "0123456789abcdef0123456789abcdef";
    public const string KeyId = "key-1";

    public string Root { get; } = Path.Combine(Path.GetTempPath(), "tf-remote-" + Guid.NewGuid().ToString("N"));
    public string WebRoot { get; } = Path.Combine(Path.GetTempPath(), "tf-remote-web-" + Guid.NewGuid().ToString("N"));
    public FakeKeySource Keys { get; } = new();
    public RSA Rsa { get; } = RSA.Create(2048);
    /// <summary>Clock for the key cache only; the rest of the host keeps real time.</summary>
    public ManualTime? CacheTime { get; init; }

    protected virtual IDictionary<string, string?> Settings => new Dictionary<string, string?>
    {
        ["TorrentFlow:RemoteAccess:Enabled"] = "true",
        ["TorrentFlow:RemoteAccess:TunnelPort"] = TunnelPort.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["TorrentFlow:RemoteAccess:TeamDomain"] = Team,
        ["TorrentFlow:RemoteAccess:Audience"] = Audience,
        ["TorrentFlow:RemoteAccess:OwnerEmails:0"] = "Owner@Example.com",
    };

    public RemoteHostFactory()
    {
        Keys.Add(new RsaSecurityKey(Rsa.ExportParameters(false)) { KeyId = KeyId });
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(Path.Combine(WebRoot, "assets"));
        File.WriteAllText(Path.Combine(WebRoot, "index.html"), "<!doctype html><div id=root></div>");
        File.WriteAllText(Path.Combine(WebRoot, "assets", "app.js"), "export {};");
        File.WriteAllText(Path.Combine(WebRoot, "manifest.webmanifest"), "{}");
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:Engine:RefreshTrackers", "false");
        builder.UseSetting("TorrentFlow:WebRoot", WebRoot);
        foreach (var (key, value) in Settings) builder.UseSetting(key, value);
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IAccessKeySource>();
            services.AddSingleton<IAccessKeySource>(Keys);
            services.AddTransient<IStartupFilter, TestLocalPortStartupFilter>();
            if (CacheTime is { } time)
            {
                services.RemoveAll<AccessKeyCache>();
                services.AddSingleton(sp => new AccessKeyCache(sp.GetRequiredService<IAccessKeySource>(), time, NullLogger<AccessKeyCache>.Instance));
            }
        });
    }

    public HttpClient Local() => CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

    public HttpClient Tunnel(string? token)
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestLocalPortStartupFilter.Header, TunnelPort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (token is not null) client.DefaultRequestHeaders.Add("Cf-Access-Jwt-Assertion", token);
        return client;
    }

    public string Token(
        string? email = "owner@example.com",
        string? issuer = null,
        string[]? audience = null,
        DateTime? expires = null,
        DateTime? notBefore = null,
        SigningCredentials? credentials = null)
    {
        var now = DateTime.UtcNow;
        var claims = new Dictionary<string, object>
        {
            ["aud"] = audience ?? [Audience],
            ["sub"] = "user-1",
        };
        if (email is not null) claims["email"] = email;
        return new JsonWebTokenHandler { SetDefaultTimesOnTokenCreation = false }.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer ?? $"https://{Team}.cloudflareaccess.com",
            Claims = claims,
            IssuedAt = now.AddMinutes(-1),
            NotBefore = notBefore ?? now.AddMinutes(-1),
            Expires = expires ?? now.AddMinutes(10),
            SigningCredentials = credentials ?? new SigningCredentials(new RsaSecurityKey(Rsa) { KeyId = KeyId }, SecurityAlgorithms.RsaSha256),
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        Rsa.Dispose();
        try { Directory.Delete(Root, recursive: true); Directory.Delete(WebRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed class RemoteAccessTests(RemoteHostFactory factory) : IClassFixture<RemoteHostFactory>
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task OwnerThroughTheTunnelGetsTheWholeApp()
    {
        using var client = factory.Tunnel(factory.Token());
        var me = await client.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var body = await Json(me);
        Assert.Equal("owner", body.GetProperty("role").GetString());
        Assert.Equal("tunnel", body.GetProperty("via").GetString());
        Assert.Equal("owner@example.com", body.GetProperty("email").GetString());

        foreach (var (path, type) in new[] { ("/", "text/html"), ("/search", "text/html"), ("/assets/app.js", "text/javascript"), ("/manifest.webmanifest", "application/manifest+json") })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(type, response.Content.Headers.ContentType?.MediaType);
        }
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health")).StatusCode);
    }

    [Fact]
    public async Task OwnerEmailIsComparedCaseInsensitively()
    {
        using var client = factory.Tunnel(factory.Token(email: "OWNER@EXAMPLE.COM"));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/search")]
    [InlineData("/assets/app.js")]
    [InlineData("/manifest.webmanifest")]
    [InlineData("/api/health")]
    [InlineData("/api/me")]
    public async Task NoTokenGetsJson401AndNoAppFiles(string path)
    {
        using var client = factory.Tunnel(null);
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("required", response.Headers.GetValues("X-TorrentFlow-Auth").Single());
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("<div id=root>", text);
        Assert.DoesNotContain("export {}", text);
        Assert.Contains("Cloudflare", JsonDocument.Parse(text).RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task BadTokensAre401WithoutEchoingTheReason()
    {
        var now = DateTime.UtcNow;
        using var forgedRsa = RSA.Create(2048);
        var forged = new SigningCredentials(new RsaSecurityKey(forgedRsa) { KeyId = RemoteHostFactory.KeyId }, SecurityAlgorithms.RsaSha256);
        var hmac = new SigningCredentials(new SymmetricSecurityKey(RandomNumberGenerator.GetBytes(32)) { KeyId = RemoteHostFactory.KeyId }, SecurityAlgorithms.HmacSha256);
        var valid = factory.Token();
        var parts = valid.Split('.');
        static string B64(string json) => Base64UrlEncoder.Encode(Encoding.UTF8.GetBytes(json));

        var cases = new Dictionary<string, string>
        {
            ["forged signature"] = factory.Token(credentials: forged),
            ["tampered payload"] = $"{parts[0]}.{B64("{\"email\":\"owner@example.com\",\"aud\":[\"" + RemoteHostFactory.Audience + "\"],\"iss\":\"https://tfteam.cloudflareaccess.com\",\"exp\":4102444800}")}.{parts[2]}",
            ["expired"] = factory.Token(expires: now.AddMinutes(-5), notBefore: now.AddMinutes(-20)),
            ["not yet valid"] = factory.Token(notBefore: now.AddMinutes(5), expires: now.AddMinutes(20)),
            ["wrong audience"] = factory.Token(audience: ["somebody-elses-aud-tag"]),
            ["wrong issuer"] = factory.Token(issuer: "https://otherteam.cloudflareaccess.com"),
            ["lookalike issuer"] = factory.Token(issuer: "https://tfteam.cloudflareaccess.com.evil.example"),
            ["alg none"] = $"{B64("{\"alg\":\"none\",\"typ\":\"JWT\"}")}.{parts[1]}.",
            ["HS256"] = factory.Token(credentials: hmac),
            ["no email (service token)"] = factory.Token(email: null),
            ["empty email"] = factory.Token(email: ""),
            ["garbage"] = "not-a-jwt",
        };
        foreach (var (name, token) in cases)
        {
            using var client = factory.Tunnel(token);
            var response = await client.GetAsync("/api/me");
            Assert.True(response.StatusCode == HttpStatusCode.Unauthorized, $"{name}: {response.StatusCode}");
            var error = (await Json(response)).GetProperty("error").GetString()!;
            Assert.DoesNotContain("IDX", error);
            Assert.DoesNotContain("alg", error);
        }
    }

    [Fact]
    public async Task ExpiryHonoursSixtySecondsOfSkew()
    {
        using var client = factory.Tunnel(factory.Token(expires: DateTime.UtcNow.AddSeconds(-20), notBefore: DateTime.UtcNow.AddMinutes(-10)));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task AudienceIsMatchedWithinAnArray()
    {
        using var client = factory.Tunnel(factory.Token(audience: ["another-app-aud-tag", RemoteHostFactory.Audience]));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task OtherSignedInEmailsAreNotEnabledYetWhenRequestersAreOff()
    {
        using var off = new RemoteAccessIsolatedTests.RequestersOffFactory();
        using var client = off.Tunnel(off.Token(email: "friend@example.com"));
        foreach (var path in new[] { "/api/me", "/" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Contains("not enabled yet", (await Json(response)).GetProperty("error").GetString());
        }
    }

    [Theory]
    [InlineData("Cf-Ray", "8a1b2c3d4e5f-AMS")]
    [InlineData("Cf-Connecting-Ip", "203.0.113.9")]
    [InlineData("Cf-Access-Jwt-Assertion", "eyJ.x.y")]
    [InlineData("Cdn-Loop", "cloudflare; loops=1")]
    public async Task CloudflareTrafficOnTheLocalListenerIsMisrouted(string header, string value)
    {
        using var client = factory.Local();
        client.DefaultRequestHeaders.TryAddWithoutValidation(header, value);
        foreach (var path in new[] { "/", "/api/me", "/assets/app.js" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.MisdirectedRequest, response.StatusCode);
            Assert.Contains("Point the tunnel at the tunnel port", (await Json(response)).GetProperty("error").GetString());
        }
    }

    [Fact]
    public async Task UnknownKeyIdRefetchIsRateLimited()
    {
        using var rotated = RSA.Create(2048);
        var kid = "rotated-" + Guid.NewGuid().ToString("N");
        var credentials = new SigningCredentials(new RsaSecurityKey(rotated) { KeyId = kid }, SecurityAlgorithms.RsaSha256);
        using (var warm = factory.Tunnel(factory.Token())) await warm.GetAsync("/api/me");

        // Not published yet: refused, and the rate limit keeps a flood of unknown kids from refetching.
        var before = factory.Keys.Fetches;
        using (var client = factory.Tunnel(factory.Token(credentials: credentials)))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/me")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/me")).StatusCode);
        }
        Assert.True(factory.Keys.Fetches - before <= 1);
    }

    [Fact]
    public async Task StreamingIsRefusedThroughTheTunnel()
    {
        using var client = factory.Tunnel(factory.Token());
        foreach (var path in new[] { "/api/stream/abc", "/api/playback/status", "/api/prewarm", "/api/subtitles/abc" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            var body = await Json(response);
            Assert.True(body.GetProperty("streamingDisabled").GetBoolean());
            Assert.Contains("remote access", body.GetProperty("error").GetString());
        }
        using var features = JsonDocument.Parse(await client.GetStringAsync("/api/features"));
        Assert.False(features.RootElement.GetProperty("streaming").GetBoolean());
    }

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task CrossSiteWritesAreRefusedOnBothListeners(string method)
    {
        foreach (var client in new[] { factory.Local(), factory.Tunnel(factory.Token()) })
        {
            using (client)
            {
                var request = new HttpRequestMessage(new HttpMethod(method), "/api/torrent/send") { Content = JsonContent.Create(new { magnet = "x" }) };
                request.Headers.Add("Sec-Fetch-Site", "cross-site");
                Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(request)).StatusCode);

                var sameSite = new HttpRequestMessage(new HttpMethod(method), "/api/torrent/send") { Content = JsonContent.Create(new { magnet = "x" }) };
                sameSite.Headers.Add("Sec-Fetch-Site", "same-site");
                sameSite.Headers.Add("Origin", "https://evil.example.com");
                var refused = await client.SendAsync(sameSite);
                Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
                Assert.Equal("Browser request origin does not match this application", (await Json(refused)).GetProperty("error").GetString());
            }
        }
    }

    [Fact]
    public async Task WritesWithoutSecFetchSiteMustStillComeFromThisHost()
    {
        foreach (var client in new[] { factory.Local(), factory.Tunnel(factory.Token()) })
        {
            using (client)
            {
                var foreign = new HttpRequestMessage(HttpMethod.Put, "/api/settings/remote-access") { Content = JsonContent.Create(new { }) };
                foreign.Headers.Add("Origin", "https://evil.example.com");
                var refused = await client.SendAsync(foreign);
                Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
                Assert.Equal("Browser request origin does not match this application", (await Json(refused)).GetProperty("error").GetString());

                var nullOrigin = new HttpRequestMessage(HttpMethod.Put, "/api/settings/remote-access") { Content = JsonContent.Create(new { }) };
                nullOrigin.Headers.Add("Origin", "null");
                Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(nullOrigin)).StatusCode);
            }
        }

        // Same host, or no Origin at all (curl, scripts): passes the guard and reaches the endpoint (400 for the empty body).
        using var local = factory.Local();
        var sameHost = new HttpRequestMessage(HttpMethod.Put, "/api/settings/remote-access") { Content = new StringContent("", Encoding.UTF8, "application/json") };
        sameHost.Headers.Add("Origin", "http://localhost");
        Assert.Equal(HttpStatusCode.BadRequest, (await local.SendAsync(sameHost)).StatusCode);
        var noOrigin = new HttpRequestMessage(HttpMethod.Put, "/api/settings/remote-access") { Content = new StringContent("", Encoding.UTF8, "application/json") };
        Assert.Equal(HttpStatusCode.BadRequest, (await local.SendAsync(noOrigin)).StatusCode);
    }

    [Fact]
    public async Task SameSiteWritesFromThisHostAreComparedByHostOnly()
    {
        // The browser sees https://<tunnel host>; Kestrel sees http. Only host:port has to match.
        using var client = factory.Tunnel(factory.Token());
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/settings/remote-access") { Content = JsonContent.Create(new { }) };
        request.Headers.Add("Sec-Fetch-Site", "same-site");
        request.Headers.Add("Origin", "https://localhost");
        var response = await client.SendAsync(request);
        // Passed the guard; refused by the endpoint because it came through the tunnel.
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("only be changed on the computer", (await Json(response)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task DownloadRecoveryIsRefusedThroughTheTunnel()
    {
        using var client = factory.Tunnel(factory.Token());
        foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
        {
            var response = await client.SendAsync(new HttpRequestMessage(method, "/api/settings/download-recovery"));
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal("local_only", (await Json(response)).GetProperty("code").GetString());
        }
    }

    [Fact]
    public async Task RemoteAccessSettingsCannotBeChangedThroughTheTunnel()
    {
        using var client = factory.Tunnel(factory.Token());
        var response = await client.PutAsJsonAsync("/api/settings/remote-access", new { ownerEmails = new[] { "attacker@example.com" } });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var get = await Json(await client.GetAsync("/api/settings/remote-access"));
        Assert.False(get.GetProperty("editable").GetBoolean());
        Assert.Equal("tunnel", get.GetProperty("via").GetString());
        Assert.False(File.Exists(Path.Combine(factory.Root, RemoteAccessStore.FileName)) && File.ReadAllText(Path.Combine(factory.Root, RemoteAccessStore.FileName)).Contains("attacker"));
    }

    [Fact]
    public async Task SelfTestFetchesTheTeamKeys()
    {
        using var client = factory.Local();
        var body = await Json(await client.GetAsync("/api/settings/remote-access/check"));
        Assert.True(body.GetProperty("ok").GetBoolean(), body.ToString());
        Assert.True(body.GetProperty("listening").GetBoolean());
        Assert.Equal(1, body.GetProperty("keyCount").GetInt32());
        Assert.Equal("https://tfteam.cloudflareaccess.com", body.GetProperty("issuer").GetString());
    }

    [Fact]
    public void NonOwnerEmailsAreMaskedInLogs()
    {
        Assert.Equal("j***@example.com", RemoteAccessMiddleware.MaskEmail("jane.doe@example.com"));
        Assert.Equal("***", RemoteAccessMiddleware.MaskEmail("@example.com"));
    }

    [Fact]
    public async Task MisroutedMessageNamesTheConfiguredTunnelUrl()
    {
        using var client = factory.Local();
        client.DefaultRequestHeaders.Add("Cf-Ray", "abc");
        var error = (await Json(await client.GetAsync("/api/me"))).GetProperty("error").GetString();
        Assert.Contains($"(http://127.0.0.1:{RemoteHostFactory.TunnelPort})", error);
    }

    [Theory]
    [InlineData("http://127.0.0.1:3000", new[] { 3000 })]
    [InlineData("http://*:5000", new[] { 5000 })]
    [InlineData("http://+:5001", new[] { 5001 })]
    [InlineData("http://[::1]:5002", new[] { 5002 })]
    [InlineData("http://127.0.0.1:5003; http://*:5004;https://+:5003", new[] { 5003, 5004 })]
    [InlineData("", new int[0])]
    public void OwnerPortsAreParsedFromKestrelUrls(string urls, int[] expected)
    {
        Assert.Equal(expected, RemoteAccessRules.ParseOwnerPorts(urls));
    }
}

/// <summary>A factory per test: these write remote-access.json or break the key source.</summary>
public sealed class RemoteAccessIsolatedTests
{
    [Fact]
    public async Task TurningRequestersOffAndOnFromSettingsAppliesImmediatelyAndPersists()
    {
        using var factory = new RemoteHostFactory();
        using var client = factory.Local();
        Assert.True((await Json(await client.GetAsync("/api/settings/remote-access"))).GetProperty("allowRequesters").GetBoolean());

        var off = await client.PutAsJsonAsync("/api/settings/remote-access", new { allowRequesters = false });
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False((await Json(off)).GetProperty("allowRequesters").GetBoolean());
        using (var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(factory.Root, RemoteAccessStore.FileName))))
            Assert.False(saved.RootElement.GetProperty("allowRequesters").GetBoolean());
        using (var friend = factory.Tunnel(factory.Token(email: "friend@example.com")))
        {
            var refused = await friend.GetAsync("/api/me");
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("remote_access_not_enabled", (await Json(refused)).GetProperty("code").GetString());
        }

        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/settings/remote-access", new { allowRequesters = true })).StatusCode);
        using (var friend = factory.Tunnel(factory.Token(email: "friend@example.com")))
            Assert.Equal("requester", (await Json(await friend.GetAsync("/api/me"))).GetProperty("role").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsync("/api/settings/remote-access",
            new StringContent("{\"allowRequesters\":\"yes\"}", Encoding.UTF8, "application/json"))).StatusCode);
    }
    [Fact]
    public async Task SavingFromTheLocalListenerWritesTheFileAndReportsRestartOnlyForListenerFields()
    {
        using var factory = new RemoteHostFactory();
        using var client = factory.Local();
        var path = Path.Combine(factory.Root, RemoteAccessStore.FileName);

        var live = await client.PutAsJsonAsync("/api/settings/remote-access", new
        {
            teamDomain = "https://NewTeam.cloudflareaccess.com/",
            audience = "fedcba9876543210fedcba9876543210",
            ownerEmails = new[] { " Me@Example.com ", "me@example.com", "second@example.com" },
        });
        Assert.Equal(HttpStatusCode.OK, live.StatusCode);
        var body = await Json(live);
        Assert.False(body.GetProperty("restartRequired").GetBoolean());
        Assert.Equal("newteam", body.GetProperty("teamDomain").GetString());
        Assert.Equal(["me@example.com", "second@example.com"], body.GetProperty("ownerEmails").EnumerateArray().Select(e => e.GetString()));
        Assert.True(File.Exists(path));
        using (var saved = JsonDocument.Parse(File.ReadAllText(path)))
            Assert.Equal("newteam", saved.RootElement.GetProperty("teamDomain").GetString());
        Assert.Empty(Directory.GetFiles(factory.Root, "*.tmp"));

        // Owners reload live: the old owner is out, the new one is in (new team's issuer).
        var newIssuer = "https://newteam.cloudflareaccess.com";
        using (var tunnel = factory.Tunnel(factory.Token(email: "second@example.com", issuer: newIssuer, audience: ["fedcba9876543210fedcba9876543210"])))
            Assert.Equal(HttpStatusCode.OK, (await tunnel.GetAsync("/api/me")).StatusCode);
        using (var tunnel = factory.Tunnel(factory.Token(email: "owner@example.com", issuer: newIssuer, audience: ["fedcba9876543210fedcba9876543210"])))
        {
            // The removed owner is now just a requester: no owner endpoints.
            Assert.Equal("requester", (await Json(await tunnel.GetAsync("/api/me"))).GetProperty("role").GetString());
            Assert.Equal(HttpStatusCode.Forbidden, (await tunnel.GetAsync("/api/settings/remote-access")).StatusCode);
        }

        var port = await client.PutAsJsonAsync("/api/settings/remote-access", new { tunnelPort = 3950 });
        Assert.Equal(HttpStatusCode.OK, port.StatusCode);
        var portBody = await Json(port);
        Assert.True(portBody.GetProperty("restartRequired").GetBoolean());
        Assert.Equal(RemoteHostFactory.TunnelPort, portBody.GetProperty("running").GetProperty("tunnelPort").GetInt32());

        var back = await Json(await client.PutAsJsonAsync("/api/settings/remote-access", new { tunnelPort = RemoteHostFactory.TunnelPort }));
        Assert.False(back.GetProperty("restartRequired").GetBoolean());
    }

    [Theory]
    [InlineData("{\"teamDomain\":\"not a team!\"}", "teamDomain")]
    [InlineData("{\"ownerEmails\":[\"nope\"]}", "not a valid email")]
    [InlineData("{\"ownerEmails\":\"me@example.com\"}", "ownerEmails must be an array")]
    [InlineData("{\"audience\":\"short\"}", "audience")]
    [InlineData("{\"tunnelPort\":80}", "tunnelPort must be between")]
    [InlineData("{\"tunnelBindAddress\":\"example.com\"}", "tunnelBindAddress")]
    [InlineData("{\"enabled\":true,\"ownerEmails\":[]}", "at least one owner email")]
    [InlineData("{\"surprise\":1}", "Unknown field")]
    [InlineData("{\"ownerEmails\":[\"me@example.com\",42]}", "only email address strings")]
    [InlineData("{\"ownerEmails\":[null]}", "only email address strings")]
    public async Task InvalidSettingsAreRejected(string json, string message)
    {
        using var factory = new RemoteHostFactory();
        using var client = factory.Local();
        var response = await client.PutAsync("/api/settings/remote-access", new StringContent(json, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(message, (await Json(response)).GetProperty("error").GetString());
        Assert.False(File.Exists(Path.Combine(factory.Root, RemoteAccessStore.FileName)));
    }

    [Fact]
    public async Task UnknownKeyIdIsRefetchedThenValidated()
    {
        var time = new ManualTime();
        using var factory = new RemoteHostFactory { CacheTime = time };
        using var rotatedRsa = RSA.Create(2048);
        var rotated = new SigningCredentials(new RsaSecurityKey(rotatedRsa) { KeyId = "key-2" }, SecurityAlgorithms.RsaSha256);
        using (var client = factory.Tunnel(factory.Token())) Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
        Assert.Equal(1, factory.Keys.Fetches);

        // Cloudflare rotates keys; the new kid shows up before the hour-long cache expires.
        factory.Keys.Add(new RsaSecurityKey(rotatedRsa.ExportParameters(false)) { KeyId = "key-2" });
        time.Now += TimeSpan.FromMinutes(2);
        using (var client = factory.Tunnel(factory.Token(credentials: rotated)))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/me")).StatusCode);
            Assert.Equal(1, factory.Keys.Fetches);
            time.Now += TimeSpan.FromMinutes(4);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
            Assert.Equal(2, factory.Keys.Fetches);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
            Assert.Equal(2, factory.Keys.Fetches);
        }
    }

    [Fact]
    public async Task KeyFetchFailureIs401()
    {
        using var factory = new RemoteHostFactory();
        factory.Keys.Fail = true;
        using var client = factory.Tunnel(factory.Token());
        var refused = await client.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        // An outage is not an expired session: the SPA must not loop on reload.
        Assert.Equal("misconfigured", refused.Headers.GetValues("X-TorrentFlow-Auth").Single());
        using var local = factory.Local();
        var check = await Json(await local.GetAsync("/api/settings/remote-access/check"));
        Assert.False(check.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void TunnelPortEqualToTheOwnerPortStopsStartup()
    {
        using var factory = new ClashFactory();
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        var message = error is AggregateException aggregate ? aggregate.Flatten().InnerExceptions[0].Message : error.Message;
        Assert.Contains("tunnel port 3942 is the same port", message + error);
    }

    [Fact]
    public async Task LocalListenerIsUnchangedWhenRemoteAccessIsOff()
    {
        using var factory = new DisabledFactory();
        using var client = factory.Local();
        foreach (var (path, type) in new[] { ("/", "text/html"), ("/search", "text/html"), ("/assets/app.js", "text/javascript") })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(type, response.Content.Headers.ContentType?.MediaType);
        }
        var me = await Json(await client.GetAsync("/api/me"));
        Assert.Equal("local", me.GetProperty("via").GetString());
        Assert.Equal("owner", me.GetProperty("role").GetString());
        var settings = await Json(await client.GetAsync("/api/settings/remote-access"));
        Assert.False(settings.GetProperty("enabled").GetBoolean());
        Assert.True(settings.GetProperty("editable").GetBoolean());
        Assert.Equal(RemoteAccessOptions.DefaultTunnelPort, settings.GetProperty("tunnelPort").GetInt32());

        // With no tunnel listener, the would-be tunnel port is just another local connection.
        using var tunnel = factory.Tunnel(null);
        Assert.Equal(HttpStatusCode.OK, (await tunnel.GetAsync("/api/health")).StatusCode);

        // The Cloudflare-header refusal applies even when remote access is off.
        using var misrouted = factory.Local();
        misrouted.DefaultRequestHeaders.Add("Cf-Ray", "abc");
        Assert.Equal(HttpStatusCode.MisdirectedRequest, (await misrouted.GetAsync("/")).StatusCode);
    }

    [Fact]
    public async Task TurningRemoteAccessOffRefusesTheTunnelImmediately()
    {
        using var factory = new RemoteHostFactory();
        using var tunnel = factory.Tunnel(factory.Token());
        Assert.Equal(HttpStatusCode.OK, (await tunnel.GetAsync("/api/me")).StatusCode);

        using var local = factory.Local();
        var saved = await Json(await local.PutAsJsonAsync("/api/settings/remote-access", new { enabled = false }));
        Assert.True(saved.GetProperty("restartRequired").GetBoolean());

        foreach (var path in new[] { "/api/me", "/" })
        {
            var refused = await tunnel.GetAsync(path);
            Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
            Assert.Equal("misconfigured", refused.Headers.GetValues("X-TorrentFlow-Auth").Single());
            Assert.Contains("turned off", (await Json(refused)).GetProperty("error").GetString());
        }
        Assert.Equal(HttpStatusCode.OK, (await local.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task MissingSettingsAreMisconfiguredNotExpired()
    {
        using var factory = new NoAudienceFactory();
        using var tunnel = factory.Tunnel(null);
        var refused = await tunnel.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Equal("misconfigured", refused.Headers.GetValues("X-TorrentFlow-Auth").Single());
    }

    [Fact]
    public async Task FeaturesReportStreamingLocallyButNotThroughTheTunnel()
    {
        using var factory = new StreamingFactory();
        using var local = factory.Local();
        using var tunnel = factory.Tunnel(factory.Token());
        Assert.True((await Json(await local.GetAsync("/api/features"))).GetProperty("streaming").GetBoolean());
        Assert.False((await Json(await tunnel.GetAsync("/api/features"))).GetProperty("streaming").GetBoolean());
        Assert.False((await Json(await tunnel.GetAsync("/api/features"))).GetProperty("openFolder").GetBoolean());
        using var folder = await tunnel.PostAsJsonAsync("/api/settings/open-folder", new { path = "/media" });
        Assert.Equal(HttpStatusCode.Conflict, folder.StatusCode);
        Assert.True((await Json(folder)).GetProperty("openFolderDisabled").GetBoolean());
    }

    [Fact]
    public async Task APreWrittenSettingsFileIsLoadedAtStartup()
    {
        using var factory = new DisabledFactory();
        Directory.CreateDirectory(factory.Root);
        File.WriteAllText(Path.Combine(factory.Root, RemoteAccessStore.FileName), JsonSerializer.Serialize(new
        {
            enabled = true,
            tunnelPort = RemoteHostFactory.TunnelPort,
            teamDomain = RemoteHostFactory.Team,
            audience = RemoteHostFactory.Audience,
            ownerEmails = new[] { "owner@example.com" },
        }));
        using var local = factory.Local();
        var settings = await Json(await local.GetAsync("/api/settings/remote-access"));
        Assert.True(settings.GetProperty("enabled").GetBoolean());
        Assert.True(settings.GetProperty("running").GetProperty("enabled").GetBoolean());
        Assert.Equal(RemoteHostFactory.Team, settings.GetProperty("teamDomain").GetString());

        using var tunnel = factory.Tunnel(factory.Token());
        var me = await Json(await tunnel.GetAsync("/api/me"));
        Assert.Equal("tunnel", me.GetProperty("via").GetString());
        Assert.Equal("owner@example.com", me.GetProperty("email").GetString());
    }

    [Fact]
    public void CommaSeparatedOwnerEmailsConfigYieldsEachOwner()
    {
        var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["TorrentFlow:RemoteAccess:OwnerEmails"] = "A@example.com, b@example.com" })
            .Build();
        var store = RemoteAccessStore.Load(config, Path.Combine(Path.GetTempPath(), "tf-none-" + Guid.NewGuid().ToString("N")));
        Assert.Equal(["a@example.com", "b@example.com"], store.Current.OwnerEmails);
    }

    [Fact]
    public async Task LoadWarningsClearAfterASuccessfulSave()
    {
        using var factory = new RemoteHostFactory();
        Directory.CreateDirectory(factory.Root);
        File.WriteAllText(Path.Combine(factory.Root, RemoteAccessStore.FileName), "{\"tunnelPort\":\"nope\"}");
        using var local = factory.Local();
        Assert.NotEmpty((await Json(await local.GetAsync("/api/settings/remote-access"))).GetProperty("warnings").EnumerateArray());
        var saved = await Json(await local.PutAsJsonAsync("/api/settings/remote-access", new { ownerEmails = new[] { "owner@example.com" } }));
        Assert.Empty(saved.GetProperty("warnings").EnumerateArray());
    }

    [Fact]
    public async Task TunnelPortEqualToTheOwnerPortIsRejectedOnSave()
    {
        using var factory = new RemoteHostFactory();
        using var local = factory.Local();
        var ownerPort = (await Json(await local.GetAsync("/api/settings/remote-access"))).GetProperty("ownerPorts")[0].GetInt32();
        var response = await local.PutAsJsonAsync("/api/settings/remote-access", new { tunnelPort = ownerPort });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("already uses on this computer", (await Json(response)).GetProperty("error").GetString());
        Assert.False(File.Exists(Path.Combine(factory.Root, RemoteAccessStore.FileName)));
    }

    [Fact]
    public async Task OversizedBodiesAre413()
    {
        using var factory = new RemoteHostFactory();
        using var local = factory.Local();
        var json = "{\"ownerEmails\":[\"" + new string('a', 20_000) + "@example.com\"]}";
        var response = await local.PutAsync("/api/settings/remote-access", new StringContent(json, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.False(File.Exists(Path.Combine(factory.Root, RemoteAccessStore.FileName)));
    }

    [Fact]
    public async Task RealSocketsSeparateTheOwnerAndTunnelListeners()
    {
        using var factory = new KestrelFactory(FreePort(), FreePort());
        factory.UseKestrel();
        factory.StartServer();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"http://127.0.0.1:{factory.OwnerPort}/api/me")).StatusCode);

        var tunnel = await http.GetAsync($"http://127.0.0.1:{factory.RealTunnelPort}/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, tunnel.StatusCode);
        Assert.Equal("required", tunnel.Headers.GetValues("X-TorrentFlow-Auth").Single());

        using var owned = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{factory.RealTunnelPort}/api/me");
        owned.Headers.Add("Cf-Access-Jwt-Assertion", factory.Token());
        var ownerThroughTunnel = await Json(await http.SendAsync(owned));
        Assert.Equal("tunnel", ownerThroughTunnel.GetProperty("via").GetString());

        using var misrouted = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{factory.OwnerPort}/api/me");
        misrouted.Headers.Add("Cf-Ray", "abc");
        Assert.Equal(HttpStatusCode.MisdirectedRequest, (await http.SendAsync(misrouted)).StatusCode);

        var settings = await Json(await http.GetAsync($"http://127.0.0.1:{factory.OwnerPort}/api/settings/remote-access"));
        Assert.True(settings.GetProperty("running").GetProperty("listening").GetBoolean());
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private sealed class StreamingFactory : RemoteHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["TorrentFlow:Engine:Streaming"] = "true",
        };
    }

    private sealed class NoAudienceFactory : RemoteHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["TorrentFlow:RemoteAccess:Audience"] = "",
        };
    }

    private sealed class KestrelFactory(int ownerPort, int tunnelPort) : RemoteHostFactory
    {
        public int OwnerPort { get; } = ownerPort;
        public int RealTunnelPort { get; } = tunnelPort;

        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["urls"] = $"http://127.0.0.1:{OwnerPort}",
            ["TorrentFlow:RemoteAccess:TunnelPort"] = RealTunnelPort.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
    }

    private sealed class ClashFactory : RemoteHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["urls"] = "http://127.0.0.1:3942",
            ["TorrentFlow:RemoteAccess:TunnelPort"] = "3942",
        };
    }

    internal sealed class RequestersOffFactory : RemoteHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
        {
            ["TorrentFlow:RemoteAccess:AllowRequesters"] = "false",
        };
    }

    private sealed class DisabledFactory : RemoteHostFactory
    {
        protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>();
    }
}

public sealed class AccessKeyCacheTests
{
    [Fact]
    public async Task CachesForAnHourAndRefetchesUnknownKidsAtMostEveryFiveMinutes()
    {
        var source = new FakeKeySource();
        source.Add(new SymmetricSecurityKey(new byte[32]) { KeyId = "k1" });
        var time = new ManualTime();
        var cache = new AccessKeyCache(source, time, NullLogger<AccessKeyCache>.Instance);

        await cache.GetAsync("team", "k1", default);
        await cache.GetAsync("team", "k1", default);
        Assert.Equal(1, source.Fetches);

        time.Now += TimeSpan.FromMinutes(1);
        var keys = await cache.GetAsync("team", "k2", default);
        Assert.DoesNotContain(keys, k => k.KeyId == "k2");
        Assert.Equal(1, source.Fetches);

        source.Add(new SymmetricSecurityKey(new byte[32]) { KeyId = "k2" });
        time.Now += TimeSpan.FromMinutes(5);
        keys = await cache.GetAsync("team", "k2", default);
        Assert.Contains(keys, k => k.KeyId == "k2");
        Assert.Equal(2, source.Fetches);

        time.Now += TimeSpan.FromMinutes(1);
        await cache.GetAsync("team", "k3", default);
        await cache.GetAsync("team", "k4", default);
        Assert.Equal(2, source.Fetches);

        time.Now += TimeSpan.FromHours(1);
        await cache.GetAsync("team", "k1", default);
        Assert.Equal(3, source.Fetches);
    }

    [Fact]
    public async Task AFailedRefreshKeepsTheLastGoodKeysAndBacksOff()
    {
        var source = new FakeKeySource();
        source.Add(new SymmetricSecurityKey(new byte[32]) { KeyId = "k1" });
        var time = new ManualTime();
        var cache = new AccessKeyCache(source, time, NullLogger<AccessKeyCache>.Instance);
        await cache.GetAsync("team", null, default);

        source.Fail = true;
        time.Now += TimeSpan.FromHours(2);
        Assert.Single(await cache.GetAsync("team", "k1", default));
        Assert.Single(await cache.GetAsync("team", "k1", default));
        Assert.Equal(2, source.Fetches);

        var empty = new AccessKeyCache(source, time, NullLogger<AccessKeyCache>.Instance);
        await Assert.ThrowsAnyAsync<Exception>(() => empty.GetAsync("other", null, default));
        await Assert.ThrowsAnyAsync<Exception>(() => empty.GetAsync("other", null, default));
        Assert.Equal(3, source.Fetches);
    }

    [Fact]
    public async Task StaleKeysAreNotTrustedAfterADay()
    {
        var source = new FakeKeySource();
        source.Add(new SymmetricSecurityKey(new byte[32]) { KeyId = "k1" });
        var time = new ManualTime();
        var cache = new AccessKeyCache(source, time, NullLogger<AccessKeyCache>.Instance);
        await cache.GetAsync("team", null, default);

        source.Fail = true;
        time.Now += TimeSpan.FromHours(23);
        Assert.Single(await cache.GetAsync("team", "k1", default));
        time.Now += TimeSpan.FromHours(1) + TimeSpan.FromMinutes(1);
        await Assert.ThrowsAnyAsync<Exception>(() => cache.GetAsync("team", "k1", default));
    }

    [Fact]
    public async Task HttpSourceReadsTheCloudflareCertsDocument()
    {
        using var rsa = RSA.Create(2048);
        var jwk = JsonWebKeyConverter.ConvertFromRSASecurityKey(new RsaSecurityKey(rsa.ExportParameters(false)) { KeyId = "abc" });
        var json = JsonSerializer.Serialize(new
        {
            keys = new[] { new { kid = jwk.Kid, kty = "RSA", alg = "RS256", use = "sig", e = jwk.E, n = jwk.N } },
            public_cert = new { kid = "abc", cert = "-----BEGIN CERTIFICATE-----" },
        });
        Uri? requested = null;
        var handler = new StubHandler(request =>
        {
            requested = request.RequestUri;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        });
        var source = new HttpAccessKeySource(new StubClientFactory(handler));
        var keys = await source.FetchSigningKeysAsync("myteam", default);
        Assert.Equal("https://myteam.cloudflareaccess.com/cdn-cgi/access/certs", requested?.ToString());
        Assert.Equal("abc", Assert.Single(keys).KeyId);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }

    private sealed class StubClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
