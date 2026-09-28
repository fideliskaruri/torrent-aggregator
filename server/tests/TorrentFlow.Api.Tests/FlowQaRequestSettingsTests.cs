using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using TorrentFlow.Api.Requests;
using TorrentFlow.Core;
using TorrentFlow.Core.Sources;

namespace TorrentFlow.Api.Tests;

/// <summary>FQ-REQ-006/007 and FQ-SET-001..005 pure + route regressions.</summary>
public sealed class FlowQaRequestSettingsTests(HostFactory factory) : IClassFixture<HostFactory>
{
    [Theory]
    [InlineData("https://m.media-amazon.com/images/M/MV5B.jpg")]
    [InlineData("https://images-na.ssl-images-amazon.com/images/M/MV5B.jpg")]
    [InlineData("https://images.metahub.space/poster/small/tt0133093/img")]
    public void SafePosterUrl_AllowsCinemetaAmazonHosts(string url) =>
        Assert.Equal(url, RequestRules.SafePosterUrl(url));

    [Fact]
    public void SafePosterUrl_StillRejectsArbitraryHosts() =>
        Assert.Null(RequestRules.SafePosterUrl("https://evil.example/p.jpg"));

    [Theory]
    [InlineData("not-a-real-key-xx", false)]
    [InlineData("your_api_key_here", false)]
    [InlineData("1234567890abcdef1234567890abcdef", true)]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false)] // repeated char
    public void TmdbKey_RequiresHexOrJwtShape(string key, bool ok) =>
        Assert.Equal(ok, TmdbCredentials.IsUsable(key));

    [Fact]
    public void BuildVersion_IsNotBareZero()
    {
        var id = BuildVersion.Id;
        Assert.False(string.IsNullOrWhiteSpace(id));
        Assert.NotEqual("0.0.0.0", id);
    }

    [Fact]
    public async Task HealthBuildId_IsNotBareZero()
    {
        using var client = factory.CreateClient();
        using var doc = JsonDocument.Parse(await client.GetStringAsync("/api/health"));
        var id = doc.RootElement.GetProperty("build").GetProperty("id").GetString();
        Assert.False(string.IsNullOrWhiteSpace(id));
        Assert.NotEqual("0.0.0.0", id);
    }

    [Fact]
    public async Task WeakTmdbKeyIsRejectedOnPut()
    {
        using var client = factory.CreateClient();
        var response = await client.PutAsJsonAsync("/api/settings/tmdb", new { apiKey = "not-a-real-key-xx" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("usable TMDB", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SourceTest_TransportFailureHasMessage()
    {
        using var client = factory.CreateClient();
        // Point a custom torznab at a closed loopback port so the test path hits transport failure.
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/settings/sources/qa-dead", new
        {
            kind = "torrent", type = "torznab", baseUrl = "http://127.0.0.1:1/api", categories = new[] { "movie" },
        })).StatusCode);
        var test = await client.PostAsync("/api/settings/sources/qa-dead/test", null);
        Assert.Equal(HttpStatusCode.OK, test.StatusCode);
        using var doc = JsonDocument.Parse(await test.Content.ReadAsStringAsync());
        Assert.False(doc.RootElement.GetProperty("ok").GetBoolean());
        var message = doc.RootElement.GetProperty("message").GetString();
        Assert.False(string.IsNullOrWhiteSpace(message), "transport failure must carry a plain-language message");
        await client.DeleteAsync("/api/settings/sources/qa-dead");
    }
}

public sealed class FlowQaRequesterCreateTests(RequesterHostFactory factory) : IClassFixture<RequesterHostFactory>
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    [Fact]
    public async Task InvalidCreatesDoNotConsumeRateLimit()
    {
        using var limited = new RateLimitedCreateFactory();
        using var client = limited.Requester($"rate-{Guid.NewGuid():N}@example.com");
        // Burst invalid bodies — must stay 400, never 429.
        for (var i = 0; i < 12; i++)
        {
            var bad = await client.PostAsJsonAsync("/api/requester/requests", new { provider = "nope", title = "x" });
            Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        }
        // A valid create still works (quota not burned by invalids).
        var ok = await client.PostAsJsonAsync("/api/requester/requests", new
        {
            provider = "tmdb", providerId = "4242", mediaType = "movie", title = "Rate Ok", year = 2001, scope = "movie",
        });
        Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        _ = await Json(ok);
    }
}

/// <summary>Creates-per-minute = 3 so a burned quota is visible; invalids must not count.</summary>
file sealed class RateLimitedCreateFactory : RequesterHostFactory
{
    protected override IDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
    {
        ["TorrentFlow:Requests:CreatesPerMinute"] = "3",
        ["TorrentFlow:Requests:SearchesPerMinute"] = "100",
    };
}
