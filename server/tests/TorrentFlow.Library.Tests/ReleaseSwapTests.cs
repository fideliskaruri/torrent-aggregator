using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Tests;

public sealed class ReleaseSwapTests
{
    private static TorrentResult Release(int n, string title) => new()
    {
        Id = n.ToString(), Title = title, InfoHash = n.ToString("x40"),
        Magnet = $"magnet:?xt=urn:btih:{n:x40}", Seeders = 20, Source = "test", SourceUrl = "",
    };

    [Fact]
    public void PreservesSearchRankingAndExcludesCurrentTriedDuplicateWrongWorkAndQuality()
    {
        var ranked = new[] { Release(1, "Big Buck Bunny 2008 1080p"), Release(2, "Big Buck Bunny 2008 1080p"),
            Release(3, "Big Buck Bunny 2008 1080p"), Release(3, "Big Buck Bunny 2008 1080p"),
            Release(4, "Big Buck Bunny 2008 720p"), Release(5, "Other Movie 2008 1080p"),
            Release(6, "Big Buck Bunny 2008 2160p") };
        var selected = ReleaseSwapService.Select(ranked, ReleaseNames.WorkKeyFor("Big Buck Bunny", 2008),
            "Big Buck Bunny", null, null, 1080, new HashSet<string>([1.ToString("x40"), 2.ToString("x40")]));
        Assert.Equal(["3", "6"], selected.Select(r => r.Id));
    }

    [Fact]
    public void EpisodeNeverSwitchesSeasonOrAcquiresPack()
    {
        var selected = ReleaseSwapService.Select([Release(1, "Example Show S02E01 1080p"),
            Release(2, "Example Show S01E01 1080p"), Release(3, "Example Show S02 Complete 1080p"),
            Release(4, "Example Show S02E02 1080p")], "example-show", "Example Show", new EpisodeCursor(2, 1), null, 1080,
            new HashSet<string>());
        Assert.Equal("1", Assert.Single(selected).Id);
    }
}
