using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Tests;

public sealed class AnimePremiereIdentityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnimeEpisodeNeverSelectsTheExplicitlyDatedLiveActionRemake(bool background)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        const string remake = "Cowboy Bebop 2021 S01E05 Darkside Tango 1080p 10bit WEBRip 6CH x265 HEVC-PS";
        const string anime = "[Group] Cowboy Bebop - 05 [1080p]";
        host.Search.Respond = o => new()
        {
            Query = o.Query,
            Results = [FakeSearch.Release(remake, 1000), FakeSearch.Release(anime, 20) with { InfoHash = new string('b', 40) }]
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(
            new("Cowboy Bebop", "anime", new(1, 5), Year: 1998, Background: background), default);
        Assert.True(result.Ok, result.Message);
        Assert.Equal(anime, Assert.Single(host.Engine.Adds).Name);
    }

    [Fact]
    public void MatchingPremiereYearAndUnspecifiedReleaseYearRemainEligible()
    {
        Assert.True(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release("Cowboy Bebop 1998 S01E05 1080p"), ["Cowboy Bebop"], 1998));
        Assert.True(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release("Cowboy Bebop S01E05 1080p"), ["Cowboy Bebop"], 1998));
    }

    [Fact]
    public async Task MappedSequelMayUseTheFranchisesPremiereYear()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example 2020 S02E03 1080p")] };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(
            new("Example Season 2", "anime", new(1, 3), Year: 2023,
                EpisodeMapping: new AnimeEpisodeMapping(2, 12, ["Example Season 2"], ["Example"])), default);
        Assert.True(result.Ok, result.Message);
    }
}
