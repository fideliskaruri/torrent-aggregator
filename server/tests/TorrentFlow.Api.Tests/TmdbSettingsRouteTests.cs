using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TorrentFlow.Api.Tests;

public sealed class TmdbSettingsRouteTests(HostFactory factory) : IClassFixture<HostFactory>
{
    private const string Key = "1234567890abcdef1234567890abcdef";

    [Fact]
    public async Task Save_get_remove_never_return_the_credential()
    {
        using var client = factory.CreateClient();
        var saved = await client.PutAsJsonAsync("/api/settings/tmdb", new { apiKey = Key });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        foreach (var response in new[] { saved, await client.GetAsync("/api/settings/tmdb") })
        {
            var json = await response.Content.ReadAsStringAsync();
            Assert.DoesNotContain(Key, json);
            using var body = JsonDocument.Parse(json);
            Assert.True(body.RootElement.GetProperty("configured").GetBoolean());
            Assert.Equal("••••cdef", body.RootElement.GetProperty("hint").GetString());
            Assert.Equal("settings", body.RootElement.GetProperty("source").GetString());
        }
        var removed = await client.DeleteAsync("/api/settings/tmdb");
        Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
        Assert.DoesNotContain(Key, await removed.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("PUT", "cross-site")]
    [InlineData("DELETE", "same-site")]
    [InlineData("POST", "cross-site")]
    public async Task Mutations_reject_cross_site(string method, string site)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new(method), "/api/settings/tmdb" + (method == "POST" ? "/test" : ""));
        request.Headers.Add("Sec-Fetch-Site", site);
        request.Content = JsonContent.Create(new { apiKey = Key });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(request)).StatusCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("your_api_key_here")]
    public async Task Invalid_keys_are_not_echoed(string key)
    {
        using var client = factory.CreateClient();
        var response = await client.PutAsJsonAsync("/api/settings/tmdb", new { apiKey = key });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        if (key.Length > 0) Assert.DoesNotContain(key, await response.Content.ReadAsStringAsync());
    }
}
