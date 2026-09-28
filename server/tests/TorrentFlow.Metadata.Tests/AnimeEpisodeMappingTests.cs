using System.Text.Json;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Tests;

public sealed class AnimeEpisodeMappingTests
{
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
}
