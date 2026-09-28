using System.Net;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Tests;

public sealed class AnimeIdentityCacheTests
{
    private const string Frieren = """
        {"id":154587,"title":{"english":"Frieren: Beyond Journey’s End","romaji":"Sousou no Frieren"},
         "format":"TV","status":"FINISHED","episodes":28,"seasonYear":2023}
        """;

    [Fact]
    public async Task DiscoveryIdentitySurvivesAForbiddenByIdEndpointDuringTheTitleFlow()
    {
        var calls = 0;
        using var handler = new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(
            ++calls == 1 ? HttpStatusCode.OK : HttpStatusCode.Forbidden)
        {
            Content = new StringContent("""{"data":{"Page":{"media":[""" + Frieren + "]}}}")
        }));
        var client = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        var discovered = Assert.Single(await client.SearchWorksAsync("Frieren"));
        var detail = await client.GetWorkByIdAsync("154587");
        var grab = await client.GetByIdAsync("154587");
        Assert.Equal(discovered, detail);
        Assert.Equal(discovered.Metadata, grab);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task SuccessfulByIdLookupIsBoundedAndExpires()
    {
        using var handler = FakeHandler.Always("""{"data":{"Media":""" + Frieren + "}}");
        var time = new ManualTime();
        var client = new AniListClient(new FakeHttpFactory(handler), time);
        Assert.NotNull(await client.GetWorkByIdAsync("154587"));
        Assert.NotNull(await client.GetWorkByIdAsync("154587"));
        Assert.Single(handler.Requests);
        time.Advance(TimeSpan.FromMinutes(6));
        Assert.NotNull(await client.GetWorkByIdAsync("154587"));
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, """{"data":{"Media":null}}""")]
    [InlineData(HttpStatusCode.OK, """{"data":{"Media":{"id":182255,"title":{"english":"Different entry"}}}}""")]
    public async Task FailuresAndWrongProviderIdsAreNotRemembered(HttpStatusCode status, string body)
    {
        using var handler = new FakeHandler(_ => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) }));
        var client = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        Assert.Null(await client.GetWorkByIdAsync("154587"));
        Assert.Null(await client.GetWorkByIdAsync("154587"));
        Assert.Equal(2, handler.Requests.Count);
    }
}
