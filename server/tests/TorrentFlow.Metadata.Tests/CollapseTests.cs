using System.Text.RegularExpressions;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Metadata.Tests;

/// <summary>Port of src/lib/browse/collapse.test.ts: a rail shows works, not releases.</summary>
public class CollapseTests
{
    private static DateTime At(int minute) => new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(minute);

    private static CollapsibleRelease<string> Release(string name, int minute, bool hasArtwork = false) =>
        new(name, At(minute), name) { HasArtwork = hasArtwork };

    private static List<CollapsedWork<string>> Collapse(params string[] names) =>
        WorkCollapse.CollapseReleasesByWork(names.Select((n, i) => Release(n, i)));

    [Theory]
    [InlineData("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX", "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP")]
    [InlineData("Oppenheimer.2023.1080p.WEBRip.x265-RARBG", "Oppenheimer.2023.1080p.BluRay.x264.AAC-YTS")]
    [InlineData("The.Batman.2022.2160p.UHD.BluRay.x265-TERMINAL", "The.Batman.2022.2160p.UHD.BluRay.x265-SURCODE")]
    [InlineData("Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND", "Breaking.Bad.S05E15.1080p.BluRay.x264-DEMAND")]
    [InlineData("Family.Guy.S21E01.720p.WEB.h264-KOGi", "Family.Guy.S21.COMPLETE.1080p.WEB.h264-GROUP")]
    [InlineData("[SubsPlease] One Piece - 1233 (1080p) [ABCD1234].mkv", "[Erai-raws] One Piece - 1234 [1080p][Multiple Subtitle]")]
    [InlineData("www.SomeTracker.to - Inside.Out.2.2024.1080p.WEB-DL.x264", "Inside.Out.2.2024.2160p.WEB-DL.HDR.x265")]
    [InlineData("Rick.and.Morty.S01E01.1080p.WEB-DL.x264-GROUP", "www.UIndex.org - Rick and Morty S01E02 1080p WEB-DL x264")]
    [InlineData("Instant Harness 4242.S01E02.1080p.WEB-DL-GROUPA.mp4", "Instant Harness 4242.S01E02.2160p.WEB-DL-GROUPB.mp4")]
    public void One_work_many_releases_is_one_card(string a, string b)
    {
        var collapsed = Collapse(a, b);
        var card = Assert.Single(collapsed);
        Assert.Equal(2, card.ReleaseCount);
        Assert.DoesNotMatch(new Regex("^s\\d{1,3}e\\d{1,4}$", RegexOptions.IgnoreCase), card.Title);
    }

    [Theory]
    [InlineData("Dune.1984.1080p.BluRay.x264-AMIABLE", "Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX")]
    [InlineData("Total.Recall.1990.1080p.BluRay.x264-GROUP", "Total.Recall.2012.1080p.BluRay.x264-GROUP")]
    [InlineData("Dune.Part.Two.2024.1080p.WEB-DL.x264", "Dune.2021.1080p.WEB-DL.x264")]
    [InlineData("The.Simpsons.S34E01.1080p.WEB.h264-CAKES", "Family.Guy.S21E01.1080p.WEB.h264-CAKES")]
    [InlineData("Fargo.S05E01.1080p.WEB.h264-GROUP", "Fargo.1996.1080p.BluRay.x264-GROUP")]
    public void Distinct_works_stay_distinct(string a, string b) => Assert.Equal(2, Collapse(a, b).Count);

    [Fact]
    public void Keeps_the_newest_member_when_none_has_artwork()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            Release("Sicario.2015.720p.BluRay.x264-GROUP", 1),
            Release("Sicario.2015.2160p.WEB-DL.x265-GROUP", 9),
            Release("Sicario.2015.1080p.BluRay.x264-GROUP", 5),
        ]);
        Assert.Equal("Sicario.2015.2160p.WEB-DL.x265-GROUP", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void Keeps_the_member_with_artwork_over_a_newer_one()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            Release("Arrival.2016.1080p.BluRay.x264-GROUP", 1, true),
            Release("Arrival.2016.2160p.WEB-DL.x265-GROUP", 9),
        ]);
        Assert.Equal("Arrival.2016.1080p.BluRay.x264-GROUP", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void A_preferred_representative_wins_despite_being_older()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            new CollapsibleRelease<string>("The.Bear.S01E04.1080p.WEB.h264-GROUP", At(9), "single"),
            new CollapsibleRelease<string>("The.Bear.S01.COMPLETE.1080p.WEB.h264-GROUP", At(1), "pack") { Prefer = true },
        ]);
        Assert.Equal("pack", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void A_bridge_release_preserves_the_best_absorbed_representative()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            new CollapsibleRelease<string>("Bridge.Show.S01E01.1080p.WEB.h264-GROUP", At(9), "plain") { WorkKey = "legacy-bridge-show" },
            new CollapsibleRelease<string>("Canonical Bridge", At(1), "artwork") { IdentityKey = "provider:bridge-show", WorkKey = "canonical-bridge", HasArtwork = true },
            new CollapsibleRelease<string>("Bridge.Show.S01.COMPLETE.1080p.WEB.h264-GROUP", At(5), "bridge")
            {
                IdentityKey = "provider:bridge-show", WorkKey = "legacy-bridge-show", WorkTitle = "Canonical Bridge",
            },
        ]);
        Assert.Equal("artwork", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void Among_members_with_artwork_the_newest_wins()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            Release("Heat.1995.1080p.BluRay.x264-GROUP", 2, true),
            Release("Heat.1995.2160p.UHD.BluRay.x265-GROUP", 8, true),
        ]);
        Assert.Equal("Heat.1995.2160p.UHD.BluRay.x265-GROUP", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void First_seen_order_is_preserved()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([
            Release("Nosferatu.2024.2160p.WEB-DL.x265", 30),
            Release("The.Bear.S03E01.1080p.WEB.h264", 20),
            Release("Nosferatu.2024.1080p.WEB-DL.x264", 25),
            Release("Shogun.S01E01.1080p.WEB.h264", 10),
        ]);
        Assert.Equal(["Nosferatu", "The", "Shogun"], collapsed.Select(c => c.Value.Split('.')[0]));
    }

    [Fact]
    public void Blank_names_are_dropped()
    {
        var collapsed = WorkCollapse.CollapseReleasesByWork([Release("", 1), Release("   ", 2), Release("Alien.1979.1080p.BluRay.x264-GROUP", 3)]);
        Assert.Equal("Alien.1979.1080p.BluRay.x264-GROUP", Assert.Single(collapsed).Value);
    }

    [Fact]
    public void Empty_input_is_an_empty_rail() => Assert.Empty(WorkCollapse.CollapseReleasesByWork(Array.Empty<CollapsibleRelease<string>>()));

    [Fact]
    public void A_single_release_has_release_count_one() =>
        Assert.Equal(1, Assert.Single(Collapse("Poor.Things.2023.1080p.WEB-DL.x264-GROUP")).ReleaseCount);

    [Fact]
    public void Episode_only_names_do_not_become_titles() =>
        Assert.Equal(WorkCollapse.UnknownWorkTitle, Assert.Single(Collapse("S01E02")).Title);

    [Fact]
    public void Numbered_series_keep_their_number() =>
        Assert.Equal(["Instant Harness 4242", "Instant Harness 4343"],
            Collapse("Instant Harness 4242.S01E02.1080p.WEB-DL-GROUPA.mp4", "Instant Harness 4343.S01E02.1080p.WEB-DL-GROUPA.mp4").Select(w => w.Title));
}
