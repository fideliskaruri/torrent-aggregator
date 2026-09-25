using System.Text.Json;
using TorrentFlow.Media.Controllers;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Tests;

public sealed class HlsSessionLifecycleTests : IDisposable
{
    private readonly string _root = TestPaths.NewRoot();
    private readonly FakeProcessRunner _runner = new();
    private readonly ManualClock _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
    private readonly HlsSessionManager _manager;
    private const string Url = "http://127.0.0.1:3000/api/stream/abc/a.mkv";

    public HlsSessionLifecycleTests() : this(2) { }

    private HlsSessionLifecycleTests(int maxConcurrent)
    {
        _manager = Create(maxConcurrent, Environment.ProcessPath!);
    }

    private HlsSessionManager Create(int maxConcurrent, string? ffmpeg) =>
        new(new TorrentFlow.Media.Common.MediaPaths(Path.Combine(_root, ".sessions")),
            new FfmpegLocator(new MediaOptions { FfmpegPath = ffmpeg }, [], _ => null), _runner,
            Fixtures.Options(o => { o.MaxConcurrentSessions = maxConcurrent; o.SessionIdleTimeoutSeconds = 60; }), _clock, NullLog.For<HlsSessionManager>())
        { RemoveRetryDelaysMs = [10] };

    private static PlaybackPlan Remux() => Fixtures.Plan("remux", new VideoPlan { Codec = "h264", Action = "copy" }, new AudioPlan { StreamIndex = 1, Codec = "aac", Action = "copy", Channels = 2 });

    private static PlaybackPlan HardwareTranscode() => Fixtures.Plan("transcode-full",
        new VideoPlan { Codec = "vc1", Action = "transcode", TargetCodec = "h264", HwAccel = "h264_nvenc" },
        new AudioPlan { StreamIndex = 1, Codec = "aac", Action = "copy", Channels = 2 });

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(20);
        Assert.True(condition(), "condition not reached");
    }

    public void Dispose()
    {
        _manager.StopAll();
        TestPaths.TryDelete(_root);
    }

    [Fact]
    public void SpawnsOneFfmpegPerKeyAndSharesIt()
    {
        var a = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url);
        Assert.True(a.Ok);
        var s = a.Session!;
        Assert.Equal("starting", s.State);
        Assert.Equal("swarm", s.Source);
        var p = Assert.Single(_runner.Started);
        Assert.Equal(s.OutputDir, p.WorkingDirectory);
        Assert.Contains("playlist.m3u8", p.Arguments);
        Assert.True(File.Exists(Path.Combine(s.OutputDir, "ffmpeg.pid")));
        var b = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url);
        Assert.Same(s, b.Session);
        Assert.Equal(2, s.Refs);
        Assert.Single(_runner.Started);
        Assert.Same(s, _manager.Get(s.Id));
    }

    [Fact]
    public void ANewOffsetReplacesTheOldSessionForTheSameFile()
    {
        var first = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        var second = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url, 300).Session!;
        Assert.NotSame(first, second);
        Assert.Equal("stopped", first.State);
        Assert.Equal(1, _runner.Started[0].KillCount);
        Assert.False(Directory.Exists(first.OutputDir));
        Assert.Null(_manager.Get(first.Id));
        Assert.Contains("-ss", _runner.Started[1].Arguments);
    }

    [Fact]
    public void ConcurrencyCapRefusesExtraSessions()
    {
        Assert.True(_manager.GetOrCreate("h1", "a.mkv", Remux(), Url).Ok);
        Assert.True(_manager.GetOrCreate("h2", "a.mkv", Remux(), Url).Ok);
        var third = _manager.GetOrCreate("h3", "a.mkv", Remux(), Url);
        Assert.False(third.Ok);
        Assert.Contains("Maximum concurrent sessions (2)", third.Error);
        Assert.Equal(2, _runner.Started.Count);
    }

    [Fact]
    public void MissingFfmpegIsReportedWithoutSpawning()
    {
        var manager = Create(2, Path.Combine(_root, "nope", "ffmpeg.exe"));
        var r = manager.GetOrCreate("abc", "a.mkv", Remux(), Url);
        Assert.False(r.Ok);
        Assert.Contains("ffmpeg-static", r.Error);
        Assert.Empty(_runner.Started);
    }

    [Fact]
    public void FirstSegmentMarksRunningAndStartupTimeoutStalls()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        _clock.Advance(TimeSpan.FromSeconds(3));
        _runner.Started[0].WriteSegment(0);
        _manager.WatchdogTick(s);
        Assert.Equal("running", s.State);
        Assert.Equal(3000, s.TimeToFirstSegmentMs);

        var t = _manager.GetOrCreate("def", "b.mkv", Remux(), Url).Session!;
        _clock.Advance(TimeSpan.FromMilliseconds(HlsSessionManager.StartupTimeoutMs + 1));
        _manager.WatchdogTick(t);
        Assert.Equal("stalled", t.State);
        Assert.Contains("first segment", t.Error);
        Assert.Equal(1, _runner.Started[1].KillCount);
    }

    [Fact]
    public void OutputStallAfterStartKillsFfmpeg()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        _runner.Started[0].WriteSegment(0);
        _manager.WatchdogTick(s);
        _clock.Advance(TimeSpan.FromMilliseconds(HlsSessionManager.OutputStallTimeoutMs + 1));
        _manager.WatchdogTick(s);
        Assert.Equal("stalled", s.State);
        Assert.Contains("stopped producing data", s.Error);
    }

    [Fact]
    public async Task CleanExitStopsAndFailingExitErrors()
    {
        var ok = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        _runner.Started[0].WriteSegment(0);
        _runner.Started[0].Exit(0);
        await WaitUntil(() => ok.State == "stopped");

        var bad = _manager.GetOrCreate("def", "b.mkv", Remux(), Url).Session!;
        _runner.Started[1].Exit(1, "Invalid data found when processing input");
        await WaitUntil(() => bad.State == "error");
        Assert.StartsWith("ffmpeg exited with code 1", bad.Error);

        var aborted = _manager.GetOrCreate("ghi", "c.mkv", Remux(), Url).Session!;
        _runner.Started[2].Exit(1, "Error during demuxing: Connection timed out");
        await WaitUntil(() => aborted.State == "stalled");
    }

    [Fact]
    public async Task HardwareEncoderThatProducesNothingRetriesInSoftware()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", HardwareTranscode(), Url).Session!;
        var hw = _runner.Started[0];
        Assert.Equal("h264_nvenc", hw.Arguments[hw.Arguments.ToList().IndexOf("-c:v") + 1]);
        hw.Exit(1, "Cannot load nvcuda.dll");
        await WaitUntil(() => _runner.Started.Count == 2);
        var sw = _runner.Started[1];
        Assert.Equal("libx264", sw.Arguments[sw.Arguments.ToList().IndexOf("-c:v") + 1]);
        Assert.True(s.UsedSoftwareFallback);
        sw.Exit(1, "still broken");
        await WaitUntil(() => s.State == "error");
        Assert.Equal(2, _runner.Started.Count);
    }

    [Fact]
    public void IdleSessionsAreReapedAfterTheTimeout()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        _manager.Unref(s.Id);
        Assert.Equal(0, s.Refs);
        _clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal(0, _manager.ReapIdle());
        _clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(1, _manager.ReapIdle());
        Assert.Null(_manager.Get(s.Id));
        Assert.Equal(1, _runner.Started[0].KillCount);
        Assert.True(_runner.Started[0].Disposed);
        Assert.False(Directory.Exists(s.OutputDir));
    }

    [Fact]
    public void AReferencedSessionIsNeverReaped()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        _clock.Advance(TimeSpan.FromHours(1));
        Assert.Equal(0, _manager.ReapIdle());
        Assert.Same(s, _manager.Get(s.Id));
    }

    [Fact]
    public void StopAllKillsEveryProcessAndRemovesDirs()
    {
        var a = _manager.GetOrCreate("h1", "a.mkv", Remux(), Url).Session!;
        var b = _manager.GetOrCreate("h2", "a.mkv", Remux(), Url).Session!;
        _manager.StopAll();
        Assert.All(_runner.Started, p => Assert.Equal(1, p.KillCount));
        Assert.Empty(_manager.All());
        Assert.False(Directory.Exists(a.OutputDir));
        Assert.False(Directory.Exists(b.OutputDir));
    }

    [Fact]
    public void StaleSessionDirsAreCleanedButReservedDirsKept()
    {
        var sessions = Path.Combine(_root, ".sessions");
        var stale = Directory.CreateDirectory(Path.Combine(sessions, "0123456789abcdef")).FullName;
        File.WriteAllText(Path.Combine(stale, "ffmpeg.pid"), JsonSerializer.Serialize(new { pid = Environment.ProcessId }));
        Directory.CreateDirectory(Path.Combine(sessions, "vod"));
        Directory.CreateDirectory(Path.Combine(sessions, "not-a-session"));
        var live = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        Assert.Equal(1, _manager.CleanupStaleDirs());
        Assert.False(Directory.Exists(stale));
        Assert.True(Directory.Exists(Path.Combine(sessions, "vod")));
        Assert.True(Directory.Exists(Path.Combine(sessions, "not-a-session")));
        Assert.True(Directory.Exists(live.OutputDir));
    }

    [Fact]
    public async Task WaitForFileReturnsOnceItAppearsOrTheSessionDies()
    {
        var s = _manager.GetOrCreate("abc", "a.mkv", Remux(), Url).Session!;
        var target = Path.Combine(s.OutputDir, "seg00000.m4s");
        var wait = _manager.WaitForFileAsync(s, target, 5000, CancellationToken.None);
        _runner.Started[0].WriteSegment(0);
        Assert.True(await wait);
        Assert.Equal("running", s.State);
        _runner.Started[0].Exit(1, "boom");
        await WaitUntil(() => s.State == "error");
        Assert.False(await _manager.WaitForFileAsync(s, Path.Combine(s.OutputDir, "seg00009.m4s"), 5000, CancellationToken.None));
    }
}

public sealed class FfmpegLocatorTests : IDisposable
{
    private readonly string _root = TestPaths.NewRoot();
    private static string Exe(string n) => OperatingSystem.IsWindows() ? n + ".exe" : n;

    private string Touch(params string[] parts)
    {
        var path = Path.Combine([_root, .. parts]);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "");
        return path;
    }

    public void Dispose() => TestPaths.TryDelete(_root);

    [Fact]
    public void ConfigBeatsEnvBeatsNodeModulesBeatsPath()
    {
        var configured = Touch("cfg", Exe("ffmpeg"));
        var env = Touch("env", Exe("ffmpeg"));
        var bundled = Touch("app", "node_modules", "ffmpeg-static", Exe("ffmpeg"));
        var onPath = Touch("bin", Exe("ffmpeg"));
        var project = Path.Combine(_root, "app", "server", "api");
        Directory.CreateDirectory(project);
        var vars = new Dictionary<string, string?> { ["FFMPEG_PATH"] = env, ["PATH"] = Path.GetDirectoryName(onPath) };

        Assert.Equal(configured, new FfmpegLocator(new MediaOptions { FfmpegPath = configured }, [project], k => vars.GetValueOrDefault(k)).ResolveFfmpeg());
        Assert.Equal(env, new FfmpegLocator(new MediaOptions(), [project], k => vars.GetValueOrDefault(k)).ResolveFfmpeg());
        vars.Remove("FFMPEG_PATH");
        Assert.Equal(bundled, new FfmpegLocator(new MediaOptions(), [project], k => vars.GetValueOrDefault(k)).ResolveFfmpeg());
        Assert.Equal(onPath, new FfmpegLocator(new MediaOptions(), [Path.Combine(_root, "elsewhere")], k => vars.GetValueOrDefault(k)).ResolveFfmpeg());
    }

    [Fact]
    public void FfprobeUsesThePlatformLayoutOfFfprobeStatic()
    {
        var platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";
        var arch = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
            System.Runtime.InteropServices.Architecture.X86 => "ia32",
            _ => "x64",
        };
        var probe = Touch("node_modules", "ffprobe-static", "bin", platform, arch, Exe("ffprobe"));
        Assert.Equal(probe, new FfmpegLocator(new MediaOptions(), [_root], _ => null).ResolveFfprobe());
    }

    [Fact]
    public void MissingBinariesExplainTheFix()
    {
        var bins = new FfmpegLocator(new MediaOptions(), [_root], _ => null);
        var ex = Assert.Throws<FfmpegBinaryMissingException>(bins.ResolveFfprobe);
        Assert.Contains("ffprobe-static", ex.Message);
        Assert.Contains("npm install ffprobe-static", ex.Message);
        Assert.Null(bins.TryResolveFfmpeg());
        var bad = Assert.Throws<FfmpegBinaryMissingException>(() => new FfmpegLocator(new MediaOptions { FfmpegPath = Path.Combine(_root, "boom.exe") }, [], _ => null).ResolveFfmpeg());
        Assert.Contains("boom", bad.Message);
        var badEnv = Assert.Throws<FfmpegBinaryMissingException>(() => new FfmpegLocator(new MediaOptions(), [], k => k == "FFMPEG_PATH" ? Path.Combine(_root, "missing") : null).ResolveFfmpeg());
        Assert.Contains("FFMPEG_PATH", badEnv.Message);
    }
}

public class ControllerHelperTests
{
    private static JsonElement Json(string s) => JsonDocument.Parse(s).RootElement;

    [Theory]
    [InlineData("""{"mime":"video/mp4","canPlay":""}""", null)]
    [InlineData("""{"mime":"video/mp4","canPlay":"maybe"}""", null)]
    [InlineData("""{"mime":"video/mp4","canPlay":"probably"}""", null)]
    [InlineData("""{"mime":"video/mp4","canPlay":"likely"}""", "canPlay must be one of: \"\", \"maybe\", \"probably\"")]
    [InlineData("""{"mime":"video/mp4","canPlay":2}""", "canPlay must be a string")]
    [InlineData("""{"mime":"  ","canPlay":""}""", "mime is required")]
    [InlineData("""{"canPlay":""}""", "mime is required")]
    [InlineData("""{"mime":"video/mp4"}""", "canPlay is required")]
    public void ParseCodecEntry(string json, string? error) => Assert.Equal(error, PlaybackController.ParseCodecEntry(Json(json))?.Error);

    [Theory]
    [InlineData("Show/Episode.mkv", true)]
    [InlineData("Episode.mkv", true)]
    [InlineData("../Episode.mkv", false)]
    [InlineData("Show/../../x.mkv", false)]
    [InlineData("/etc/passwd", false)]
    [InlineData("C:\\x.mkv", false)]
    [InlineData("a\0b.mkv", false)]
    public void SafeTorrentPaths(string path, bool safe) => Assert.Equal(safe, PlaybackController.IsSafeTorrentPath(path));
}

public sealed class FfmpegSmokeTests : IDisposable
{
    private readonly string _root = TestPaths.NewRoot();

    public void Dispose() => TestPaths.TryDelete(_root);

    [FfmpegFact]
    public async Task ProbesAndSegmentsARealFile()
    {
        var ffmpeg = Ff.Binaries.ResolveFfmpeg();
        var ffprobe = Ff.Binaries.ResolveFfprobe();
        var runner = new SystemProcessRunner();
        var source = Path.Combine(_root, "tiny.mkv");
        var gen = await ProcessRuns.RunAsync(runner, ffmpeg,
            ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "aac", "-shortest", source],
            TimeSpan.FromSeconds(60), 1 << 20, CancellationToken.None);
        Assert.True(gen.ExitCode == 0, gen.Stderr);

        var probeRun = await ProcessRuns.RunAsync(runner, ffprobe, ProbeShape.BuildProbeArgs(source, false), TimeSpan.FromSeconds(30), 4 << 20, CancellationToken.None);
        var probe = ProbeShape.Parse(System.Text.Encoding.UTF8.GetString(probeRun.Stdout));
        Assert.True(probe.Ok, probe.Error?.Message);
        Assert.Equal("h264", probe.Result!.Video!.Codec);
        Assert.Equal("aac", probe.Result.Audio.Single().Codec);
        Assert.InRange(probe.Result.Duration ?? 0, 2.5, 3.5);

        var plan = Decide.DecidePlayback(probe.Result, DecideTests.EdgeCaps);
        Assert.Equal("remux", plan.Rung);

        var manager = new HlsSessionManager(new TorrentFlow.Media.Common.MediaPaths(Path.Combine(_root, ".sessions")),
            new FfmpegLocator(new MediaOptions { FfmpegPath = ffmpeg }, [], _ => null), runner, Fixtures.Options(), TimeProvider.System, NullLog.For<HlsSessionManager>());
        var session = manager.GetOrCreate("smoke", "tiny.mkv", plan, source).Session!;
        Assert.Equal("disk", session.Source);
        try
        {
            Assert.True(await manager.WaitForFileAsync(session, Path.Combine(session.OutputDir, "seg00000.m4s"), 30_000, CancellationToken.None), session.Error);
            Assert.True(File.Exists(Path.Combine(session.OutputDir, "init.mp4")));
            for (var i = 0; i < 100 && session.State is "starting" or "running"; i++) await Task.Delay(100);
            Assert.Equal("stopped", session.State);
            var playlist = await File.ReadAllTextAsync(session.ManifestPath);
            Assert.Contains("#EXT-X-MAP:URI=\"init.mp4\"", playlist);
            Assert.Contains("#EXT-X-ENDLIST", playlist);
        }
        finally
        {
            manager.StopAll();
        }
        Assert.False(Directory.Exists(session.OutputDir));
    }
}
