using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TorrentFlow.Api.Tests;

public sealed class SourcesRouteTests(HostFactory factory) : IClassFixture<HostFactory>
{
    [Fact]
    public async Task Registry_round_trip_masks_credentials_and_removes_custom_entry()
    {
        using var client = factory.CreateClient();
        const string key = "1234567890abcdef1234567890abcdef";
        var response = await client.PutAsJsonAsync("/api/settings/sources/test-indexer", new
        { kind = "torrent", type = "torznab", baseUrl = "http://localhost:9117/api", categories = new[] { "movie" }, credential = key });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain(key, await response.Content.ReadAsStringAsync());
        var json = await client.GetStringAsync("/api/settings/sources");
        Assert.DoesNotContain(key, json);
        using var parsed = JsonDocument.Parse(json);
        var item = parsed.RootElement.GetProperty("sources").EnumerateArray().Single(e => e.GetProperty("id").GetString() == "test-indexer");
        Assert.True(item.GetProperty("credential").GetProperty("configured").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync("/api/settings/sources/test-indexer")).StatusCode);
        Assert.DoesNotContain("test-indexer", await client.GetStringAsync("/api/settings/sources"));
    }

    [Theory]
    [InlineData("PUT", "")]
    [InlineData("DELETE", "")]
    [InlineData("POST", "/test")]
    public async Task Cross_site_source_mutations_are_forbidden(string method, string suffix)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new(method), "/api/settings/sources/tvmaze" + suffix)
        { Content = JsonContent.Create(new { enabled = false }) };
        request.Headers.Add("Sec-Fetch-Site", "cross-site");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(request)).StatusCode);
    }

    [Theory]
    [InlineData("file:///private")]
    [InlineData("https://user:password@example.com")]
    [InlineData("https://example.com?apikey=secret")]
    public async Task Invalid_urls_are_rejected_without_echo(string url)
    {
        using var client = factory.CreateClient();
        var response = await client.PutAsJsonAsync("/api/settings/sources/tvmaze", new { baseUrl = url });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain(url, await response.Content.ReadAsStringAsync());
    }
}
