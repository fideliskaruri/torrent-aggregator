using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Tests;

public sealed class EpisodeMappingTests
{
    [Theory]
    [InlineData("[Erai-raws] Shingeki no Kyojin - The Final Season - 03 [1080p][Multiple Subtitle].mkv", false)]
    [InlineData("[Erai-raws] Shingeki no Kyojin - The Final Season Part 2 - 03 [1080p][Multiple Subtitle][525B4EBE].mkv", true)]
    public void IncompletePrequelChainNeverTreatsEarlierCourAsLocalEpisode(string name, bool expected)
    {
        var mapping = new AnimeEpisodeMapping(null, null,
            ["Attack on Titan Final Season Part 2", "Shingeki no Kyojin: The Final Season Part 2", "Shingeki no Kyojin: The Final Season (2022)", "SnK 4"],
            ["Attack on Titan", "Shingeki no Kyojin"],
            PrequelTitles: ["Attack on Titan Final Season", "Shingeki no Kyojin: The Final Season", "SnK 4"], IsSequel: true);
        Assert.Equal(expected, EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(name), new(1, 3), mapping));
    }

    [Fact]
    public void SharedBleachCourAliasDoesNotQualifyAnEarlierCoursEpisode()
    {
        var mapping = new AnimeEpisodeMapping(null, 379,
            ["BLEACH: Thousand-Year Blood War - The Separation", "BLEACH TYBW"], ["Bleach"],
            PrequelTitles: ["BLEACH: Thousand-Year Blood War", "BLEACH TYBW"], IsSequel: true);
        Assert.False(EpisodeLadder.MatchesTargetEpisode(
            FakeSearch.Release("[NPA_Zero&iDerKaiser0] Bleach TYBW - 03 [KoksalProduction] (1080p) (ArabicSub).mp4"), new(1, 3), mapping));
    }

    [Theory]
    [InlineData("[Erai-raws] Shingeki no Kyojin - The Final Season Part 2 - 03 [1080p][Multiple Subtitle][525B4EBE].mkv", 3)]
    [InlineData("[Erai-raws] Dr. Stone: Science Future Part 3 - 04 [1080p CR WEB-DL AVC AAC][MultiSub][F25746BE]", 4)]
    [InlineData("Example Cour 2 - 03 [1080p]", 3)]
    public void CourNumberBeforeEpisodeIsNotABareEpisodeRange(string name, int episode)
    {
        var parsed = ReleaseNames.ParseEpisode(name);
        Assert.False(parsed.IsBatch);
        Assert.Equal(episode, parsed.Episode);
    }

    [Fact]
    public void RealEpisodeRangeAfterCourLabelRemainsABatch() =>
        Assert.True(ReleaseNames.ParseEpisode("Example Part 2 - 03-04 [1080p]").IsBatch);

    [Theory]
    [InlineData(2)]
    [InlineData(3)]
    public void CourNumberIsPreservedInExactWorkIdentity(int episode)
    {
        var name = $"[Erai-raws] Shingeki no Kyojin - The Final Season Part 2 - {episode:00} [1080p][Multiple Subtitle][525B4EBE].mkv";
        Assert.True(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release(name), ["Shingeki no Kyojin: The Final Season Part 2"]));
        Assert.False(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release(name), ["Shingeki no Kyojin: The Final Season Part 3"]));
    }

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

    public static IEnumerable<object[]> FrierenSeasonOne =>
        Enumerable.Range(1, 28).Select(episode => new object[] { episode });

    [Theory]
    [MemberData(nameof(FrierenSeasonOne))]
    public void EveryFrierenFirstSeasonAbsoluteEpisodeRemainsExact(int episode)
    {
        var release = FakeSearch.Release($"[SubsPlease] Sousou no Frieren - {episode:00} (1080p) [ABC12345].mkv");
        Assert.True(EpisodeLadder.MatchesTargetEpisode(release, new(1, episode)));
        Assert.False(EpisodeLadder.MatchesTargetEpisode(release, new(1, episode + 1)));
    }

    [Theory]
    [InlineData("Mushoku Tensei 3rd Season", "Mushoku Tensei", 3, 47, "Mushoku Tensei S03E05 1080p")]
    [InlineData("Mushoku Tensei 3rd Season", "Mushoku Tensei", 3, 47, "Mushoku Tensei - 52 [1080p]")]
    [InlineData("Solo Leveling Season 2", "Solo Leveling", 2, 12, "Solo Leveling S2 - 05 [1080p]")]
    public void OtherSequelFranchisesUseMappedReleaseCoordinates(string entry, string franchise, int season, int offset, string release)
    {
        var mapping = new AnimeEpisodeMapping(season, offset, [entry], [franchise]);
        Assert.True(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(release), new(1, 5), mapping));
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(release), new(1, 6), mapping));
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

    [Theory]
    [InlineData("Frieren: Beyond Journey's End S02E05 1080p", "S02E05")]
    [InlineData("Sousou no Frieren - 33 [1080p]", "- 33")]
    [InlineData("Frieren - 33 [1080p]", "- 33")]
    public async Task BaseFranchiseAliasWorksForSequelWithoutAcceptingSeasonOne(string release, string coordinate)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Anime.Mapping = Frieren with { FranchiseTitles = [.. Frieren.FranchiseTitles, "Frieren"] };
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = o.Query.EndsWith(coordinate)
                ? [FakeSearch.Release("Frieren S01E05 1080p") with { InfoHash = new string('b', 40) }, FakeSearch.Release(release)]
                : []
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(
            new(Frieren.EntryTitles[0], "anime", new(1, 5), Provider: "anilist", ProviderId: "182255"), default);
        Assert.True(result.Ok, result.Message);
        Assert.Equal(release, Assert.Single(host.Engine.Adds).Name);
    }

    [Fact]
    public void EveryDistinctAliasGetsAQueryInsteadOfOnlyTwoSpellings()
    {
        string[] aliases = ["Sousou no Frieren", "SousounoFrieren", "葬送のフリーレン", "Frieren"];
        var rungs = EpisodeLadder.BuildEpisodeRungs("Frieren: Beyond Journey's End", new(1, 5), "anime", aliases);
        foreach (var alias in aliases.Where(a => a != "SousounoFrieren"))
            Assert.Contains(rungs, r => r.Query == $"{alias} S01E05");
        Assert.DoesNotContain(rungs, r => r.Query.StartsWith("SousounoFrieren "));
    }

    [Fact]
    public async Task MappingAliasesPersistAndAreReusedByLegacyCallers()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.Works.Add(new()
        {
            Id = "anime", WorkKey = "frieren-season-2", CanonicalTitle = Frieren.EntryTitles[0], MediaType = "anime",
            Provider = "anilist", ProviderId = "182255", AliasesJson = "[\"Saved alternate title\"]",
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow
        }));
        host.Anime.Mapping = Frieren;
        var grabs = host.Services.GetRequiredService<GrabService>();
        await grabs.Grab(new(Frieren.EntryTitles[0], "anime", new(1, 5), WorkId: "anime"), default);
        await host.Seed(db =>
        {
            var work = db.Works.Single(w => w.Id == "anime");
            Assert.Contains("Sousou no Frieren", work.AliasesJson);
            Assert.Contains("Saved alternate title", work.AliasesJson);
        });
        host.Anime.Mapping = null;
        host.Search.Requests.Clear();
        await grabs.Grab(new(Frieren.EntryTitles[0], "anime", new(1, 5), WorkId: "anime"), default);
        Assert.Contains(host.Search.Requests, r => r.Query.StartsWith("Saved alternate title "));
    }
}
