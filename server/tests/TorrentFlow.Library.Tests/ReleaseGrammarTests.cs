using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Search;

namespace TorrentFlow.Library.Tests;

public sealed class ReleaseGrammarTests
{
    [Theory]
    [InlineData("葬送のフリーレン")]
    [InlineData("進撃の巨人")]
    [InlineData("ダンダダン")]
    public void NativeOnlyWorkIdentityMatchesExactRelease(string title)
    {
        var key = ReleaseNames.WorkKeyFor(title);
        Assert.NotEmpty(key);
        Assert.True(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release($"{title} - 05 [1080p]"), [title]));
        Assert.True(ReleaseSelection.MatchesWork(key.ToLowerInvariant(), title));
        Assert.True(ReleaseSelection.MatchesWork(Uri.UnescapeDataString(key), title));
        Assert.False(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release("別の番組 - 05 [1080p]"), [title]));
    }

    [Theory]
    [InlineData("Frieren 01-12 [1080p]", 12)]
    [InlineData("Frieren 01 - 12 [1080p]", 12)]
    [InlineData("Frieren [01–12] [1080p]", 12)]
    [InlineData("Frieren 01-12.mkv", 12)]
    public void BareRangesCannotBeAcquiredAsTheirFinalEpisode(string title, int last)
    {
        Assert.True(EpisodeParser.Parse(title).IsBatch);
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(title), new(1, last)));
    }

    [Theory]
    [InlineData("[Erai-raws] Solo Leveling S2 - 05 [1080p]", 2, 5)]
    [InlineData("[Erai-raws] Solo Leveling Season 2 - 05 [1080p]", 2, 5)]
    [InlineData("[Group] Frieren - 05 [1080p]", null, 5)]
    [InlineData("Frieren E05v2 [1080p]", null, 5)]
    [InlineData("Frieren S01E05v2 [1080p]", 1, 5)]
    [InlineData("Frieren - 05v2 [1080p]", null, 5)]
    [InlineData("[Group][Frieren][05][1080p]", null, 5)]
    [InlineData("[Frieren][05v2][1080p]", null, 5)]
    [InlineData("【喵萌奶茶屋】[葬送的芙莉莲 / Sousou no Frieren][36][1080p]", null, 36)]
    [InlineData("[北宇治字幕组] Sousou no Frieren [36][WebRip][1080p]", null, 36)]
    [InlineData("[SubsPlease] One Piece - 1100 [1080p]", null, 1100)]
    [InlineData("Mushoku Tensei S03E05 1080p", 3, 5)]
    public void SearchAndAcquisitionAgree(string title, int? season, int episode)
    {
        var search = EpisodeParser.Parse(title);
        var acquisition = ReleaseNames.ParseEpisode(title);
        Assert.Equal(search, acquisition);
        Assert.Equal(season, acquisition.Season);
        Assert.Equal(episode, acquisition.Episode);
        Assert.False(acquisition.IsSeasonPack);
        Assert.True(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(title), new(season ?? 1, episode)));
    }

    [Theory]
    [InlineData("Solo Leveling S01-S02 Complete 1080p")]
    [InlineData("Solo Leveling Seasons 1-2 1080p")]
    [InlineData("Solo Leveling S2 - 05 Batch 1080p")]
    [InlineData("Frieren - 01-28 [1080p]")]
    [InlineData("Frieren [01-28] [1080p]")]
    [InlineData("Frieren S01E01E02 1080p")]
    public void PacksNeverBecomeSingles(string title) =>
        Assert.False(EpisodeLadder.MatchesTargetEpisode(FakeSearch.Release(title), new(1, 1)));

    [Theory]
    [InlineData("[Group][Frieren][05][1080p]", "Frieren")]
    [InlineData("【喵萌奶茶屋】[葬送的芙莉莲 / Sousou no Frieren][36][1080p]", "Sousou no Frieren")]
    [InlineData("[北宇治字幕组] Sousou no Frieren [36][WebRip][1080p]", "Sousou no Frieren")]
    [InlineData("Frieren E05v2 [1080p]", "Frieren")]
    [InlineData("Shōgun S01E05 1080p", "Shōgun")]
    [InlineData("Pokémon S01E05 1080p", "Pokémon")]
    public void BracketAndUnicodeTitlesKeepTheirIdentity(string release, string title)
    {
        Assert.True(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release(release), [title]), release);
        Assert.False(EpisodeLadder.ReleaseMatchesWork(FakeSearch.Release(release), ["Other Show"]));
    }

    [Theory]
    [InlineData("1920x1080", 1080)]
    [InlineData("1440x1080", 1080)]
    [InlineData("1920×1080", 1080)]
    [InlineData("FHD", 1080)]
    [InlineData("1080i", 1080)]
    [InlineData("4k", 2160)]
    [InlineData("3840x2160", 2160)]
    [InlineData("4k Remastered 1080p", 1080)]
    [InlineData("4kto1080p", 1080)]
    [InlineData("720p", 720)]
    [InlineData("Unknown", null)]
    public void AllResolutionPathsUseTheSameFloor(string quality, int? expected)
    {
        var title = $"Solo Leveling S02E05 {quality}";
        Assert.Equal(expected, ReleaseSelection.Resolution(title));
        Assert.Equal(expected, ReleaseQuality.ParseResolution(title));
        Assert.Equal(expected, TorrentFlow.Media.Playback.Releases.ParseResolution(title));
        Assert.Equal(expected >= 1080, ReleaseSelection.MeetsFloor(title, 1080));
        Assert.Equal(expected == 1080, TorrentFilters.Apply([FakeSearch.Release(title)], new() { Resolution = "1080p" }).Count == 1);
    }
}
