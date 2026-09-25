using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Tests;

public sealed class DirectPlayParityTests
{
    // Expected values come from running quality.ts directPlayableFromTitle on each title. AV1/VP9/MP3 and WebM are not
    // direct under the default browser profile, so they must rank below an unlabelled release, as they do in TypeScript.
    [Theory]
    [InlineData("Breaking Bad S01 1080p BluRay AV1 Opus [AV1D]", false)]
    [InlineData("Breaking Bad (S01)(2008)(1080p)(VP9)(WebDL)( EN 5.1+SPA 2.0)(Complete) PHDTeam", false)]
    [InlineData("Interstellar 2014 1080p NF WEB-DL DDP5 1 AV1-ViSTA", false)]
    [InlineData("Movie.2020.1080p.WEB.x264.AAC.mp4", true)]
    [InlineData("Movie.2020.1080p.WEB.x264.AAC", null)]
    [InlineData("Movie.2020.1080p.WEB.x264.Opus.mp4", true)]
    [InlineData("Movie.2020.1080p.WEB.x264.MP3.mp4", false)]
    [InlineData("Movie.2020.1080p.WEB.x264.MP3", false)]
    [InlineData("Movie.2020.1080p.WEB.FLAC", null)]
    [InlineData("Movie.2020.1080p.WEB.VP9.Opus.webm", false)]
    [InlineData("Movie.2020.1080p.WEB.AV1.AAC.mp4", false)]
    [InlineData("Movie.2020.1080p.WEB.x264.mkv", false)]
    [InlineData("Movie.2020.1080p.WEB.x265.AAC", false)]
    [InlineData("Movie.2020.1080p.WEB.H.264.DDP5.1", null)]
    [InlineData("Movie.2020.1080p.WEB.mp4", null)]
    [InlineData("Movie.2020.1080p.WEB.x264.mp4", null)]
    [InlineData("Movie.2020.720p.avi", false)]
    [InlineData("Movie 2020 1080p WEB", null)]
    [InlineData("Movie.2020.XviD.AAC", false)]
    [InlineData("Movie.2020.VC-1.AAC.mp4", false)]
    [InlineData("Movie.2020.1080p.BluRay.x264.DTS", false)]
    [InlineData("Movie.2020.1080p.m4v.h264.aac", true)]
    [InlineData("Movie.2020.1080p.mov.vp8.vorbis", false)]
    [InlineData("[SubsPlease] One Piece - 1166 (1080p) [E8A3E5BE].mkv", false)]
    [InlineData("Show.S01E01.1080p.WEB.h264-GRP", null)]
    [InlineData("Show.S01E01.1080p.WEB.H264.AAC2.0-GRP", null)]
    [InlineData("Movie.2020.1080p.WEB.DD.x264", false)]
    [InlineData("Movie.2020.2160p.WEB.HEVC.Atmos.TrueHD.mp4", false)]
    public void Direct_play_hint_matches_typescript(string title, bool? expected) =>
        Assert.Equal(expected, ReleaseQuality.DirectPlayableFromTitle(title));

    [Fact]
    public void Av1_release_ranks_below_an_equally_good_unlabelled_release()
    {
        TorrentResult Row(string id, string title) => new() { Id = id, Title = title, Source = "apibay", SourceUrl = "", Seeders = 20 };
        var ranked = ReleaseRanking.Rank([Row("av1", "Breaking Bad S01 1080p BluRay AV1 Opus"), Row("plain", "Breaking Bad S01 1080p BluRay")],
            "breaking bad s01");
        Assert.Equal(["plain", "av1"], ranked.Select(r => r.Id));
    }
}
