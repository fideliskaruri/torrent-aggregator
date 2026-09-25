using System.Text.Json;
using Microsoft.AspNetCore.Http;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;

namespace TorrentFlow.Media.Tests;

public class DecideTests
{
    internal static readonly ClientCapabilities EdgeCaps = new(
    [
        new("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028,ac-3\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028,ec-3\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028\"", "probably", true),
        new("video/mp4; codecs=\"hvc1.1.6.L93.B0\"", "probably", true),
        new("video/mp4; codecs=\"hev1.1.6.L93.B0\"", "probably", true),
        new("video/mp4; codecs=\"hvc1.2.4.L120.B0\"", "probably", true),
        new("video/mp4; codecs=\"hvc1.1.6.L93.B0,ac-3\"", "probably", true),
        new("video/mp4; codecs=\"av01.0.05M.08\"", "probably", true),
        new("video/mp4; codecs=\"vp09.00.10.08\"", "probably", true),
        new("video/webm; codecs=\"vp9,opus\"", "probably", true),
        new("audio/mp4; codecs=\"mp4a.40.2\"", "probably", true),
        new("audio/mp4; codecs=\"flac\"", "probably", true),
        new("audio/mp4; codecs=\"ac-3\"", "probably", true),
        new("audio/mp4; codecs=\"ec-3\"", "probably", true),
        new("video/x-matroska; codecs=\"avc1.640028,mp4a.40.2\"", "", false),
    ], true, "Mozilla/5.0 Edge/150");

    internal static readonly ClientCapabilities MinimalCaps = new(
    [
        new("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028\"", "probably", true),
        new("audio/mp4; codecs=\"mp4a.40.2\"", "probably", true),
    ], true);

    private static ProbeResult Make(string container, string? video, params (string Codec, int Channels, string? Lang, string? Title)[] audio) =>
        Make(container, video, null, null, audio);

    private static ProbeResult Make(string container, string? video, string? profile, string? transfer, params (string Codec, int Channels, string? Lang, string? Title)[] audio)
    {
        var streams = new List<ProbeStream>();
        var idx = 0;
        if (video is not null) streams.Add(Fixtures.Video(video, idx++, profile, transfer));
        foreach (var a in audio) streams.Add(Fixtures.Audio(a.Codec, a.Channels, idx++, a.Lang, a.Title));
        return new ProbeResult(container, 5400, streams);
    }

    public static TheoryData<string, string, string?, string, int, bool, string, string?> Cases => new()
    {
        { "H.264 + AAC in MP4", "mp4", "h264", "aac", 2, true, "direct", null },
        { "H.264 + AAC 5.1 in MP4", "mp4", "h264", "aac", 6, true, "direct", null },
        { "H.264 + AC-3 5.1 in MP4 (Edge supports AC-3)", "mp4", "h264", "ac3", 6, true, "direct", null },
        { "HEVC Main + E-AC-3 5.1 in MP4", "mp4", "hevc", "eac3", 6, true, "direct", null },
        { "AV1 + Opus in WebM", "webm", "av1", "opus", 2, true, "direct", null },
        { "H.264 + MP3 in MKV when fMP4 MP3 not advertised", "matroska", "h264", "mp3", 2, false, "transcode-audio", "aac" },
        { "MPEG-4 + MP3 in AVI (AAC audio)", "avi", "mpeg4", "mp3", 2, false, "transcode-full", "aac" },
        { "H.264 + AAC in MKV (container is the problem)", "matroska,webm", "h264", "aac", 2, true, "remux", null },
        { "VP9 + Opus in MKV", "matroska,webm", "vp9", "opus", 2, true, "remux", null },
        { "HEVC + AAC in MKV", "matroska,webm", "hevc", "aac", 2, true, "remux", null },
        { "H.264 + FLAC in MKV (FLAC is browser-supported)", "matroska,webm", "h264", "flac", 2, true, "remux", null },
        { "HEVC + DTS-HD 5.1 in MKV", "matroska,webm", "hevc", "dts", 6, true, "transcode-audio", "eac3" },
        { "H.264 + TrueHD 7.1 (preserve 8 channels)", "matroska,webm", "h264", "truehd", 8, true, "transcode-audio", "eac3" },
        { "H.264 + DTS stereo in MKV", "matroska,webm", "h264", "dts", 2, true, "transcode-audio", "aac" },
        { "H.264 + TrueHD 7.1 with minimal caps falls back to AAC", "mp4", "h264", "truehd", 8, false, "transcode-audio", "aac" },
        { "H.264 + PCM Bluray audio", "matroska,webm", "h264", "pcm", 6, true, "transcode-audio", "eac3" },
        { "HEVC + DTS 5.1 in MP4", "mp4", "hevc", "dts", 6, true, "transcode-audio", "eac3" },
        { "VC-1 + PCM from Bluray", "matroska,webm", "vc1", "pcm", 6, true, "transcode-full", null },
        { "MPEG-2 + MP2", "mpegts", "mpeg2", "mp2", 2, true, "transcode-full", null },
        { "WMV3 + WMA in AVI", "avi", "wmv3", "wmapro", 6, true, "transcode-full", null },
        { "HEVC + AAC in MKV with minimal caps", "matroska,webm", "hevc", "aac", 2, false, "transcode-full", null },
        { "VP9 + Opus in WebM with minimal caps", "webm", "vp9", "opus", 2, false, "transcode-full", null },
        { "H.264 + MP2 audio in MPEG-TS", "mpegts", "h264", "mp2", 2, true, "transcode-audio", null },
        { "AV1 + EAC3 5.1 in MKV", "matroska,webm", "av1", "eac3", 6, true, "remux", null },
        { "H.264 + AC-3 5.1 in MKV", "matroska,webm", "h264", "ac3", 6, true, "remux", null },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void ChoosesTheCheapestWorkingRungAndNeverDownmixes(string name, string container, string? video, string audio, int channels, bool edge, string rung, string? audioTarget)
    {
        var plan = Decide.DecidePlayback(Make(container, video, (audio, channels, null, null)), edge ? EdgeCaps : MinimalCaps);
        Assert.True(rung == plan.Rung, $"{name}: expected {rung} but got {plan.Rung} ({plan.Reason})");
        Assert.Single(plan.Audio);
        Assert.Equal(channels, plan.Audio[0].Channels);
        if (audioTarget is not null)
        {
            Assert.Equal("transcode", plan.Audio[0].Action);
            Assert.Equal(audioTarget, plan.Audio[0].TargetCodec);
        }
    }

    [Theory]
    [InlineData("hevc", "Main 10", "smpte2084")]
    [InlineData("hevc", null, "arib-std-b67")]
    public void HdrHevcInMkvRemuxes(string codec, string? profile, string transfer)
    {
        var plan = Decide.DecidePlayback(Make("matroska,webm", codec, profile, transfer, ("eac3", 6, null, null)), EdgeCaps);
        Assert.Equal("remux", plan.Rung);
        Assert.Equal(6, plan.Audio[0].Channels);
    }

    [Theory]
    [InlineData("matroska,webm", "remux")]
    [InlineData("mp4", "direct")]
    public void NoAudioStreamYieldsNoAudioPlans(string container, string rung)
    {
        var plan = Decide.DecidePlayback(Make(container, "h264"), EdgeCaps);
        Assert.Equal(rung, plan.Rung);
        Assert.Empty(plan.Audio);
    }

    [Fact]
    public void MultipleAudioTracksPreserveEveryChannelCount()
    {
        var plan = Decide.DecidePlayback(Make("matroska,webm", "hevc", ("dts", 6, "eng", null), ("aac", 2, "jpn", null), ("truehd", 8, "eng", null)), EdgeCaps);
        Assert.Equal("transcode-audio", plan.Rung);
        Assert.Equal([6, 2, 8], plan.Audio.Select(a => a.Channels));
    }

    [Fact]
    public void SubtitleOnlyProbeIsDirectWithNoAudio()
    {
        var plan = Decide.DecidePlayback(new ProbeResult("unknown", 5400, [Fixtures.Sub("subrip", 0)]), EdgeCaps);
        Assert.Equal("direct", plan.Rung);
        Assert.Empty(plan.Audio);
    }

    [Fact]
    public void ExplicitUserPreferenceOutranksEnglish()
    {
        var probe = Make("matroska,webm", "h264", ("aac", 6, "eng", "English"), ("aac", 6, "fr-FR", "French"));
        Assert.Equal(2, Decide.SelectPreferredAudio(probe.Streams, null, "fra")?.Index);
    }

    [Fact]
    public void ManualStreamIndexOutranksLanguagePreference()
    {
        var probe = Make("matroska,webm", "h264", ("aac", 6, "eng", "English"), ("aac", 6, "jpn", "Japanese"));
        Assert.Equal(2, Decide.SelectPreferredAudio(probe.Streams, 2, null)?.Index);
    }

    [Fact]
    public void CommentaryIsSkippedByAutoSelect()
    {
        var probe = Make("matroska,webm", "h264", ("aac", 6, "eng", "English commentary"), ("aac", 2, "eng", "English feature"));
        Assert.Equal(2, Decide.SelectPreferredAudio(probe.Streams)?.Index);
    }

    [Fact]
    public void UnknownLanguageDoesNotBlockFallback()
    {
        var probe = Make("matroska,webm", "h264", ("aac", 2, "und", "Track 1"), ("aac", 6, null, "Track 2"));
        var audio = probe.Streams.Where(s => s.CodecType == "audio").ToList();
        Assert.Equal(1, Decide.SelectPreferredAudio(audio)?.Index);
    }

    [Fact]
    public void EnglishAudioKeepsSubtitlesOff()
    {
        var probe = new ProbeResult("matroska,webm", 5400,
        [
            Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn", "Japanese"), Fixtures.Audio("aac", 2, 2, "eng", "English"),
            Fixtures.Sub("subrip", 3, "fre", "French"), Fixtures.Sub("subrip", 4, "eng", "English"),
        ]);
        var plan = Decide.DecidePlayback(probe, EdgeCaps);
        Assert.True(plan.Subtitle.AudioIsEnglish);
        Assert.Null(plan.Subtitle.DefaultTrackId);
        Assert.True(plan.Subtitle.EnglishSubtitleAvailable);
    }

    [Fact]
    public void ForeignAudioPicksEnglishSubtitles()
    {
        var probe = new ProbeResult("matroska,webm", 5400,
            [Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn", "Japanese"), Fixtures.Sub("subrip", 2, "eng", "English"), Fixtures.Sub("subrip", 3, "fre", "French")]);
        var plan = Decide.DecidePlayback(probe, EdgeCaps);
        Assert.False(plan.Subtitle.AudioIsEnglish);
        Assert.Equal("embedded:2", plan.Subtitle.DefaultTrackId);
        Assert.False(plan.Subtitle.ForcedFallback);
    }

    [Fact]
    public void ForcedEnglishIsOnlyAFallback()
    {
        var onlyForced = new ProbeResult("matroska,webm", 5400,
            [Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn"), Fixtures.Sub("subrip", 2, "eng", "English (forced)")]);
        var plan = Decide.DecidePlayback(onlyForced, EdgeCaps);
        Assert.Equal("embedded:2", plan.Subtitle.DefaultTrackId);
        Assert.True(plan.Subtitle.ForcedFallback);

        var both = new ProbeResult("matroska,webm", 5400,
            [Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn"), Fixtures.Sub("subrip", 2, "eng", "English (forced)"), Fixtures.Sub("subrip", 3, "eng", "English")]);
        plan = Decide.DecidePlayback(both, EdgeCaps);
        Assert.Equal("embedded:3", plan.Subtitle.DefaultTrackId);
        Assert.False(plan.Subtitle.ForcedFallback);
    }

    [Fact]
    public void NonEnglishFallbackIsReportedHonestly()
    {
        var probe = new ProbeResult("matroska,webm", 5400,
            [Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn", "Japanese"), Fixtures.Sub("ass", 2, "fre", "French")]);
        var plan = Decide.DecidePlayback(probe, EdgeCaps);
        Assert.Equal("embedded:2", plan.Subtitle.DefaultTrackId);
        Assert.True(plan.Subtitle.NoEnglishAvailable);
        Assert.False(plan.Subtitle.EnglishSubtitleAvailable);
    }

    [Fact]
    public void SidecarCandidatesAreConsidered()
    {
        var probe = new ProbeResult("matroska,webm", 5400,
            [Fixtures.Video("h264", 0), Fixtures.Audio("aac", 2, 1, "jpn"), Fixtures.Sub("ass", 2, "fre", "French")]);
        var plan = Decide.DecidePlayback(probe, EdgeCaps, subtitleCandidates: [new SubtitleCandidate("sidecar:Movie.eng.srt", "eng", false, true)]);
        Assert.Equal("sidecar:Movie.eng.srt", plan.Subtitle.DefaultTrackId);
        Assert.False(plan.Subtitle.NoEnglishAvailable);
    }

    [Fact]
    public void BitmapEnglishSubtitlesDoNotCountAsAvailable()
    {
        var decision = Decide.SelectDefaultSubtitle("jpn",
        [
            new SubtitleCandidate("embedded:2", "eng", false, false),
            new SubtitleCandidate("embedded:3", "fre", false, true),
        ]);
        Assert.False(decision.EnglishSubtitleAvailable);
        var fromProbe = Decide.SubtitleCandidatesFromProbe([Fixtures.Sub("hdmv_pgs_subtitle", 2, "eng", "English")]);
        Assert.False(Decide.SelectDefaultSubtitle("jpn", fromProbe).EnglishSubtitleAvailable);
    }
}

public class CapabilitiesTests
{
    private static readonly ClientCapabilities Edge = new(
    [
        new("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028,ac-3\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028,ec-3\"", "probably", true),
        new("video/mp4; codecs=\"avc1.640028\"", "probably", true),
        new("video/mp4; codecs=\"hvc1.1.6.L93.B0\"", "probably", true),
        new("video/mp4; codecs=\"hvc1.2.4.L120.B0\"", "probably", true),
        new("video/mp4; codecs=\"av01.0.05M.08\"", "probably", true),
        new("video/mp4; codecs=\"vp09.00.10.08\"", "probably", true),
        new("audio/mp4; codecs=\"mp4a.40.2\"", "probably", true),
        new("audio/mp4; codecs=\"flac\"", "probably", true),
        new("audio/mp4; codecs=\"ac-3\"", "probably", true),
        new("audio/mp4; codecs=\"ec-3\"", "probably", true),
        new("audio/mp4; codecs=\"dtsc\"", "", false),
        new("audio/mp4; codecs=\"mlpa\"", "", false),
        new("video/x-matroska; codecs=\"avc1.640028,mp4a.40.2\"", "", false),
    ], true);

    [Theory]
    [InlineData("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", "mp4", "avc1.640028,mp4a.40.2")]
    [InlineData("video/x-matroska; codecs=\"avc1\"", "matroska", "avc1")]
    [InlineData("video/mp4", "mp4", "")]
    [InlineData("VIDEO/MP4; CODECS=\"AVC1.640028\"", "mp4", "avc1.640028")]
    [InlineData("audio/mp4; codecs=\"ec-3\"", "mp4", "ec-3")]
    [InlineData("video/webm; codecs='vp9, opus'", "webm", "vp9,opus")]
    public void ParseMime(string mime, string family, string tags)
    {
        var (f, t) = Capabilities.ParseMime(mime);
        Assert.Equal(family, f);
        Assert.Equal(tags, string.Join(',', t));
    }

    [Theory]
    [InlineData("avc1.640028", "mp4", true)]
    [InlineData("ac-3", "mp4", true)]
    [InlineData("ec-3", "mp4", true)]
    [InlineData("hvc1.2.4.L120.B0", "mp4", true)]
    [InlineData("dtsc", "mp4", false)]
    [InlineData("mlpa", "mp4", false)]
    [InlineData("vc-1", "mp4", false)]
    [InlineData("avc1.640028", "matroska", false)]
    public void SupportsCodecTag(string tag, string family, bool expected) => Assert.Equal(expected, Capabilities.SupportsCodecTag(Edge, tag, family));

    [Theory]
    [InlineData("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", true)]
    [InlineData("video/mp4; codecs=\"hvc1.2.4.L120.B0,ec-3\"", true)]
    [InlineData("video/mp4; codecs=\"hvc1.1.6.L93.B0,ac-3\"", true)]
    [InlineData("video/mp4; codecs=\"avc1.640028,dtsc\"", false)]
    [InlineData("video/x-matroska; codecs=\"avc1.640028,mp4a.40.2\"", false)]
    [InlineData("video/mp4", false)]
    [InlineData("video/mp4; codecs=\"vc-1,ac-3\"", false)]
    public void CanDecodeViaMse(string mime, bool expected) => Assert.Equal(expected, Capabilities.CanDecodeViaMse(Edge, mime));

    [Fact]
    public void IgnoresEntriesTheBrowserCouldNotPlay()
    {
        var caps = new ClientCapabilities([new("video/mp4; codecs=\"avc1.640028\"", "", true)], true);
        Assert.False(Capabilities.CanDecodeViaMse(caps, "video/mp4; codecs=\"avc1.640028\""));
    }

    [Theory]
    [InlineData("mp4", true)]
    [InlineData("mov", true)]
    [InlineData("matroska", false)]
    [InlineData("mkv", false)]
    [InlineData("mpegts", false)]
    [InlineData("avi", false)]
    [InlineData("webm", false)]
    public void SupportsContainer(string container, bool expected) => Assert.Equal(expected, Capabilities.SupportsContainer(Edge, container));

    [Theory]
    [InlineData("h264", "High", "avc1.640028")]
    [InlineData("h264", null, "avc1.640028")]
    [InlineData("hevc", "Main", "hvc1.1.6.L93.B0")]
    [InlineData("hevc", "Main 10", "hvc1.2.4.L120.B0")]
    [InlineData("hevc", "Rext", "hvc1.2.4.L120.B0")]
    [InlineData("h265", "Main 10 Intra", "hvc1.2.4.L120.B0")]
    [InlineData("av1", "Main", "av01.0.05M.08")]
    [InlineData("vp9", null, "vp09.00.10.08")]
    [InlineData("mpeg2video", "Main", "mpeg2video")]
    public void VideoCodecTag(string codec, string? profile, string expected) => Assert.Equal(expected, Capabilities.VideoCodecTag(codec, profile));

    [Theory]
    [InlineData("aac", "mp4a.40.2")]
    [InlineData("ac3", "ac-3")]
    [InlineData("eac3", "ec-3")]
    [InlineData("e-ac-3", "ec-3")]
    [InlineData("flac", "flac")]
    [InlineData("opus", "opus")]
    [InlineData("dts", "dts")]
    public void AudioCodecTag(string codec, string expected) => Assert.Equal(expected, Capabilities.AudioCodecTag(codec));

    [Fact]
    public void Fmp4Mime()
    {
        Assert.Equal("video/mp4; codecs=\"hvc1.2.4.L120.B0,ec-3\"", Capabilities.Fmp4Mime("hevc", "eac3", "Main 10"));
        Assert.Equal("video/mp4; codecs=\"avc1.640028,mp4a.40.2\"", Capabilities.Fmp4Mime("h264", "aac", "High"));
        Assert.Equal("video/mp4; codecs=\"avc1.640028\"", Capabilities.Fmp4Mime("h264", null, null));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"codecs\":\"nope\"}")]
    [InlineData("{\"codecs\":[{\"mime\":1}]}")]
    public void ParseFallsBackToDefaults(string json)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Same(Capabilities.Default, Capabilities.Parse(doc.RootElement));
    }

    [Fact]
    public void ParseKeepsOnlyWellFormedEntries()
    {
        using var doc = JsonDocument.Parse("""{"codecs":[{"mime":"video/mp4","canPlay":"maybe","mse":true},{"mime":"x"},{"mime":"audio/mp4","canPlay":1,"mse":true}],"ua":"UA"}""");
        var caps = Capabilities.Parse(doc.RootElement);
        Assert.Single(caps.Codecs);
        Assert.Equal("UA", caps.Ua);
        Assert.True(caps.MseSupported);
    }

    [Fact]
    public void DefaultCapabilitiesAreConservativeButUsable()
    {
        Assert.True(Capabilities.CanDecodeViaMse(Capabilities.Default, "video/mp4; codecs=\"avc1.640028,mp4a.40.2\""));
        Assert.False(Capabilities.SupportsCodecTag(Capabilities.Default, "hvc1.1.6.L93.B0"));
    }
}

public class ProbeShapeTests
{
    private const string H264Mp4 = """
    {"streams":[{"index":0,"codec_type":"video","codec_name":"h264","profile":"High","pix_fmt":"yuv420p","width":1920,"height":1080,"color_transfer":"bt709","bit_rate":"38000000","disposition":{"default":1}},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":6,"channel_layout":"5.1","sample_rate":"48000","tags":{"language":"eng","title":"English"}}],
     "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"7200.123","bit_rate":"42000000"}}
    """;

    [Fact]
    public void ParsesH264AacMp4()
    {
        var o = ProbeShape.Parse(H264Mp4);
        Assert.True(o.Ok);
        var r = o.Result!;
        Assert.Equal("mp4", ProbeShape.NormalizeContainer("mov,mp4,m4a,3gp,3g2,mj2"));
        Assert.Equal(7200.123, r.Duration);
        Assert.Equal(2, r.Streams.Count);
        Assert.Equal("h264", r.Video!.Codec);
        Assert.Equal("High", r.Video.Profile);
        var audio = r.Audio.Single();
        Assert.Equal(6, audio.Channels);
        Assert.Equal("eng", audio.Language);
        Assert.Equal("English", audio.Title);
        Assert.Equal(42_000_000, r.BitRate);
    }

    [Fact]
    public void ParsesHevcHdrMkvWithSubtitles()
    {
        var json = """
        {"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","profile":"Main 10","color_transfer":"smpte2084"},
                    {"index":1,"codec_type":"audio","codec_name":"dts","channels":6,"tags":{"language":"eng"}},
                    {"index":2,"codec_type":"audio","codec_name":"ac3","channels":2,"tags":{"language":"jpn"}},
                    {"index":3,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"eng"}}],
         "format":{"format_name":"matroska,webm","duration":"5400.000"}}
        """;
        var r = ProbeShape.Parse(json).Result!;
        Assert.Equal(5400, r.Duration);
        Assert.Equal(2, r.Audio.Count());
        Assert.True(ProbeShape.IsHdr(r.Video!));
        Assert.Contains(r.Streams, s => s.CodecType == "subtitle" && s.Codec == "subrip");
    }

    [Theory]
    [InlineData("""{"streams":[],"format":{}}""", "no_streams")]
    [InlineData("""{"format":{}}""", "no_streams")]
    [InlineData("not json", "probe_failed")]
    public void BadOutputReportsErrors(string stdout, string error)
    {
        var o = ProbeShape.Parse(stdout);
        Assert.False(o.Ok);
        Assert.Equal(error, o.Error!.Error);
    }

    [Fact]
    public void MinimalStreamParses()
    {
        var r = ProbeShape.Parse("""{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"}]}""").Result!;
        Assert.Null(r.Duration);
        Assert.Null(r.Video!.Width);
        Assert.Null(r.Video.Channels);
    }

    [Theory]
    [InlineData("h264", "h264")]
    [InlineData("hevc", "hevc")]
    [InlineData("h265", "hevc")]
    [InlineData("eac3", "eac3")]
    [InlineData("ac3", "ac3")]
    [InlineData("aac", "aac")]
    public void NormalizesCodecNames(string raw, string expected) => Assert.Equal(expected, ProbeShape.NormalizeCodecName(raw));

    [Theory]
    [InlineData("mov,mp4,m4a,3gp,3g2,mj2", "mp4")]
    [InlineData("matroska,webm", "matroska")]
    [InlineData("mpegts", "mpegts")]
    [InlineData("avi", "avi")]
    public void NormalizesContainers(string raw, string expected) => Assert.Equal(expected, ProbeShape.NormalizeContainer(raw));

    [Theory]
    [InlineData("smpte2084", true)]
    [InlineData("arib-std-b67", true)]
    [InlineData("bt709", false)]
    [InlineData(null, false)]
    public void DetectsHdr(string? transfer, bool hdr) => Assert.Equal(hdr, ProbeShape.IsHdr(Fixtures.Video("hevc", transfer: transfer)));

    [Fact]
    public void StreamUrlEncodesPathSegments()
    {
        var url = ProbeShape.StreamUrl("abc", "Show S01/Episode #1.mkv", "http://127.0.0.1:3000");
        Assert.Equal("http://127.0.0.1:3000/api/stream/abc/Show%20S01/Episode%20%231.mkv", url);
        Assert.StartsWith("http://example.test:8080/", ProbeShape.StreamUrl("abc", "a.mkv", "http://example.test:8080"));
    }

    [Fact]
    public void LocalProbesOmitReadTimeoutAndNetworkProbesKeepIt()
    {
        Assert.DoesNotContain("-rw_timeout", ProbeShape.BuildProbeArgs(@"C:\x.mkv", false));
        var net = ProbeShape.BuildProbeArgs("http://127.0.0.1/x", true, 30_000);
        Assert.Equal("30000000", net[net.ToList().IndexOf("-rw_timeout") + 1]);
    }

    private static HttpRequest Request(Action<HttpRequest> configure)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Scheme = "http";
        configure(ctx.Request);
        return ctx.Request;
    }

    [Fact]
    public void RequestOriginPrefersForwardedHeaders()
    {
        Assert.Equal("https://tf.example", ProbeShape.RequestOrigin(Request(r => { r.Host = new HostString("inner:3000"); r.Headers["x-forwarded-host"] = "tf.example"; r.Headers["x-forwarded-proto"] = "https"; })));
        Assert.Equal("http://inner:3000", ProbeShape.RequestOrigin(Request(r => r.Host = new HostString("inner:3000"))));
        Assert.Equal("https://a.example", ProbeShape.RequestOrigin(Request(r => { r.Headers["x-forwarded-host"] = "a.example, b.example"; r.Headers["x-forwarded-proto"] = "https"; })));
    }

    [Theory]
    [InlineData("\"42000000\"", 42_000_000L)]
    [InlineData("42000000", 42_000_000L)]
    [InlineData("\"N/A\"", null)]
    [InlineData("\"\"", null)]
    [InlineData("\"abc\"", null)]
    [InlineData("0", null)]
    [InlineData("-1", null)]
    [InlineData("null", null)]
    public void ParseBitrate(string json, long? expected)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(expected, ProbeShape.ParseBitrate(doc.RootElement));
    }

    [Fact]
    public void BitrateBpsPrefersTheVideoStream()
    {
        var r = ProbeShape.Parse(H264Mp4).Result!;
        Assert.Equal(38_000_000, ProbeShape.BitrateBps(r));
        Assert.Equal(42_000_000, ProbeShape.BitrateBps(r with { Streams = [r.Video! with { BitRate = null }] }));
        Assert.Null(ProbeShape.BitrateBps(r with { Streams = [r.Video! with { BitRate = null }], BitRate = null }));
    }

    [Fact]
    public void CacheRowsRoundTripAndRejectOldVersions()
    {
        var r = ProbeShape.Parse(H264Mp4).Result!;
        var row = new TorrentFlow.Data.Entities.MediaProbe
        {
            Id = "x", InfoHash = "hash", FilePath = "a.mkv", Container = r.Container, DurationSec = r.Duration, ProbeVersion = 1,
            BitRateBps = 42_000_000, StreamsJson = ProbeShape.SerializeStreams(r.Streams),
        };
        var back = MediaProber.FromCacheRow(row)!;
        Assert.Equal(r.Streams.Count, back.Streams.Count);
        Assert.Equal(38_000_000, ProbeShape.BitrateBps(back));
        Assert.Null(MediaProber.FromCacheRow(null));
        Assert.Null(MediaProber.FromCacheRow(row.Clone(p => p.ProbeVersion = 0)));
        Assert.Null(MediaProber.FromCacheRow(row.Clone(p => p.StreamsJson = null)));
    }
}

internal static class EntityCloneExtensions
{
    public static TorrentFlow.Data.Entities.MediaProbe Clone(this TorrentFlow.Data.Entities.MediaProbe p, Action<TorrentFlow.Data.Entities.MediaProbe> change)
    {
        var copy = new TorrentFlow.Data.Entities.MediaProbe
        {
            Id = p.Id, InfoHash = p.InfoHash, FilePath = p.FilePath, Container = p.Container, DurationSec = p.DurationSec,
            ProbeVersion = p.ProbeVersion, BitRateBps = p.BitRateBps, StreamsJson = p.StreamsJson,
        };
        change(copy);
        return copy;
    }
}
