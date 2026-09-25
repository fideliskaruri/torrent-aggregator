using System.Buffers.Binary;
using System.Text;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Streaming;
using TorrentFlow.Media.Subtitles;
using TorrentFlow.Media.Swarm;
using TorrentFlow.Media.Vod;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Tests;

public class HttpRangeTests
{
    [Fact]
    public void NoHeaderIsTheWholeFile()
    {
        var r = HttpRanges.ParseStreamRange(null, 50)!;
        Assert.Equal((0, 49, 200), (r.Start, r.End, r.Status));
        Assert.Null(r.ContentRange);
    }

    [Theory]
    [InlineData("bytes=abc")]
    [InlineData("bytes=-")]
    [InlineData("bytes=-0")]
    [InlineData("bytes=50-")]
    [InlineData("bytes=60-70")]
    [InlineData("nonsense")]
    [InlineData("bytes=-100")] // npm range-parser drops a suffix longer than the file (start < 0)
    public void UnsatisfiableRanges(string header) => Assert.Null(HttpRanges.ParseStreamRange(header, 50));

    [Theory]
    [InlineData("bytes=-10", 40, 49)]
    [InlineData("items=0-1", 0, 1)] // range-parser ignores the unit
    [InlineData("bytes=10-", 10, 49)]
    [InlineData("bytes=0-999", 0, 49)]
    [InlineData("bytes=5-9", 5, 9)]
    [InlineData("bytes=5-9,20-30", 5, 9)]
    public void SatisfiableRanges(string header, long start, long end)
    {
        var r = HttpRanges.ParseStreamRange(header, 50)!;
        Assert.Equal((start, end, 206), (r.Start, r.End, r.Status));
        Assert.Equal($"bytes {start}-{end}/50", r.ContentRange);
    }

    [Fact]
    public void OpenEndedRangesAreCappedAt128MiB()
    {
        var r = HttpRanges.ParseStreamRange("bytes=0-", 1L << 34)!;
        Assert.Equal(HttpRanges.OpenEndedRangeCapBytes - 1, r.End);
        var explicitEnd = HttpRanges.ParseStreamRange($"bytes=0-{(1L << 33)}", 1L << 34)!;
        Assert.Equal(1L << 33, explicitEnd.End);
    }

    [Theory]
    [InlineData("playlist.m3u8", "application/vnd.apple.mpegurl")]
    [InlineData("seg00001.m4s", "video/iso.segment")]
    [InlineData("init.mp4", "video/mp4")]
    [InlineData("seg1.ts", "video/mp2t")]
    [InlineData("SEG.M4S", "video/iso.segment")]
    [InlineData("", "application/octet-stream")]
    [InlineData("notes.txt", "application/octet-stream")]
    public void ContentTypeForSegment(string name, string type) => Assert.Equal(type, HttpRanges.ContentTypeForSegment(name));

    [Theory]
    [InlineData("a.mkv", "video/x-matroska")]
    [InlineData("a.MP4", "video/mp4")]
    [InlineData("a.m4v", "video/mp4")]
    [InlineData("a.webm", "video/webm")]
    [InlineData("a.avi", "video/x-msvideo")]
    [InlineData("a.srt", "text/vtt; charset=utf-8")]
    [InlineData("a.bin", "application/octet-stream")]
    public void ContentTypeForPath(string path, string type) => Assert.Equal(type, HttpRanges.ContentTypeForPath(path));

    [Theory]
    [InlineData(null, 100, false, null, null)]
    [InlineData("bytes=0-9", 100, false, 0L, 9L)]
    [InlineData("bytes=90-", 100, false, 90L, 99L)]
    [InlineData("bytes=-10", 100, false, 90L, 99L)]
    [InlineData("bytes=0-999", 100, false, 0L, 99L)]
    [InlineData("bytes=100-", 100, true, null, null)]
    [InlineData("bytes=-0", 100, true, null, null)]
    [InlineData("bytes=-", 100, true, null, null)]
    [InlineData("bytes=5-1", 100, true, null, null)]
    [InlineData("bytes=a-b", 100, true, null, null)]
    [InlineData("bytes=0-0", 0, true, null, null)]
    [InlineData("bytes=-5", 0, true, null, null)]
    public void ParseSegmentRange(string? header, long size, bool unsatisfiable, long? start, long? end)
    {
        var r = HttpRanges.ParseSegmentRange(header, size, out var bad);
        Assert.Equal(unsatisfiable, bad);
        Assert.Equal(start, r?.Start);
        Assert.Equal(end, r?.End);
    }

    [Theory]
    [InlineData("playlist.m3u8", true)]
    [InlineData("seg00001.m4s", true)]
    [InlineData("nested/seg.m4s", true)]
    [InlineData("nested\\seg.m4s", true)]
    [InlineData("../escape.m4s", false)]
    [InlineData("nested/../../escape.m4s", false)]
    [InlineData("/etc/passwd", false)]
    [InlineData("C:/Windows/win.ini", false)]
    [InlineData("//server/share", false)]
    [InlineData("", false)]
    [InlineData("a\0b", false)]
    public void ResolveWithinSessionDir(string name, bool allowed)
    {
        var dir = Path.Combine(Path.GetTempPath(), "tf-session-x");
        var resolved = HttpRanges.ResolveWithin(dir, name);
        Assert.Equal(allowed, resolved is not null);
        if (resolved is not null) Assert.StartsWith(Path.GetFullPath(dir), resolved);
    }

    [Fact]
    public async Task CopyExactlyStopsAtCount()
    {
        using var src = new MemoryStream(Fixtures.Bytes(1000));
        using var dst = new MemoryStream();
        var n = await StreamCopy.CopyExactlyAsync(src, dst, 300, null, CancellationToken.None);
        Assert.Equal(300, n);
        Assert.Equal(300, dst.Length);
    }
}

public class StallTests
{
    private const long T0 = 1_000_000;

    private static List<TransferSample> Series(string state = "downloading", params (int Sec, long Bytes)[] points) =>
        [.. points.Select(p => new TransferSample(T0 + p.Sec * 1000L, p.Bytes, p.Bytes / 1_000_000_000.0, state))];

    [Fact]
    public void FrozenDownloadOverAFullWindowIsStalled() =>
        Assert.True(Stall.Evaluate(Series(points: [(0, 5_000_000), (10, 5_000_000), (31, 5_000_000)])).Stalled);

    [Fact]
    public void SlowButProgressingIsNotStalled()
    {
        var v = Stall.Evaluate(Series(points: [(0, 0), (31, 1_000_000)]));
        Assert.False(v.Stalled);
        Assert.Equal("progressing", v.Reason);
    }

    [Fact]
    public void ExactlyTheFloorIsProgressing() =>
        Assert.Equal("progressing", Stall.Evaluate(Series(points: [(0, 1_000_000), (31, 1_000_000 + 262_144)])).Reason);

    [Fact]
    public void JustUnderTheFloorIsStalled() =>
        Assert.True(Stall.Evaluate(Series(points: [(0, 1_000_000), (31, 1_000_000 + 262_143)])).Stalled);

    [Fact]
    public void FrozenInsideTheWindowIsWarmingUp() =>
        Assert.Equal("insufficient-history", Stall.Evaluate(Series(points: [(0, 5_000_000), (10, 5_000_000)])).Reason);

    [Fact]
    public void SingleSampleIsUndetermined() =>
        Assert.Equal("insufficient-history", Stall.Evaluate(Series(points: [(0, 5)])).Reason);

    [Theory]
    [InlineData("metaDL")]
    [InlineData("checkingDL")]
    [InlineData("paused")]
    public void NonDownloadingPhasesAreNeverStalled(string state) =>
        Assert.False(Stall.Evaluate(Series(state, (0, 5_000_000), (40, 5_000_000))).Stalled);

    [Fact]
    public void CompleteDownloadIsNeverStalled()
    {
        var samples = new List<TransferSample> { new(T0, 10, 1, "downloading"), new(T0 + 40_000, 10, 1, "downloading") };
        Assert.Equal("complete", Stall.Evaluate(samples).Reason);
    }

    [Fact]
    public void TransientBackwardsDipDoesNotFakeProgress() =>
        Assert.True(Stall.Evaluate(Series(points: [(0, 5_000_000), (15, 4_000_000), (31, 5_000_000)])).Stalled);
}

public class SubtitleTextTests
{
    private static readonly ProbeStream[] SixStreams =
    [
        Fixtures.Video("h264", 0), Fixtures.Audio("ac3", 6, 1),
        Fixtures.Sub("subrip", 2, "eng", "English"), Fixtures.Sub("hdmv_pgs_subtitle", 3), Fixtures.Sub("ass", 4, "jpn"), Fixtures.Sub("dvd_subtitle", 5, "fre"),
    ];

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
    public void ClassifyCodec(string codec, string kind) => Assert.Equal(kind, SubtitleText.ClassifyCodec(codec));

    [Fact]
    public void EmbeddedTracksCoverOnlySubtitleStreams()
    {
        var tracks = SubtitleText.EmbeddedTracks(SixStreams);
        Assert.Equal(4, tracks.Count);
        var srt = tracks.Single(t => t.StreamIndex == 2);
        Assert.True(srt.Supported);
        Assert.Equal("embedded:2", srt.Id);
        Assert.True(tracks.Single(t => t.StreamIndex == 4).Supported);
        Assert.False(tracks.Single(t => t.StreamIndex == 3).Supported);
        Assert.False(tracks.Single(t => t.StreamIndex == 5).Supported);
        foreach (var t in tracks.Where(t => !t.Supported))
        {
            Assert.Contains("unsupported", t.Label, StringComparison.OrdinalIgnoreCase);
            Assert.True(t.UnsupportedReason!.Length > 10);
        }
        Assert.All(tracks, t => Assert.True(t.NeedsExtraction));
        Assert.Contains("Japanese", tracks.Single(t => t.StreamIndex == 4).Label);
        Assert.Empty(SubtitleText.EmbeddedTracks([]));
    }

    private static readonly string[] SceneFiles =
    [
        "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.mkv",
        "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.srt",
        "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.eng.forced.srt",
        "Film.2024.1080p.WEB-DL/Subs/2_English.srt",
        "Film.2024.1080p.WEB-DL/Subs/3_French.SDH.srt",
        "Film.2024.1080p.WEB-DL/Film.2024.1080p.WEB-DL.nfo",
        "Film.2024.1080p.WEB-DL/Sample/sample.mkv",
    ];

    [Fact]
    public void FindsSceneSidecars()
    {
        var found = SubtitleText.FindSidecars(SceneFiles, SceneFiles[0]);
        Assert.Contains(found, s => s.Path == SceneFiles[1]);
        var forced = found.Single(s => s.Path == SceneFiles[2]);
        Assert.Equal("eng", forced.Language);
        Assert.True(forced.Forced);
        Assert.Equal("eng", found.Single(s => s.Path == SceneFiles[3]).Language);
        Assert.True(found.Single(s => s.Path == SceneFiles[4]).HearingImpaired);
        Assert.DoesNotContain(found, s => s.Path.EndsWith(".nfo", StringComparison.Ordinal) || s.Path.EndsWith(".mkv", StringComparison.Ordinal));
    }

    [Fact]
    public void SidecarNamesNeedASeparatorAfterTheBase()
    {
        var files = new[] { "Show/Show.S01E01.mkv", "Show/Show.S01E01.srt", "Show/Show.S01E011.srt", "Show/Show.S01E02.srt" };
        var found = SubtitleText.FindSidecars(files, files[0]);
        Assert.Equal("Show/Show.S01E01.srt", Assert.Single(found).Path);
    }

    [Fact]
    public void OtherDirectoriesOnlyMatchForASoleVideo()
    {
        var files = new[] { "A/film.mkv", "B/film.srt" };
        Assert.Empty(SubtitleText.FindSidecars(files, files[0]));
        Assert.Single(SubtitleText.FindSidecars(files, files[0], soleVideo: true));
    }

    [Fact]
    public void BuildTracksPutsSidecarsFirst()
    {
        var tracks = SubtitleText.BuildTracks(SixStreams, SceneFiles, SceneFiles[0]);
        Assert.Equal("sidecar", tracks[0].Kind);
        Assert.Equal("embedded", tracks[^1].Kind);
        Assert.Equal(tracks.Count, tracks.Select(t => t.Id).Distinct().Count());
        Assert.All(tracks, t => Assert.False(string.IsNullOrEmpty(t.Label)));
        Assert.All(tracks.Where(t => t.Kind == "sidecar"), t => Assert.False(t.NeedsExtraction));
    }

    [Theory]
    [InlineData("embedded:3", "embedded")]
    [InlineData("sidecar:Show/a.srt", "sidecar")]
    [InlineData("magic:1", null)]
    [InlineData("", null)]
    [InlineData("sidecar:../../etc/passwd", null)]
    [InlineData("embedded:abc", null)]
    public void ParseTrackId(string raw, string? kind) => Assert.Equal(kind, SubtitleText.ParseTrackId(raw)?.Kind);

    [Fact]
    public void TrackUrls()
    {
        var src = SubtitleText.TrackSrc("abc", "dir/film.mkv", "embedded:2");
        Assert.Contains("track=embedded%3A2", src);
        Assert.Contains("filePath=dir%2Ffilm.mkv", src);
        Assert.DoesNotContain("offset", src);
        Assert.EndsWith("?filePath=dir%2Ffilm.mkv", SubtitleText.ListUrl("abc", "dir/film.mkv"));
        Assert.Contains("offset=90", SubtitleText.TrackSrc("abc", "dir/film.mkv", "embedded:2", 90));
        Assert.Contains("start=480", SubtitleText.TrackSrc("abc", "f.mkv", "embedded:2", 90, 480));
    }

    [Theory]
    [InlineData(479, 0)]
    [InlineData(480, 480)]
    [InlineData(961, 960)]
    [InlineData(-5, 0)]
    public void WindowStart(double t, double expected) => Assert.Equal(expected, SubtitleText.WindowStart(t));

    [Fact]
    public void LanguageLabels()
    {
        Assert.Equal("English", SubtitleText.LanguageLabel("eng"));
        Assert.Equal("Japanese", SubtitleText.LanguageLabel("ja"));
        Assert.Equal("ZZ9", SubtitleText.LanguageLabel("zz9"));
        Assert.Null(SubtitleText.LanguageLabel(null));
        Assert.Equal("spa", SubtitleText.LanguageFromToken("Spanish"));
        Assert.Null(SubtitleText.LanguageFromToken("1080p"));
    }

    private const string Srt = "1\r\n00:00:01,000 --> 00:00:03,500\r\nHello.\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nBye.\r\n";

    [Fact]
    public void SrtToVtt()
    {
        var vtt = SubtitleText.SrtToVtt(Srt);
        Assert.StartsWith("WEBVTT\n\n", vtt);
        Assert.Contains("00:00:01.000 --> 00:00:03.500", vtt);
        Assert.Contains("00:01:02.250 --> 00:01:04.000", vtt);
        Assert.DoesNotContain("\r", vtt);
        Assert.Contains("Hello.", vtt);
        Assert.Contains("Bye.", vtt);
        Assert.StartsWith("WEBVTT", SubtitleText.SrtToVtt("\uFEFF" + Srt));
        Assert.True(SubtitleText.IsWebVtt("WEBVTT\n\n00:00.000 --> 00:01.000\nx"));
        Assert.False(SubtitleText.IsWebVtt(Srt));
    }

    [Fact]
    public void ShiftVttCuesBackwards()
    {
        const string vtt = "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nEarly line.\n\n00:01:29.500 --> 00:01:32.000\nStraddles the cut.\n\n00:02:00.000 --> 00:02:03.000\nLater line.\n";
        var shifted = SubtitleText.ShiftVttCues(vtt, -90);
        Assert.StartsWith("WEBVTT", shifted);
        Assert.DoesNotContain("Early line.", shifted);
        Assert.Contains("00:00:00.000 --> 00:00:02.000\nStraddles the cut.", shifted);
        Assert.Contains("00:00:30.000 --> 00:00:33.000\nLater line.", shifted);
        Assert.Equal(vtt, SubtitleText.ShiftVttCues(vtt, 0));
    }

    [Fact]
    public void ShiftVttCuesForwardsAndKeepsSettings()
    {
        Assert.Contains("00:00:06.000 --> 00:00:07.000", SubtitleText.ShiftVttCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n", 5));
        Assert.Contains("line:90% align:middle", SubtitleText.ShiftVttCues("WEBVTT\n\n00:00:10.000 --> 00:00:12.000 line:90% align:middle\nx\n", -5));
        Assert.Contains("00:00:05.000 --> 00:00:07.000", SubtitleText.ShiftVttCues("WEBVTT\n\n00:10.000 --> 00:12.000\nx\n", -5));
    }

    [Fact]
    public void ExtractArgsSeekBeforeInputAndBoundTheWindow()
    {
        var args = SubtitleExtractor.BuildExtractArgs("http://example.test/video", 2, 480);
        var ss = args.IndexOf("-ss");
        var i = args.IndexOf("-i");
        Assert.True(ss >= 0 && ss < i);
        Assert.Equal("480", args[ss + 1]);
        var t = args.IndexOf("-t");
        Assert.True(t > i);
        Assert.Equal("600", args[t + 1]);
        var map = args.IndexOf("-map");
        Assert.Equal(["-map", "0:2"], args.Skip(map).Take(2));
        Assert.True(SubtitleExtractor.PrefetchExtractTimeoutMs < 45_000);
    }

    [Fact]
    public async Task ExtractorHonoursPreAbortAndCancelOfMissingJobs()
    {
        var root = TestPaths.NewRoot();
        try
        {
            var runner = new FakeProcessRunner();
            var ex = new SubtitleExtractor(new MediaPaths(root), new FfmpegLocator(new MediaOptions { FfmpegPath = Environment.ProcessPath }, [], _ => null), runner, NullLog.For<SubtitleExtractor>());
            using var cts = new CancellationTokenSource();
            await cts.CancelAsync();
            var outcome = await ex.ExtractEmbeddedAsync("abc", "video.mkv", 2, "http://x/v", 0, "test", false, null, cts.Token);
            Assert.False(outcome.Ok);
            Assert.Equal("aborted", outcome.Error);
            Assert.Equal("subtitle extraction was canceled", outcome.Message);
            Assert.Empty(runner.Started);
            Assert.False(ex.CancelEmbedded("missing", "video.mkv", 2, 0, "test"));
        }
        finally { TestPaths.TryDelete(root); }
    }

    [Fact]
    public void CacheEvictionDropsTheOldestEntry()
    {
        var root = TestPaths.NewRoot();
        try
        {
            var ex = new SubtitleExtractor(new MediaPaths(root), new FfmpegLocator(new MediaOptions(), [], _ => null), new FakeProcessRunner(), NullLog.For<SubtitleExtractor>());
            ex.CacheSidecar("abc", "old.mkv", "sidecar:old.srt", "WEBVTT\n\n" + new string('a', 4000));
            ex.CacheSidecar("abc", "new.mkv", "sidecar:new.srt", "WEBVTT\n\n" + new string('b', 4000));
            var oldPath = ex.CachePath("abc", "old.mkv", "sidecar:old.srt", 0);
            File.SetLastWriteTimeUtc(oldPath, DateTime.UnixEpoch);
            File.SetLastAccessTimeUtc(oldPath, DateTime.UnixEpoch);
            var total = Directory.EnumerateFiles(new MediaPaths(root).SubtitlesDir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length);
            ex.Budget = total - new FileInfo(oldPath).Length + 1;
            var removed = ex.EvictOverBudget();
            Assert.True(removed >= 1);
            Assert.False(File.Exists(oldPath));
            Assert.NotNull(ex.ReadCached("abc", "new.mkv", "sidecar:new.srt", 0));
        }
        finally { TestPaths.TryDelete(root); }
    }
}

public class ReleaseTests
{
    private static readonly PlaybackTarget Bear = new("The Bear", "tv");
    private static readonly Dictionary<string, string> NoVerdicts = [];

    private static List<TorrentFlow.Core.Contracts.Search.TorrentResult> Pool(params int[] seeders) =>
        [.. seeders.Select((s, i) => Fixtures.Release($"The Bear S01E01 release {i + 1}", Fixtures.Hash(i + 1), s))];

    [Fact]
    public void DescribesReleaseShapes()
    {
        var a = Releases.DescribeReleaseShape("The Bear S01E01 2160p BluRay x265 HEVC DDP5.1 Atmos");
        Assert.Equal((2160, "BluRay", "HEVC", "Atmos"), (a.Resolution, a.SourceLabel, a.Codec, a.Audio));
        var b = Releases.DescribeReleaseShape("The Bear S01E01 720p WEB-DL H.264 AAC");
        Assert.Equal((720, "WEB-DL", "H.264", "AAC"), (b.Resolution, b.SourceLabel, b.Codec, b.Audio));
    }

    [Theory]
    [InlineData("The Bear S01E01 1080p WEB-DL H.264 AAC.mp4", "direct")]
    [InlineData("The Bear S01E01 2160p x265 HEVC DTS-HD.mkv", "transcode")]
    [InlineData("The Bear S01E01", "unknown")]
    public void Playability(string title, string expected) => Assert.Equal(expected, Releases.Playability(title));

    [Fact]
    public void CandidatesCarryVerdictsAndCurrentFlag()
    {
        var pool = new[]
        {
            Fixtures.Release("The Bear S01E01 1080p WEB-DL", Fixtures.Hash(1)),
            Fixtures.Release("The Bear S01E01 720p WEB-DL", Fixtures.Hash(2)),
            Fixtures.Release("The Bear S01E01 480p", Fixtures.Hash(3)),
        };
        var verdicts = new Dictionary<string, string> { [Fixtures.Hash(1)] = "dead", [Fixtures.Hash(2)] = "good" };
        var out1 = Releases.ListCandidates(pool, Bear, Fixtures.Hash(1), verdicts);
        Assert.Equal(["dead", "good", "unknown"], out1.Select(c => c.Verdict));
        Assert.True(out1[0].IsCurrent);
        Assert.False(out1[1].IsCurrent);
        Assert.Equal([1080, 720], out1.Take(2).Select(c => c.Resolution!.Value));
        Assert.All(Releases.ListCandidates(pool[..2], Bear, null, NoVerdicts), c => Assert.Equal("unknown", c.Verdict));
    }

    [Fact]
    public void CandidatesDropUnkeyableAndDuplicateReleases()
    {
        var pool = new[]
        {
            Fixtures.Release("The Bear S01E01 1080p", Fixtures.Hash(1)),
            Fixtures.Release("The Bear S01E01 1080p dup", Fixtures.Hash(1)),
            Fixtures.Release("no hash", "") with { Magnet = null, InfoHash = null },
        };
        Assert.Single(Releases.ListCandidates(pool, Bear, null, NoVerdicts));
    }

    [Fact]
    public void ChooseNextReleaseWalksThePool()
    {
        var pool = Pool(28, 3, 4, 1);
        Assert.Equal(Fixtures.Hash(1), Releases.ChooseNextRelease(pool, Bear, [])!.InfoHash);
        Assert.Equal(Fixtures.Hash(2), Releases.ChooseNextRelease(pool, Bear, [Fixtures.Hash(1)])!.InfoHash);
        Assert.Equal(Fixtures.Hash(3), Releases.ChooseNextRelease(pool, Bear, [Fixtures.Hash(1), Fixtures.Hash(2)])!.InfoHash);
        Assert.Null(Releases.ChooseNextRelease(pool, Bear, pool.Select(p => p.InfoHash!)));
    }

    [Fact]
    public void SequentialFailoverNeverRepeats()
    {
        var pool = Pool(28, 3, 4, 1);
        var session = FailoverSession.Create("k").Commit(Fixtures.Hash(1));
        var seen = new List<string> { Fixtures.Hash(1) };
        while (true)
        {
            var r = Releases.FailOver(session, pool, Bear);
            if (r.Kind == "exhausted") break;
            seen.Add(r.Candidate!.InfoHash);
            session = r.Session;
        }
        Assert.Equal(Enumerable.Range(1, 4).Select(Fixtures.Hash), seen);
    }

    [Fact]
    public void LargePoolExhaustsAfterEveryRelease()
    {
        var pool = Pool([.. Enumerable.Repeat(5, 12)]);
        var session = FailoverSession.Create("k");
        FailoverResult r;
        var attempts = 0;
        while ((r = Releases.FailOver(session, pool, Bear)).Kind == "switch") { session = r.Session; attempts++; }
        Assert.Equal(12, attempts);
        Assert.Equal(12, r.Session.Tried.Count);
        Assert.Equal("exhausted", r.Narration["phase"]);
    }

    [Fact]
    public void SwitchNarrationDescribesTheNextSource()
    {
        var pool = Pool(28, 3, 4);
        var r = Releases.FailOver(FailoverSession.Create("k").Commit(Fixtures.Hash(1)), pool, Bear);
        Assert.Equal("switch", r.Kind);
        Assert.Equal(1, r.Narration["triedCount"]);
        Assert.Equal("The Bear S01E01 release 2", r.Narration["nextName"]);
        Assert.Equal("delivery", r.Narration["cause"]);
        var outcome = (Dictionary<string, object?>)r.Narration["outcome"]!;
        Assert.Equal("switch-source", outcome["kind"]);
        Assert.Equal(Fixtures.Hash(2), ((SourceOption)outcome["selected"]!).InfoHash);
        Assert.Equal(1, outcome["remainingCount"]);
    }

    [Fact]
    public void ThinPoolExhaustsOnTheSecondFailover()
    {
        var pool = Pool(5, 5);
        var first = Releases.FailOver(FailoverSession.Create("k").Commit(Fixtures.Hash(1)), pool, Bear);
        Assert.Equal(Fixtures.Hash(2), first.Candidate!.InfoHash);
        var second = Releases.FailOver(first.Session, pool, Bear);
        Assert.Equal("exhausted", second.Kind);
        Assert.Equal(2, second.Narration["triedCount"]);
    }

    [Fact]
    public void ZeroSeederPoolReportsNoSeeders()
    {
        var pool = Pool(0, 0);
        var session = FailoverSession.Create("k").Commit(Fixtures.Hash(1)).Commit(Fixtures.Hash(2));
        var r = Releases.FailOver(session, pool, Bear);
        var outcome = (Dictionary<string, object?>)r.Narration["outcome"]!;
        Assert.Equal("no-seeders", outcome["reason"]);
        Assert.Equal(0, outcome["seededCandidateCount"]);
        Assert.Equal("playability", Releases.FailOver(session, pool, Bear, "playability").Narration["cause"]);
    }

    [Fact]
    public void UnkeyableReleasesAreSkipped()
    {
        var pool = new List<TorrentFlow.Core.Contracts.Search.TorrentResult>
        {
            Fixtures.Release("The Bear S01E01 big", "x", 100) with { InfoHash = null, Magnet = "magnet:?dn=nohash" },
            Fixtures.Release("The Bear S01E01 release 2", Fixtures.Hash(2), 3),
        };
        Assert.Equal(Fixtures.Hash(2), Releases.ChooseNextRelease(pool, Bear, [])!.InfoHash);
    }

    [Theory]
    [InlineData("dead", 2)]
    [InlineData("unknown", 1)]
    [InlineData("good", 1)]
    public void VerdictsSteerTheChoice(string topVerdict, int expected)
    {
        var pool = Pool(28, 3, 4);
        var verdicts = new Dictionary<string, string> { [Fixtures.Hash(1)] = topVerdict };
        Assert.Equal(Fixtures.Hash(expected), Releases.ChooseNextRelease(pool, Bear, [], verdicts)!.InfoHash);
    }

    [Fact]
    public void AllDeadFallsBackToTheTopRelease()
    {
        var pool = Pool(28, 3);
        var verdicts = pool.ToDictionary(p => p.InfoHash!, _ => "dead");
        Assert.Equal(Fixtures.Hash(1), Releases.ChooseNextRelease(pool, Bear, [], verdicts)!.InfoHash);
        Assert.Equal(Fixtures.Hash(1), Releases.ChooseNextRelease(pool, Bear, [], null)!.InfoHash);
        var r = Releases.FailOver(FailoverSession.Create("k").Commit(Fixtures.Hash(1)), Pool(28, 3, 4), Bear, verdicts: new Dictionary<string, string> { [Fixtures.Hash(2)] = "dead" });
        Assert.Equal(Fixtures.Hash(3), r.Candidate!.InfoHash);
    }

    [Fact]
    public void OrderByVerdictPromotesGoodAndDemotesDead()
    {
        var pool = Pool(50, 10, 5);
        var verdicts = new Dictionary<string, string> { [Fixtures.Hash(1)] = "dead", [Fixtures.Hash(3)] = "good" };
        var ordered = Releases.OrderByVerdict(pool, r => verdicts.GetValueOrDefault(r.InfoHash!) ?? "unknown");
        Assert.Equal([Fixtures.Hash(3), Fixtures.Hash(2), Fixtures.Hash(1)], ordered.Select(r => r.InfoHash!));
        Assert.Single(Releases.OrderByVerdict(Pool(5)[..1], _ => "dead"));
        Assert.Equal(pool.Select(p => p.InfoHash), Releases.OrderByVerdict(pool, _ => "unknown").Select(p => p.InfoHash));
    }
}

public class SwarmClassifyTests
{
    [Fact]
    public void RequiredBitrate()
    {
        Assert.Equal(1_000_000_000.0 / 2000, SwarmMeasurements.RequiredBitrateBps(1_000_000_000, 2000));
        Assert.Equal(1_000_000, SwarmMeasurements.RequiredBitrateBps(1_000_000_000, null));
        Assert.Equal(1_000_000, SwarmMeasurements.RequiredBitrateBps(1_000_000_000, 0));
    }

    [Fact]
    public void UnreachedOrPeerlessSwarmsAreUnknownNeverDead()
    {
        Assert.Equal("unknown", SwarmMeasurements.Classify(false, 5, 0, 0, 1_000_000));
        Assert.Equal("unknown", SwarmMeasurements.Classify(true, 0, 0, 0, 1_000_000));
    }

    [Fact]
    public void DeliveringSwarmsClassifyByRate()
    {
        Assert.Equal("good", SwarmMeasurements.Classify(true, 3, 3_000_000, 3_000_000, 1_000_000));
        Assert.Equal("dead", SwarmMeasurements.Classify(true, 3, 0, 0, 1_000_000));
        Assert.NotEqual("good", SwarmMeasurements.Classify(true, 3, 100_000, 100_000, 1_000_000));
    }

    [Fact]
    public void MagnetDisplayName()
    {
        Assert.Equal("Big Buck Bunny", SwarmMeasurements.MagnetDisplayName("magnet:?xt=urn:btih:abc&dn=Big+Buck+Bunny"));
        Assert.Null(SwarmMeasurements.MagnetDisplayName("magnet:?xt=urn:btih:abc"));
        Assert.Null(SwarmMeasurements.MagnetDisplayName(null));
    }
}

public class MediaFileTests
{
    [Theory]
    [InlineData("The Movie 2019 BONUS DISC 1080p BluRay-LEGiON")]
    [InlineData("Movie.2019.Bonus.Disc.1080p")]
    [InlineData("Movie 2019 Extras 1080p")]
    [InlineData("Movie 2019 Featurette 1080p")]
    [InlineData("Movie 2019 Featurettes 1080p")]
    [InlineData("Movie.2019.Deleted.Scenes.1080p")]
    [InlineData("Movie 2019 Behind the Scenes")]
    [InlineData("Movie 2019 Making of")]
    [InlineData("Movie 2019 Gag Reel")]
    [InlineData("Movie 2019 Bloopers")]
    [InlineData("Movie.2019.Sample.mkv")]
    [InlineData("Movie 2019 Outtakes")]
    [InlineData("Movie 2019 B-Roll")]
    public void ExtrasAreRecognised(string title) => Assert.True(MediaFiles.IsExtras(title));

    [Theory]
    [InlineData("The Movie 2019 1080p BluRay")]
    [InlineData("The Movie 2019 Extended Cut 1080p")]
    [InlineData("The Movie 2019 Unrated 1080p")]
    [InlineData("The Movie 2019 Theatrical 1080p")]
    [InlineData("The Movie 2019 IMAX 1080p")]
    [InlineData("The Interview 2014 1080p BluRay")]
    [InlineData("Trailer Park Boys S01E01 1080p")]
    [InlineData("")]
    [InlineData(null)]
    public void FeaturesAreNotExtras(string? title) => Assert.False(MediaFiles.IsExtras(title!));

    [Fact]
    public void SelectMainFeatureFile()
    {
        Assert.Equal(2, MediaFiles.SelectMainFeatureFile([("Featurettes/Behind the Scenes.mkv", 900_000_000), ("Sample.mkv", 40_000_000), ("The Movie 2019 1080p.mkv", 8_000_000_000), ("Poster.jpg", 2_000_000)]));
        Assert.Equal(0, MediaFiles.SelectMainFeatureFile([("Movie.mkv", 1)]));
        Assert.Equal(1, MediaFiles.SelectMainFeatureFile([("Deleted Scenes.mkv", 100_000_000), ("Bloopers.mkv", 300_000_000)]));
        Assert.Null(MediaFiles.SelectMainFeatureFile([]));
        Assert.Null(MediaFiles.SelectMainFeatureFile([("readme.txt", 1), ("cover.png", 2)]));
        Assert.Equal(1, MediaFiles.SelectMainFeatureFile([("Bonus Disc.mkv", 9_000_000_000), ("The Movie 1080p.mkv", 5_000_000_000)]));
    }

    [Fact]
    public void UnsafeExecutables()
    {
        Assert.True(MediaFiles.IsUnsafeExecutable("Episode.S01E01.scr"));
        Assert.True(MediaFiles.IsUnsafeExecutable("bonus/setup.exe"));
        Assert.False(MediaFiles.IsUnsafeExecutable("Episode.S01E01.mkv"));
        Assert.True(MediaFiles.IsMediaAsset("Subs/Episode.en.srt"));
        Assert.False(MediaFiles.IsMediaAsset("Episode.nfo"));
    }
}

public class EpisodeTests
{
    [Theory]
    [InlineData("The Bear (2022) - S04 - [HULU WEBDL-1080p][h265]", 4, null, true, false)]
    [InlineData("Bear in the Big Blue House 1997 Season 1 TVRip", 1, null, true, false)]
    [InlineData("Top Gear UK Series 22 (2015) 1080p", 22, null, true, false)]
    [InlineData("Doctor Who Series 1-4 Complete 1080p", null, null, true, true)]
    [InlineData("Sherlock Series 3 E02 1080p BluRay", null, 2, false, false)]
    [InlineData("Top.Gear.UK.Series.22.1080p", 22, null, true, false)]
    [InlineData("Doctor.Who.Series.1-4.Complete", null, null, true, true)]
    [InlineData("The Bear S04E08 1080p DSNP WEB-DL DDP5 1 H 264-FLUX", 4, 8, false, false)]
    [InlineData("Solo Leveling (2024-2025) (Season 1 + 2) 1080p", null, null, true, true)]
    [InlineData("One Piece Ep 1233 S23 1080p", null, 1233, false, false)]
    [InlineData("[SubsPlease] One Piece 1170 S23 1080p", 23, 1170, false, false)]
    [InlineData("[Yameii] I've Been Killing Slimes for 300 Years and Maxed Out My Level - S02 [1080p]", 2, null, true, false)]
    [InlineData("[matheousse] Slime 300 S1 MULTi VF/VOSTFR (BD 1080p)", 1, null, true, false)]
    public void Parses(string title, int? season, int? episode, bool pack, bool multi)
    {
        var p = Episodes.Parse(title);
        if (season is not null) Assert.Equal(season, p.Season);
        Assert.Equal(episode, p.Episode);
        Assert.Equal(pack, p.IsSeasonPack);
        Assert.Equal(multi, p.IsMultiSeason);
        if (pack) Assert.True(p.IsBatch);
    }

    [Fact]
    public void MoviesHaveNoEpisodeLabel()
    {
        var p = Episodes.Parse("Dune Part Two (2024) [1080p] [BluRay]");
        Assert.Null(p.Label);
        Assert.False(p.IsSeasonPack);
    }
}

public class InfoHashTests
{
    [Fact]
    public void NormalizesHexAndBase32()
    {
        Assert.Equal("08ada5a7a6183aae1e09d831df6748d566095a10", InfoHashes.Normalize("08ADA5A7A6183AAE1E09D831DF6748D566095A10"));
        Assert.Equal("08ada5a7a6183aae1e09d831df6748d566095a10", InfoHashes.Normalize("BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ"));
        Assert.Null(InfoHashes.Normalize("abc"));
        Assert.Null(InfoHashes.Normalize(new string('z', 40)));
        Assert.Null(InfoHashes.Normalize(null));
    }

    [Fact]
    public void ReadsMagnets()
    {
        Assert.Equal("08ada5a7a6183aae1e09d831df6748d566095a10", InfoHashes.FromMagnet("magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=Sintel"));
        Assert.Equal("08ada5a7a6183aae1e09d831df6748d566095a10", InfoHashes.FromMagnet("magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ"));
        Assert.Equal("08ada5a7a6183aae1e09d831df6748d566095a10", InfoHashes.FromMagnet("magnet:?xt=urn%3Abtih%3A08ada5a7a6183aae1e09d831df6748d566095a10"));
        Assert.Null(InfoHashes.FromMagnet("magnet:?dn=x"));
    }
}

public class HlsArgsTests
{
    private static readonly AudioPlan Aac2 = new() { StreamIndex = 1, Codec = "aac", Action = "copy", Channels = 2 };
    private const string Url = "http://127.0.0.1:3000/api/stream/abc/a.mkv";

    private static PlaybackPlan Remux(string codec = "h264", AudioPlan? audio = null) =>
        Fixtures.Plan("remux", new VideoPlan { Codec = codec, StreamIndex = 0, Action = "copy" }, audio ?? Aac2);

    private static PlaybackPlan Full(string? hw = null, string target = "h264") =>
        Fixtures.Plan("transcode-full", new VideoPlan { Codec = "vc1", StreamIndex = 0, Action = "transcode", TargetCodec = target, HwAccel = hw },
            new AudioPlan { StreamIndex = 1, Codec = "dts", Action = "transcode", Channels = 6, TargetCodec = "aac" });

    [Theory]
    [InlineData("remux")]
    [InlineData("transcode-audio")]
    [InlineData("transcode-full")]
    public void EveryRungWritesRelativeFmp4EventHls(string rung)
    {
        var plan = rung == "transcode-full" ? Full() : rung == "transcode-audio"
            ? Fixtures.Plan(rung, new VideoPlan { Codec = "h264", Action = "copy" }, new AudioPlan { StreamIndex = 1, Codec = "dts", Action = "transcode", Channels = 6, TargetCodec = "eac3" })
            : Remux();
        var args = HlsArgs.Build(plan, Url);
        Assert.DoesNotContain(args, a => System.Text.RegularExpressions.Regex.IsMatch(a, @"^[A-Za-z]:[\\/]"));
        Assert.Equal("fmp4", args[args.IndexOf("-hls_segment_type") + 1]);
        Assert.Equal("event", args[args.IndexOf("-hls_playlist_type") + 1]);
        Assert.Equal("15000000", args[args.IndexOf("-rw_timeout") + 1]);
        Assert.Contains("-reconnect", args);
        Assert.Contains("-sn", args);
    }

    [Fact]
    public void LocalFilesGetNoNetworkOptions()
    {
        var args = HlsArgs.Build(Remux(), @"D:\media\a.mkv");
        Assert.DoesNotContain("-reconnect", args);
        Assert.DoesNotContain("-rw_timeout", args);
        Assert.Equal(@"D:\media\a.mkv", args[args.IndexOf("-i") + 1]);
        Assert.Equal("disk", HlsArgs.SourceKind(@"D:\media\a.mkv"));
        Assert.Equal("swarm", HlsArgs.SourceKind(Url));
    }

    [Fact]
    public void MapsExplicitlyAndUsesPlainAudioCodecFlag()
    {
        var plan = Fixtures.Plan("remux", new VideoPlan { Codec = "h264", StreamIndex = 2, Action = "copy" }, new AudioPlan { StreamIndex = 4, Codec = "aac", Action = "copy", Channels = 2 });
        var args = HlsArgs.Build(plan, Url);
        Assert.Contains("0:2", args);
        Assert.Contains("0:4", args);
        Assert.Contains("-c:a", args);
        Assert.DoesNotContain(args, a => a.StartsWith("-c:a:", StringComparison.Ordinal));
        Assert.DoesNotContain("-ac", args);
    }

    [Fact]
    public void MissingStreamsAreDisabled()
    {
        Assert.Contains("-an", HlsArgs.Build(Fixtures.Plan("remux", new VideoPlan { Codec = "h264", Action = "copy" }), Url));
        Assert.Contains("-vn", HlsArgs.Build(Fixtures.Plan("remux", null, Aac2), Url));
        var missing = Remux() with { SelectedAudioIndex = 9 };
        Assert.Contains("-an", HlsArgs.Build(missing, Url));
    }

    [Theory]
    [InlineData(6)]
    [InlineData(8)]
    [InlineData(2)]
    public void NeverDownmixes(int channels)
    {
        var plan = Fixtures.Plan("transcode-audio", new VideoPlan { Codec = "h264", Action = "copy" }, new AudioPlan { StreamIndex = 1, Codec = "dts", Action = "transcode", Channels = channels, TargetCodec = "aac" });
        var args = HlsArgs.Build(plan, Url);
        Assert.Equal(channels.ToString(), args[args.IndexOf("-ac") + 1]);
        Assert.Equal(channels > 2, args.Contains("-strict"));
    }

    [Fact]
    public void HevcCopyIsRetaggedButH264IsNot()
    {
        Assert.Contains("hvc1", HlsArgs.Build(Remux("hevc"), Url));
        Assert.DoesNotContain("-tag:v", HlsArgs.Build(Remux("h264"), Url));
    }

    [Theory]
    [InlineData(null, "h264", "libx264", "-crf")]
    [InlineData(null, "hevc", "libx265", "-crf")]
    [InlineData("h264_amf", "h264", "h264_amf", "-quality")]
    [InlineData("h264_nvenc", "h264", "h264_nvenc", "-cq")]
    [InlineData("h264_qsv", "h264", "h264_qsv", "-global_quality")]
    public void EncoderArgs(string? hw, string target, string encoder, string flag)
    {
        var args = HlsArgs.Build(Full(hw, target), Url);
        Assert.Equal(encoder, args[args.IndexOf("-c:v") + 1]);
        Assert.Contains(flag, args);
        Assert.Equal(["-g", "60", "-keyint_min", "60", "-sc_threshold", "0"], args.Skip(args.IndexOf("-g")).Take(6));
    }

    [Fact]
    public void HardwareFallsBackToSoftwareOnRetry()
    {
        var args = HlsArgs.Build(Full("h264_nvenc"), Url, forceSoftware: true);
        Assert.Equal("libx264", args[args.IndexOf("-c:v") + 1]);
    }

    [Fact]
    public void SeekGoesBeforeInputAndUrlIsUntouched()
    {
        const string url = "http://127.0.0.1:3000/api/stream/abc/Show%20S01/a%23b.mkv";
        var args = HlsArgs.Build(Remux(), url, 125);
        Assert.True(args.IndexOf("-ss") < args.IndexOf("-i"));
        Assert.Equal("125", args[args.IndexOf("-ss") + 1]);
        Assert.Equal(url, args[args.IndexOf("-i") + 1]);
        Assert.DoesNotContain("-ss", HlsArgs.Build(Remux(), url, 0));
    }

    [Fact]
    public void SessionKeysIncludeTheSourceKind()
    {
        Assert.NotEqual(HlsSessionManager.SessionKey("h", "a.mkv", 1, 0, "swarm"), HlsSessionManager.SessionKey("h", "a.mkv", 1, 0, "disk"));
        Assert.NotEqual(HlsSessionManager.SessionKey("h", "a.mkv", null, 0, "swarm"), HlsSessionManager.SessionKey("h", "a.mkv", 0, 0, "swarm"));
    }
}

public class VodPlanningTests
{
    private static PlaybackPlan Plan(string rung, string videoAction = "copy") =>
        Fixtures.Plan(rung, new VideoPlan { Codec = "hevc", Action = videoAction, TargetCodec = videoAction == "copy" ? null : "h264" },
            new AudioPlan { StreamIndex = 1, Codec = "eac3", Action = rung == "remux" ? "copy" : "transcode", Channels = 6, TargetCodec = rung == "remux" ? null : "eac3" });

    [Theory]
    [InlineData(false, "remux", "copy", 5400.0, "session")]
    [InlineData(false, "transcode-full", "transcode", 5400.0, "session")]
    [InlineData(true, "remux", "copy", 5400.0, "whole-file")]
    [InlineData(true, "transcode-audio", "copy", 5400.0, "whole-file")]
    [InlineData(true, "transcode-full", "transcode", 5400.0, "vod-segments")]
    [InlineData(true, "direct", "copy", 5400.0, "session")]
    [InlineData(true, "remux", "copy", 0.0, "session")]
    [InlineData(true, "remux", "copy", null, "session")]
    public void StrategyTable(bool complete, string rung, string videoAction, double? duration, string strategy) =>
        Assert.Equal(strategy, VodPlanning.ChooseStrategy(complete, Plan(rung, videoAction), duration).Strategy);

    [Fact]
    public void NoVideoIsAlwaysASession() =>
        Assert.Equal("session", VodPlanning.ChooseStrategy(true, Fixtures.Plan("remux", null), 100).Strategy);

    [Fact]
    public void FixedGrid()
    {
        var s = VodPlanning.FixedGridSegments(10);
        Assert.Equal([4, 4, 2], s.Select(x => x.Duration));
        var sliver = VodPlanning.FixedGridSegments(8.2);
        Assert.Equal(2, sliver.Count);
        Assert.Equal(4.2, sliver[^1].Duration, 3);
        var half = VodPlanning.FixedGridSegments(8.5);
        Assert.Equal(3, half.Count);
        Assert.Equal(0.5, half[^1].Duration, 3);
        Assert.Empty(VodPlanning.FixedGridSegments(0));
        Assert.Empty(VodPlanning.FixedGridSegments(double.NaN));
        Assert.Empty(VodPlanning.FixedGridSegments(-1));
    }

    [Fact]
    public void KeyframeAlignment()
    {
        var s = VodPlanning.KeyframeAlignedSegments([0, 2, 4.2, 6, 8.5, 10], 12);
        Assert.Equal([0, 4.2, 8.5], s.Select(x => x.Start));
        Assert.Equal(12, s.Sum(x => x.Duration), 3);
        var sparse = VodPlanning.KeyframeAlignedSegments([0, 10], 20);
        Assert.Equal([10.0, 10.0], sparse.Select(x => x.Duration));
        var late = VodPlanning.KeyframeAlignedSegments([1.5, 6], 10);
        Assert.Equal(1.5, late[0].Start);
        Assert.Equal(VodPlanning.FixedGridSegments(10).Select(x => x.Duration), VodPlanning.KeyframeAlignedSegments(null, 10).Select(x => x.Duration));
    }

    [Fact]
    public void ParseKeyframeTimes()
    {
        var times = VodPlanning.ParseKeyframeTimes("4.000000,K__\n0.000000,K_\n2.000000,__\nN/A,K_\n\n4.000000,K_\n");
        Assert.Equal([0.0, 4.0], times);
        Assert.Empty(VodPlanning.ParseKeyframeTimes(""));
        Assert.Contains("-show_packets", VodPlanning.BuildKeyframeProbeArgs("a.mkv"));
    }

    [Fact]
    public void PlaylistIsVodAndListsEverySegment()
    {
        var segs = VodPlanning.FixedGridSegments(10.3);
        var text = VodPlanning.BuildVodPlaylist(segs);
        Assert.Contains("#EXT-X-PLAYLIST-TYPE:VOD", text);
        Assert.EndsWith("#EXT-X-ENDLIST\n", text);
        Assert.Equal(segs.Count, text.Split('\n').Count(l => l.StartsWith("seg", StringComparison.Ordinal)));
        Assert.Contains("#EXT-X-TARGETDURATION:4", text);
        var sum = text.Split('\n').Where(l => l.StartsWith("#EXTINF:", StringComparison.Ordinal)).Sum(l => double.Parse(l[8..^1], System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(10.3, sum, 3);
    }

    [Fact]
    public void TrimmingDropsWholeSegmentsAndReportsOffset()
    {
        var text = VodPlanning.BuildVodPlaylist(VodPlanning.FixedGridSegments(20));
        var trimmed = VodPlanning.TrimVodPlaylist(text, 9);
        Assert.Equal(8, trimmed.OffsetSeconds);
        Assert.Contains("#EXT-X-MAP:URI=\"init.mp4\"", trimmed.Text);
        Assert.EndsWith("#EXT-X-ENDLIST\n", trimmed.Text);
        Assert.DoesNotContain("seg00001.m4s", trimmed.Text);
        Assert.Contains("seg00002.m4s", trimmed.Text);
        Assert.Equal(text, VodPlanning.TrimVodPlaylist(text, 0).Text);
        Assert.Equal(16, VodPlanning.TrimVodPlaylist(text, 999).OffsetSeconds);
    }

    private static byte[] Box(string type, int payload)
    {
        var b = new byte[8 + payload];
        BinaryPrimitives.WriteUInt32BigEndian(b, (uint)b.Length);
        Encoding.Latin1.GetBytes(type).CopyTo(b, 4);
        return b;
    }

    [Fact]
    public void SplitFragmentedMp4()
    {
        var init = Box("ftyp", 8).Concat(Box("moov", 16)).ToArray();
        var media = Box("moof", 8).Concat(Box("mdat", 32)).ToArray();
        var split = VodPlanning.SplitFragmentedMp4([.. init, .. media])!;
        Assert.Equal(init, split.Init);
        Assert.Equal(media, split.Media);
        Assert.Null(VodPlanning.SplitFragmentedMp4(init));
        Assert.Null(VodPlanning.SplitFragmentedMp4(media));
        Assert.Null(VodPlanning.SplitFragmentedMp4(init[..^4]));
    }

    [Fact]
    public void SegmentArgs()
    {
        var plan = Plan("transcode-full", "transcode");
        var seg = new VodSegment(3, 12.5, 4);
        var args = VodPlanning.BuildVodSegmentArgs(plan, @"D:\m\a.mkv", seg);
        Assert.True(args.IndexOf("-ss") < args.IndexOf("-i"));
        Assert.Contains("-copyts", args);
        Assert.Contains(args, a => a.Contains("delay_moov", StringComparison.Ordinal));
        Assert.Equal("12.5", args[args.IndexOf("-force_key_frames") + 1]);
        Assert.Equal("6", args[args.IndexOf("-ac") + 1]);
        Assert.Equal("libx264", args[args.IndexOf("-c:v") + 1]);
        Assert.DoesNotContain("-ss", VodPlanning.BuildVodSegmentArgs(plan, "a.mkv", new VodSegment(0, 0, 4)));
        var copy = VodPlanning.BuildVodSegmentArgs(Plan("remux"), "a.mkv", seg);
        Assert.DoesNotContain("-force_key_frames", copy);
        Assert.Contains("hvc1", copy);
        Assert.Equal(2, args.Count(a => a == "-map"));
    }

    [Fact]
    public void WholeFileArgs()
    {
        var args = VodPlanning.BuildWholeFileHlsArgs(Plan("transcode-audio"), @"D:\m\a.mkv");
        Assert.Equal("vod", args[args.IndexOf("-hls_playlist_type") + 1]);
        var flags = args[args.IndexOf("-hls_flags") + 1];
        Assert.Contains("single_file", flags);
        Assert.DoesNotContain("temp_file", flags);
        Assert.Equal("copy", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("6", args[args.IndexOf("-ac") + 1]);
        Assert.Contains("-sn", args);
        Assert.Contains("-map_chapters", args);
        Assert.Equal(VodPlanning.WholeFilePlaylist, args[^1]);
    }

    [Fact]
    public void SegmentNamesRoundTrip()
    {
        Assert.Equal("seg00042.m4s", VodPlanning.SegmentName(42));
        Assert.Equal(42, VodPlanning.ParseSegmentIndex("seg00042.m4s"));
        Assert.Null(VodPlanning.ParseSegmentIndex("seg42.m4s"));
        Assert.Null(VodPlanning.ParseSegmentIndex("../seg00042.m4s"));
    }

    [Fact]
    public void VodIdsAreStableAndDistinct()
    {
        var plan = Plan("remux");
        var id = VodRuntime.VodId("h", "a.mkv", 1, plan);
        Assert.Equal(id, VodRuntime.VodId("h", "a.mkv", 1, plan));
        Assert.NotEqual(id, VodRuntime.VodId("h", "a.mkv", 2, plan));
        Assert.NotEqual(id, VodRuntime.VodId("h", "b.mkv", 1, plan));
        Assert.NotEqual(id, VodRuntime.VodId("h", "a.mkv", null, plan));
        Assert.NotEqual(id, VodRuntime.VodId("h", "a.mkv", 1, Plan("transcode-full", "transcode")));
    }
}
