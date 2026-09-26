using TorrentFlow.Metadata.Title;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Recommend;
using Microsoft.Extensions.Logging.Abstractions;

namespace TorrentFlow.Metadata.Tests;

public sealed class AirDateTests
{
    [Theory]
    [InlineData("2026-09-26", 0)]
    [InlineData("2026-09-26T03:00:00+03:00", 0)]
    [InlineData("2026-09-26T12:00:00Z", 12)]
    public void DatesAreNormalizedToUtc(string text, int hour) =>
        Assert.Equal(new DateTime(2026, 9, 26, hour, 0, 0, DateTimeKind.Utc), AirDateLookup.Parse(text));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("unknown")]
    public void UnknownDatesFallBack(string? text) => Assert.Null(AirDateLookup.Parse(text));

    [Fact]
    public async Task AdapterUsesExactProviderSeasonAndEpisodeAndCachesExtras()
    {
        var handler = new FakeHandler(r => Task.FromResult(FakeHandler.Json(
            r.RequestUri!.AbsolutePath.EndsWith("/tv/123/season/2", StringComparison.Ordinal)
                ? """{"episodes":[{"episode_number":1,"air_date":"2026-09-01"},{"episode_number":3,"air_date":"2026-09-26"}]}"""
                : r.RequestUri.AbsolutePath.EndsWith("/tv/123", StringComparison.Ordinal)
                    ? """{"id":123,"seasons":[{"season_number":2,"episode_count":3}]}"""
                    : """{"results":[]}""")));
        var factory = new FakeHttpFactory(handler);
        var time = new ManualTime();
        var tmdb = new TmdbClient(factory, Fixtures.Options(Fixtures.TmdbKey), time);
        var anilist = new AniListClient(factory, time);
        var keyless = new KeylessClients(factory);
        var extras = new TitleExtrasService(tmdb, anilist, keyless,
            new ArtworkResolver(tmdb, anilist, keyless, Fixtures.Options(Fixtures.TmdbKey), time),
            new RecommendationService(factory, tmdb, null!, time, NullLogger<RecommendationService>.Instance),
            time, NullLogger<TitleExtrasService>.Instance);
        var lookup = new AirDateLookup(extras);
        Assert.Equal(new DateTime(2026, 9, 26, 0, 0, 0, DateTimeKind.Utc),
            await lookup.GetAirDateAsync("Ambiguous title", "tv", "123", 2, 3, default));
        var calls = handler.Requests.Count;
        Assert.Null(await lookup.GetAirDateAsync("Ambiguous title", "tv", "123", 2, 4, default));
        Assert.Equal(calls, handler.Requests.Count);
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.Contains("/search/", StringComparison.Ordinal));
    }
}
