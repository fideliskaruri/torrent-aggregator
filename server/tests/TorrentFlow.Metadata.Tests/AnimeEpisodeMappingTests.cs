using System.Text.Json;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Tests;

public sealed class AnimeEpisodeMappingTests
{
    [Fact]
    public void PartialChainKeepsCourIdentityAndEveryKnownPrequelAliasWithoutGuessingAbsoluteOffset()
    {
        var mapping = AniListClient.MapEpisodeChain([
            Entry("Attack on Titan Final Season Part 2", 12),
            Entry("Attack on Titan Final Season", 16),
            Entry("Attack on Titan Season 3 Part 2", 10),
            Entry("Attack on Titan Season 3", 12),
            Entry("Attack on Titan Season 2", 12),
            Entry("Attack on Titan", 25)], complete: false);
        Assert.Null(mapping.AbsoluteOffset);
        Assert.True(mapping.IsSequel);
        Assert.Contains("Attack on Titan Final Season", mapping.PrequelTitles!);
        Assert.Contains("Attack on Titan", mapping.FranchiseTitles);
    }
    private static JsonElement Entry(string title, int? episodes, string status = "FINISHED") =>
        JsonSerializer.SerializeToElement(new { title = new { english = title }, episodes, status });

    [Theory]
    [InlineData("Frieren Season 2", 28, 2, 28)]
    [InlineData("Solo Leveling Season 2", 12, 2, 12)]
    [InlineData("Mushoku Tensei 3rd Season", 48, 3, 48)]
    public void CompletedPrequelsSupplyAbsoluteOffsets(string title, int previousCount, int season, int offset)
    {
        var mapping = AniListClient.MapEpisodeChain([Entry(title, 12), Entry("Base title", previousCount)]);
        Assert.Equal(season, mapping.FranchiseSeason);
        Assert.Equal(offset, mapping.AbsoluteOffset);
    }

    [Fact]
    public void SplitCourCountsDoNotInventAnotherSeason()
    {
        var mapping = AniListClient.MapEpisodeChain([
            Entry("Mushoku Tensei 3rd Season", null, "RELEASING"),
            Entry("Mushoku Tensei 2nd Season Part 2", 12),
            Entry("Mushoku Tensei 2nd Season", 12),
            Entry("Mushoku Tensei Part 2", 12),
            Entry("Mushoku Tensei", 11)]);
        Assert.Equal(3, mapping.FranchiseSeason);
        Assert.Equal(47, mapping.AbsoluteOffset);
        Assert.Equal(0, mapping.SeasonEpisodeOffset);
    }

    [Fact]
    public void SameSeasonSplitCourMapsLocalToSeasonEpisode()
    {
        var mapping = AniListClient.MapEpisodeChain([
            Entry("Mushoku Tensei 2nd Season Part 2", 12),
            Entry("Mushoku Tensei 2nd Season", 12),
            Entry("Mushoku Tensei", 23)]);
        Assert.Equal(2, mapping.FranchiseSeason);
        Assert.Equal(12, mapping.SeasonEpisodeOffset);
        Assert.Equal(35, mapping.AbsoluteOffset);
    }

    [Fact]
    public void SplitCourWithoutKnownCountsDoesNotMapToTheFirstCoursEpisode()
    {
        var mapping = AniListClient.MapEpisodeChain([
            Entry("Mushoku Tensei 2nd Season Part 2", 12),
            Entry("Mushoku Tensei 2nd Season", null)]);
        Assert.Null(mapping.FranchiseSeason);
        Assert.Null(mapping.AbsoluteOffset);
    }

    [Theory]
    [InlineData(null, "FINISHED")]
    [InlineData(12, "RELEASING")]
    public void UnknownOrIncompletePrequelNeverGuessesOffset(int? count, string status)
    {
        var mapping = AniListClient.MapEpisodeChain([Entry("Frieren Season 2", 10), Entry("Frieren", count, status)]);
        Assert.Equal(2, mapping.FranchiseSeason);
        Assert.Null(mapping.AbsoluteOffset);
    }

    [Fact]
    public void UnnumberedSequelDoesNotUseRelationCountAsSeason()
    {
        var mapping = AniListClient.MapEpisodeChain([Entry("Different subtitle", 12), Entry("Original", 12)]);
        Assert.Null(mapping.FranchiseSeason);
        Assert.Equal(12, mapping.AbsoluteOffset);
    }

    [Fact]
    public void AniListNamesIncludeAllProviderSynonyms()
    {
        var media = JsonSerializer.SerializeToElement(new
        {
            id = 1, title = new { english = "Frieren", romaji = "Sousou no Frieren", native = "葬送のフリーレン" },
            synonyms = new[] { "Frieren: Beyond Journey's End", "Frieren", "" }
        });
        var result = AniListClient.Map(media);
        Assert.Equal(4, result.Aliases!.Count);
        Assert.Contains("Sousou no Frieren", result.Aliases);
        Assert.Contains("Frieren: Beyond Journey's End", result.Aliases);
    }

    [Fact]
    public async Task MappingFetchesVerifiedPrequelsOnceAndCachesAcrossEpisodes()
    {
        var handler = new FakeHandler(async request =>
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var id = body.RootElement.GetProperty("variables").GetProperty("id").GetInt32();
            var media = new
            {
                id, title = new { english = id == 2 ? "Frieren Season 2" : "Frieren" }, synonyms = new[] { id == 2 ? "Sousou no Frieren 2nd Season" : "Sousou no Frieren" },
                format = "TV", status = "FINISHED", episodes = id == 2 ? 10 : 28,
                relations = new { edges = id == 2 ? new[] { new { relationType = "PREQUEL", node = new { id = 1, type = "ANIME", format = "TV" } } } : [] }
            };
            return FakeHandler.Json(JsonSerializer.Serialize(new { data = new { Media = media } }));
        });
        var client = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        var mappings = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.GetEpisodeMappingAsync("2")));
        Assert.All(mappings, m => Assert.Equal(28, m!.AbsoluteOffset));
        Assert.All(mappings, m => Assert.Contains("Sousou no Frieren", m!.FranchiseTitles));
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(28, (await client.GetEpisodeMappingAsync("2"))!.AbsoluteOffset);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData("MOVIE", 1)]
    [InlineData("SPECIAL", 1)]
    [InlineData("TV", 2)]
    public async Task AmbiguousOrNonSeriesPrequelsDoNotProduceAbsoluteOffsets(string format, int count)
    {
        var media = new
        {
            id = 2, title = new { english = "Frieren Season 2" }, format = "TV", status = "FINISHED", episodes = 10,
            relations = new { edges = Enumerable.Range(0, count).Select(n => new { relationType = "PREQUEL", node = new { id = n + 10, type = "ANIME", format } }).ToArray() }
        };
        var handler = FakeHandler.Always(JsonSerializer.Serialize(new { data = new { Media = media } }));
        var client = new AniListClient(new FakeHttpFactory(handler), new ManualTime());
        var result = await client.GetEpisodeMappingAsync("2");
        Assert.Equal(2, result!.FranchiseSeason);
        Assert.Null(result.AbsoluteOffset);
        Assert.Contains("Frieren", result.FranchiseTitles);
        Assert.Single(handler.Requests);
    }
}
