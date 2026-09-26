using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Sources;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Api.Tests;

public sealed class KeylessTitleRouteTests
{
    [Theory]
    [InlineData("tvmaze", "216", "tv", "rick-and-morty", "Rick and Morty")]
    [InlineData("cinemeta", "tt0038650", "movie", "its-a-wonderful-life-1946", "It's a Wonderful Life")]
    [InlineData("itunes", "123", "movie", "its-a-wonderful-life-1946", "It's a Wonderful Life")]
    public async Task Keyless_provider_links_resolve_details_and_verify_acquisition_claims(
        string provider, string id, string type, string key, string title)
    {
        using var factory = new HostFactory();
        using var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("TorrentFlow:Metadata:TmdbApiKey", "");
            builder.UseSetting("TMDB_API_KEY", "");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<IHostedService>();
                services.AddHttpClient(TmdbClient.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new MetadataHandler());
            });
        });
        using var client = host.CreateClient();
        host.Services.GetRequiredService<SourceRegistry>().Update("itunes", new JsonObject { ["enabled"] = true });
        var query = $"provider={provider}&providerId={id}&type={type}&t={Uri.EscapeDataString(title)}";
        using var response = await client.GetAsync($"/api/title/{key}?{query}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var detail = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(title, detail.RootElement.GetProperty("title").GetString());
        Assert.True(detail.RootElement.GetProperty("known").GetBoolean());
        Assert.Equal(type == "tv", detail.RootElement.GetProperty("isSeries").GetBoolean());
        Assert.Contains("img.test", detail.RootElement.GetProperty("posterUrl").GetString());
        Assert.False(string.IsNullOrWhiteSpace(detail.RootElement.GetProperty("overview").GetString()));
        if (provider == "cinemeta")
            Assert.Equal("https://img.test/background.jpg", detail.RootElement.GetProperty("backdropUrl").GetString());

        using var legacy = await client.GetAsync($"/api/title/{key}?{query.Replace("providerId=", "externalId=")}");
        Assert.Equal(HttpStatusCode.OK, legacy.StatusCode);
        using var legacyDetail = JsonDocument.Parse(await legacy.Content.ReadAsStringAsync());
        Assert.True(legacyDetail.RootElement.GetProperty("known").GetBoolean());

        if (provider != "itunes")
        {
            using var extras = JsonDocument.Parse(await client.GetStringAsync($"/api/title/{key}/extras?{query}&s=2"));
            Assert.True(extras.RootElement.GetProperty("resolved").GetBoolean());
            if (provider == "tvmaze")
            {
                Assert.Equal(new[] { 1, 2 }, extras.RootElement.GetProperty("seasons").EnumerateArray().Select(x => x.GetInt32()));
                var episode = Assert.Single(extras.RootElement.GetProperty("episodes").EnumerateArray());
                Assert.Equal("Season Two", episode.GetProperty("name").GetString());
                Assert.Equal("2015-07-27T03:30:00+00:00", episode.GetProperty("airStamp").GetString());
            }
        }

        using var mismatch = await client.PostAsJsonAsync("/api/title/a-different-work", new
        {
            scope = "title", provider, providerId = id, sourceType = type, title
        });
        Assert.Equal(HttpStatusCode.BadRequest, mismatch.StatusCode);
        Assert.Contains("Provider identity does not match", await mismatch.Content.ReadAsStringAsync());
    }

    private sealed class MetadataHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var json = request.RequestUri!.AbsolutePath switch
            {
                "/shows/216" => """{"id":216,"name":"Rick and Morty","premiered":"2013-12-02","summary":"<p>A family adventure.</p>","image":{"original":"https://img.test/poster.jpg"},"externals":{"imdb":"tt2861424","thetvdb":275274}}""",
                "/shows/216/episodes" => """[{"season":1,"number":1,"name":"Pilot"},{"season":2,"number":1,"name":"Season Two","airdate":"2015-07-26","airstamp":"2015-07-27T03:30:00+00:00"}]""",
                "/meta/movie/tt0038650.json" => """{"meta":{"id":"tt0038650","name":"It's a Wonderful Life","releaseInfo":"1946","description":"An angel visits.","poster":"https://img.test/poster.jpg","background":"https://img.test/background.jpg"}}""",
                "/lookup" => """{"results":[{"trackId":123,"trackName":"It's a Wonderful Life","kind":"feature-movie","releaseDate":"1946-12-20T00:00:00Z","longDescription":"An angel visits.","artworkUrl100":"https://img.test/100x100bb.jpg"}]}""",
                _ => throw new InvalidOperationException("Unexpected metadata request: " + request.RequestUri.AbsolutePath)
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) });
        }
    }
}
