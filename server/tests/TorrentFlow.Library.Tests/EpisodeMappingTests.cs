using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Tests;

public sealed class EpisodeMappingTests
{
    private static readonly AnimeEpisodeMapping Frieren = new(2, 28,
        ["Frieren: Beyond Journey's End Season 2", "Sousou no Frieren 2nd Season"],
        ["Frieren: Beyond Journey's End", "Sousou no Frieren"]);

    [Theory]
    [InlineData("Sousou no Frieren 2nd Season - 05 [1080p]", true)]
    [InlineData("Sousou no Frieren 2nd Season S01E05 1080p", true)]
    [InlineData("Sousou no Frieren S02E05 1080p", true)]
    [InlineData("Sousou no Frieren - 33 [1080p]", true)]
    [InlineData("Sousou no Frieren - 05 [1080p]", false)]
    [InlineData("Sousou no Frieren S01E05 1080p", false)]
    [InlineData("Sousou no Frieren S02E06 1080p", false)]
    [InlineData("Sousou no Frieren S02E05-E10 1080p", false)]
    [InlineData("Sousou no Frieren S02 Complete 1080p", false)]
    public void SequelCoordinatesStayWithinTheRequestedEntry(string name, bool expected) =>
        Assert.Equal(expected, EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(name), new(1, 5), Frieren));

    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(28)]
    [InlineData(1100)]
    [InlineData(1180)]
    public void FirstSeasonAbsoluteCoordinates(int episode)
    {
        var title = episode > 28 ? "One Piece" : "Frieren";
        Assert.True(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release($"{title} - {episode:00} [1080p]"), new(1, episode)));
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release($"{title} - {episode + 1:00} [1080p]"), new(1, episode)));
    }

    [Fact]
    public void WesternSeasonAndEpisodeRemainExact()
    {
        Assert.True(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release("The Bear S01E05 1080p"), new(1, 5)));
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release("The Bear S01E50 1080p"), new(1, 5)));
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release("The Bear S10E05 1080p"), new(1, 5)));
    }

    [Fact]
    public void QueryLadderIncludesMappedCoordinates()
    {
        var rungs = EpisodeLadder.BuildEpisodeRungs(Frieren.EntryTitles[0], new(1, 5), "anime", Frieren.EntryTitles, 1080, Frieren);
        Assert.Contains(rungs, r => r.Query.EndsWith("S01E05") && r.Filters.Season == 1);
        Assert.Contains(rungs, r => r.Query.EndsWith("S02E05") && r.Filters.Season == 2 && r.Filters.Episode == 5);
        Assert.Contains(rungs, r => r.Query.EndsWith("- 33") && r.Filters.Season == null && r.Filters.Episode == 33);
    }

    [Fact]
    public async Task RealGrabPreviouslyExhaustedTenQueriesNowSendsSequelRelease()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new()
        {
            Query = o.Query,
            Results = o.Query.Contains("Sousou no Frieren 2nd Season - 05")
                ? [FakeSearch.Release("[Erai-raws] Sousou no Frieren 2nd Season - 05 [1080p CR WEB-DL AVC AAC]", 265)]
                : []
        };
        var grabs = host.Services.GetRequiredService<GrabService>();
        var input = new GrabInput(Frieren.EntryTitles[0], "anime", new EpisodeCursor(1, 5),
            Aliases: Frieren.EntryTitles, Provider: "anilist", ProviderId: "182255");
        var before = await grabs.Grab(input, default);
        Assert.False(before.Ok);
        Assert.Equal(10, host.Search.Requests.Count);
        Assert.Empty(host.Engine.Adds);

        host.Anime.Mapping = Frieren;
        var after = await grabs.Grab(input, default);
        Assert.True(after.Ok, after.Message);
        Assert.Equal("s00001e00005", Assert.Single(host.Engine.Adds).QueueKey);
    }
}
