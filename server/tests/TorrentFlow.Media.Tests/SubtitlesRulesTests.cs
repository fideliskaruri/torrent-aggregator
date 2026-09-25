using System.Text;
using TorrentFlow.Media.Features.Subtitles;

namespace TorrentFlow.Media.Tests;

public class SubtitlesRulesTests
{
    [Theory]
    [InlineData("subrip", "text")]
    [InlineData("srt", "text")]
    [InlineData("ass", "text")]
    [InlineData("ssa", "text")]
    [InlineData("mov_text", "text")]
    [InlineData("webvtt", "text")]
    [InlineData("SubRip", "text")]
    [InlineData("hdmv_pgs_subtitle", "image")]
    [InlineData("dvd_subtitle", "image")]
    [InlineData("dvb_subtitle", "image")]
    [InlineData("xsub", "image")]
    [InlineData("vobsub", "image")]
    [InlineData("some_future_codec", "unknown")]
    public void ClassifiesCodec(string codec, string expected) => Assert.Equal(expected, SubtitleRules.ClassifyCodec(codec));

    internal static readonly SubtitleStream[] Streams =
    [
        new(0, "video", "h264"),
        new(1, "audio", "ac3", "eng", Channels: 6),
        new(2, "subtitle", "subrip", "eng", "English"),
        new(3, "subtitle", "hdmv_pgs_subtitle", "eng", "English PGS"),
        new(4, "subtitle", "ass", "jpn"),
        new(5, "subtitle", "dvd_subtitle", "fre")
    ];

    [Fact]
    public void EmbeddedTracksAreHonestAboutBitmapSupport()
    {
        var tracks = SubtitleRules.BuildTracks(Streams, null, "Film.mkv");
        Assert.Equal(4, tracks.Count);
        Assert.Equal("embedded:2", tracks[0].Id);
        Assert.Equal(2, tracks[0].StreamIndex);
        Assert.True(tracks[0].Supported);
        Assert.True(tracks.Single(t => t.StreamIndex == 4).Supported);
        Assert.Contains("Japanese", tracks.Single(t => t.StreamIndex == 4).Label);
        Assert.All(tracks.Where(t => t.StreamIndex is 3 or 5), t =>
        {
            Assert.False(t.Supported);
            Assert.Contains("unsupported", t.Label);
            Assert.True(t.UnsupportedReason?.Length > 10);
        });
        Assert.All(tracks, t => Assert.True(t.NeedsExtraction));
        Assert.Empty(SubtitleRules.BuildTracks([], null, "Film.mkv"));
    }

    [Fact]
    public void SceneSidecarsPrecedeEmbeddedAndRetainLanguageAndFlags()
    {
        const string folder = "Film.2024.1080p.WEB-DL/";
        const string stem = "Film.2024.1080p.WEB-DL";
        string[] files = [folder + stem + ".mkv", folder + stem + ".srt", folder + stem + ".eng.forced.srt",
            folder + "Subs/2_English.srt", folder + "Subs/3_French.SDH.srt", folder + stem + ".nfo", folder + "Sample/sample.mkv"];
        var tracks = SubtitleRules.BuildTracks(Streams, files, folder + stem + ".mkv");
        Assert.Equal(8, tracks.Count);
        Assert.All(tracks.Take(4), t => { Assert.Equal("sidecar", t.Kind); Assert.False(t.NeedsExtraction); });
        Assert.Equal("embedded", tracks[^1].Kind);
        Assert.Equal(tracks.Count, tracks.Select(t => t.Id).Distinct().Count());
        Assert.All(tracks, t => Assert.False(string.IsNullOrWhiteSpace(t.Label)));
        var forced = tracks.Single(t => t.FilePath?.EndsWith("eng.forced.srt", StringComparison.Ordinal) == true);
        Assert.Equal("eng", forced.Language);
        Assert.True(forced.Forced);
        Assert.Equal("English (forced) · SubRip file", forced.Label);
        Assert.Equal("eng", tracks.Single(t => t.FilePath?.EndsWith("2_English.srt", StringComparison.Ordinal) == true).Language);
        Assert.True(tracks.Single(t => t.FilePath?.EndsWith("3_French.SDH.srt", StringComparison.Ordinal) == true).HearingImpaired);
    }

    [Fact]
    public void SidecarPrefixRequiresSeparatorAndOwnership()
    {
        string[] files = ["Show/Show.S01E01.mkv", "Show/Show.S01E01.srt", "Show/Show.S01E011.srt", "Show/Show.S01E02.srt"];
        Assert.Equal("Show/Show.S01E01.srt", Assert.Single(SubtitleRules.BuildTracks(null, files, files[0])).FilePath);
        Assert.Empty(SubtitleRules.BuildTracks(null, ["A/film.mkv", "B/film.srt"], "A/film.mkv"));
        Assert.Single(SubtitleRules.BuildTracks(null, ["A/film.mkv", "B/film.srt"], "A/film.mkv", true));
    }

    [Theory]
    [InlineData("eng", "English")]
    [InlineData("ja", "Japanese")]
    [InlineData("zz9", "ZZ9")]
    [InlineData(null, null)]
    [InlineData("und", null)]
    [InlineData("unknown", null)]
    public void LanguageLabels(string? code, string? name) => Assert.Equal(name, SubtitleRules.LanguageLabel(code));

    [Fact]
    public void LanguageTokensAndTrackIdsMatchTheTypeScriptContract()
    {
        Assert.Equal("spa", SubtitleRules.LanguageFromToken("Spanish"));
        Assert.Null(SubtitleRules.LanguageFromToken("1080p"));
        Assert.Equal("embedded", SubtitleRules.ParseTrackId("embedded:3")?.Kind);
        Assert.Equal("sidecar", SubtitleRules.ParseTrackId("sidecar:Show/a.srt")?.Kind);
        foreach (var bad in new[] { "magic:1", "", "sidecar:../../etc/passwd", "sidecar:a/./b.srt", "embedded:abc", "embedded:-1", "embedded:1.1" })
            Assert.Null(SubtitleRules.ParseTrackId(bad));
        Assert.Equal(0, SubtitleRules.ParseTrackId("embedded:")?.Index);
        Assert.Equal("Show/a.srt", SubtitleRules.ParseTrackId(@"sidecar:\Show\a.srt")?.Path);
        Assert.Equal("/api/subtitles/abc?filePath=dir%2Ffilm.mkv&track=embedded%3A2",
            SubtitleRules.TrackSrc("abc", "dir/film.mkv", "embedded:2"));
    }

    public static IEnumerable<object[]> SrtFixtures()
    {
        yield return ["1\r\n00:00:01,000 --> 00:00:03,500\r\nHello.\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nBye.\r\n",
            "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello.\n\n2\n00:01:02.250 --> 00:01:04.000\nBye.\n"];
        yield return ["\uFEFF1\r00:00:01,1 --> 00:00:02,25\r<i>Café, 日本語</i>\r",
            "WEBVTT\n\n1\n00:00:01.1 --> 00:00:02.25\n<i>Café, 日本語</i>\n"];
        yield return ["", "WEBVTT\n\n"];
    }

    [Theory]
    [MemberData(nameof(SrtFixtures))]
    public void SrtFixturesMatchExactly(string input, string output) => Assert.Equal(output, SubtitleRules.SrtToVtt(input));

    [Fact]
    public void EncodingUsesUtf8TextDecoderSemanticsRatherThanInventingDetection()
    {
        Assert.Equal("Café 日本語", SubtitleRules.Decode([0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("Café 日本語")]));
        Assert.Equal("caf\uFFFD", SubtitleRules.Decode([0x63, 0x61, 0x66, 0xe9]));
        Assert.True(SubtitleRules.IsWebVtt(" \nWEBVTT\n\n00:00.000 --> 00:01.000\nx"));
        Assert.False(SubtitleRules.IsWebVtt("1\n00:00:00,000 --> 00:00:01,000\nx"));
    }

    [Fact]
    public void CueRebasingDropsExpiredCuesClampsStraddlesAndPreservesSettings()
    {
        const string original = "WEBVTT\n\n1\n00:00:10.000 --> 00:00:12.000\nEarly line.\n\n2\n00:01:29.500 --> 00:01:32.000\nStraddles the cut.\n\n3\n00:02:00.000 --> 00:02:03.000\nLater line.";
        var shifted = SubtitleRules.ShiftVttCues(original, -90);
        Assert.StartsWith("WEBVTT", shifted);
        Assert.DoesNotContain("Early line.", shifted);
        Assert.Contains("00:00:00.000 --> 00:00:02.000\nStraddles the cut.", shifted);
        Assert.Contains("00:00:30.000 --> 00:00:33.000\nLater line.", shifted);
        Assert.Equal(original, SubtitleRules.ShiftVttCues(original, 0));
        Assert.Equal(original, SubtitleRules.ShiftVttCues(original, double.NaN));
        Assert.Contains("00:00:06.000 --> 00:00:07.000", SubtitleRules.ShiftVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx", 5));
        Assert.Contains("00:00:05.000 --> 00:00:07.000 line:90% align:middle",
            SubtitleRules.ShiftVttCues("WEBVTT\n\n00:10.000 --> 00:12.000 line:90% align:middle\nx", -5));
    }

    [Theory]
    [InlineData(479, 0)]
    [InlineData(480, 480)]
    [InlineData(961, 960)]
    [InlineData(-1, 0)]
    [InlineData(double.NaN, 0)]
    public void CanonicalWindows(double input, double expected) => Assert.Equal(expected, SubtitleRules.WindowStart(input));

    [Fact]
    public void AudioAndSubtitleDefaultsPreferEnglishWithoutSelectingCommentary()
    {
        var tracks = SubtitleRules.BuildTracks(null, ["Film.eng.forced.srt", "Film.eng.srt", "Film.fra.srt"], "Film.mkv");
        var english = SubtitleRules.Decide(Streams, tracks);
        Assert.Null(english.DefaultTrackId);
        Assert.True(english.AudioIsEnglish);
        var foreign = SubtitleRules.Decide([new(0, "audio", "aac", "jpn"), new(1, "audio", "aac", "eng", "Director commentary")], tracks);
        Assert.Equal("sidecar:Film.eng.srt", foreign.DefaultTrackId);
        Assert.False(foreign.ForcedFallback);
        Assert.True(SubtitleRules.Decide([new(0, "audio", "aac", "jpn")], tracks.Take(1).ToArray()).ForcedFallback);
        var fallback = SubtitleRules.Decide([], tracks.TakeLast(1).ToArray());
        Assert.Equal("sidecar:Film.fra.srt", fallback.DefaultTrackId);
        Assert.True(fallback.NoEnglishAvailable);
    }

    [Fact]
    public void ExtractionArgumentsBoundSeekAndMapTheRequestedStream()
    {
        var args = SubtitleExtraction.BuildExtractArgs("http://example.test/video", 2, 480);
        Assert.True(Array.IndexOf(args, "-ss") < Array.IndexOf(args, "-i"));
        Assert.Equal("480", args[Array.IndexOf(args, "-ss") + 1]);
        Assert.Contains("-copyts", args);
        Assert.True(Array.IndexOf(args, "-to") > Array.IndexOf(args, "-i"));
        Assert.Equal("1080", args[Array.IndexOf(args, "-to") + 1]);
        var firstWindow = SubtitleExtraction.BuildExtractArgs("http://example.test/video", 2);
        Assert.Equal("600", firstWindow[Array.IndexOf(firstWindow, "-to") + 1]);
        Assert.Equal("0:2", args[Array.IndexOf(args, "-map") + 1]);
        Assert.True(SubtitleExtraction.PrefetchTimeoutMs < SubtitleExtraction.ExtractTimeoutMs);
        Assert.DoesNotContain("-reconnect_at_eof", args);
    }
}
