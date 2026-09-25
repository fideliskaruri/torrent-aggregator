using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Media.Features.Subtitles;

namespace TorrentFlow.Media.Tests;

internal sealed class SubtitlesEnvironment : IHostEnvironment
{
    public string EnvironmentName { get; set; } = "Testing";
    public string ApplicationName { get; set; } = typeof(SubtitlesEnvironment).Assembly.GetName().Name!;
    public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}

public sealed class SubtitlesFfmpegFactAttribute : FactAttribute
{
    public SubtitlesFfmpegFactAttribute()
    {
        if (FindBinary("ffmpeg") is null) Skip = "ffmpeg is not installed; set FFMPEG_PATH to run local media fixture tests.";
    }

    internal static string? FindBinary(string name)
    {
        var extraction = new SubtitleExtraction(new ConfigurationBuilder().Build(), new SubtitlesEnvironment());
        using (extraction)
        {
            try { return extraction.ResolveBinary(name); }
            catch (IOException) { return null; }
        }
    }
}

public sealed class SubtitlesExtractionTests : IDisposable
{
    private readonly string _root = Path.Combine(Directory.GetCurrentDirectory(), ".subtitle-tests", Guid.NewGuid().ToString("N"));
    private readonly SubtitleExtraction _extraction;

    public SubtitlesExtractionTests()
    {
        _extraction = new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TorrentFlow:DataDirectory"] = _root
        }).Build(), new SubtitlesEnvironment());
    }

    [Fact]
    public async Task AbortedRequestsNeverOpenEngineStreams()
    {
        var engine = new SubtitleFakeEngine();
        using var cancel = new CancellationTokenSource();
        cancel.Cancel();
        var result = await _extraction.ExtractAsync(engine, "canceled-test", "video.mkv", 2, 0, "test", false, cancel.Token);
        Assert.Equal("aborted", result.Error);
        Assert.Equal("subtitle extraction was canceled", result.Message);
        Assert.Equal(0, engine.OpenCount);
        Assert.False(_extraction.Cancel("missing", "video.mkv", 2, 0, "test"));
    }

    [Fact]
    public void CacheUsesLeastRecentlyUsedEvictionAndIndependentWindows()
    {
        const string oldCue = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nold\n";
        const string newCue = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nnew\n";
        _extraction.WriteCache("hash", "film.mkv", "sidecar:old.srt", oldCue);
        var old = Assert.Single(Directory.GetFiles(_extraction.CacheDirectory, "*.vtt"));
        File.SetLastWriteTimeUtc(old, DateTime.UnixEpoch);
        _extraction.WriteCache("hash", "film.mkv", "sidecar:new.srt", newCue);
        Assert.Equal(1, _extraction.EvictCache(Encoding.UTF8.GetByteCount(newCue)));
        Assert.Null(_extraction.ReadCache("hash", "film.mkv", "sidecar:old.srt"));
        Assert.Equal(newCue, _extraction.ReadCache("hash", "film.mkv", "sidecar:new.srt"));
        _extraction.WriteCache("hash", "film.mkv", "embedded:2", oldCue, 480);
        Assert.Null(_extraction.ReadCache("hash", "film.mkv", "embedded:2", 0));
        Assert.Equal(oldCue, _extraction.ReadCache("hash", "film.mkv", "embedded:2", 480));
    }

    [Fact]
    public async Task VttPassesThroughAndSrtDoesNotRequireFfmpeg()
    {
        const string vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nCafé 日本語";
        Assert.Equal(vtt, (await _extraction.ConvertAsync(Encoding.UTF8.GetBytes(vtt), "vtt", default)).Vtt);
        Assert.Equal(vtt, (await _extraction.ConvertAsync(Encoding.UTF8.GetBytes(vtt), "ass", default)).Vtt);
        Assert.Equal("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello",
            (await _extraction.ConvertAsync(Encoding.UTF8.GetBytes("1\n00:00:00,000 --> 00:00:01,000\nhello"), ".SRT", default)).Vtt);
        var unsupported = await _extraction.ConvertAsync([], "xyz", default);
        Assert.False(unsupported.Ok);
        Assert.Equal("unsupported sidecar type .xyz", unsupported.Message);
    }

    [Fact]
    public void ProbeParsingPreservesNoStreamsErrorsAndUppercaseMetadata()
    {
        Assert.Equal("no_streams", SubtitleExtraction.ParseProbeStreams("{}").Error);
        Assert.Equal("no_streams", SubtitleExtraction.ParseProbeStreams("""{"streams":[]}""").Error);
        Assert.Equal("probe_failed", SubtitleExtraction.ParseProbeStreams("invalid").Error);
        var parsed = SubtitleExtraction.ParseProbeStreams("""
            {"streams":[{"codec_type":"SUBTITLE","codec_name":"SubRip","tags":{"LANGUAGE":"eng","TITLE":"English"}},
                        {"index":5,"codec_type":"audio","codec_name":"aac","disposition":{"default":"1"}}]}
            """);
        Assert.Null(parsed.Error);
        Assert.Equal("subtitle", parsed.Streams![0].CodecType);
        Assert.Equal("subrip", parsed.Streams[0].Codec);
        Assert.Equal("English", parsed.Streams[0].Title);
        Assert.Equal("eng", parsed.Streams[0].Language);
        Assert.Equal(0, parsed.Streams[0].Index);
        Assert.True(parsed.Streams[1].DispositionDefault);
    }

    [SubtitlesFfmpegFact]
    public async Task AssConversionProducesVttAndCleansScratchFiles()
    {
        const string ass = """
            [Script Info]
            ScriptType: v4.00+
            PlayResX: 640
            PlayResY: 480
            [V4+ Styles]
            Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
            Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
            [Events]
            Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
            Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello fixture.
            """;
        var result = await _extraction.ConvertAsync(Encoding.UTF8.GetBytes(ass), "ass", default);
        Assert.True(result.Ok, result.Message);
        Assert.StartsWith("WEBVTT", result.Vtt);
        Assert.Contains("Hello fixture.", result.Vtt);
        Assert.Empty(Directory.GetFiles(_extraction.CacheDirectory, "in-*"));
    }

    [Fact]
    public async Task SchedulerBoundsConcurrencyQueueAndPrioritizesForeground()
    {
        var releases = Enumerable.Range(0, 2).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var active = 0;
        var highWater = 0;
        async Task<SubtitleOutcome> Block(CancellationToken ct)
        {
            var count = Interlocked.Increment(ref active);
            highWater = Math.Max(highWater, count);
            await releases[count - 1].Task.WaitAsync(ct);
            Interlocked.Decrement(ref active);
            return new("WEBVTT\n\n");
        }
        var running = Enumerable.Range(0, 2).Select(_ => _extraction.WithSlotAsync(false, default, Block)).ToArray();
        Assert.Equal(2, active);
        var order = new List<int>();
        var foregroundStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = Enumerable.Range(0, 16).Select(i => _extraction.WithSlotAsync(i < 15, default, _ =>
        {
            lock (order) order.Add(i);
            if (i == 15) foregroundStarted.TrySetResult();
            return Task.FromResult(new SubtitleOutcome("WEBVTT\n\n"));
        })).ToArray();
        var full = await _extraction.WithSlotAsync(false, default, Block);
        Assert.Equal("subtitle extraction queue is full", full.Message);
        releases[0].TrySetResult();
        await foregroundStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        releases[1].TrySetResult();
        await Task.WhenAll(running.Concat(queued)).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, highWater);
        Assert.Equal(15, order[0]);
        Assert.Equal(16, order.Count);
    }

    [Fact]
    public async Task CancelingAQueuedJobDoesNotLeakASlotOrRunItsWork()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var running = Enumerable.Range(0, 2).Select(_ => _extraction.WithSlotAsync(false, default, async ct =>
        {
            await release.Task.WaitAsync(ct);
            return new SubtitleOutcome("WEBVTT\n\n");
        })).ToArray();
        using var cancellation = new CancellationTokenSource();
        var executed = false;
        var queued = _extraction.WithSlotAsync(false, cancellation.Token, _ =>
        {
            executed = true;
            return Task.FromResult(new SubtitleOutcome("WEBVTT\n\n"));
        });
        cancellation.Cancel();
        Assert.Equal("aborted", (await queued).Error);
        release.TrySetResult();
        await Task.WhenAll(running);
        Assert.False(executed);
        Assert.True((await _extraction.WithSlotAsync(false, default, _ => Task.FromResult(new SubtitleOutcome("WEBVTT\n\n")))).Ok);
    }

    [SubtitlesFfmpegFact]
    public async Task EmbeddedExtractionSeeksThroughEngineAndCachesBoundedWindows()
    {
        var engine = await FixtureEngineAsync();
        var result = await _extraction.ExtractAsync(engine, "fixture", "fixture.mkv", 0, 480, "viewer", false, default);
        Assert.True(result.Ok, result.Message);
        Assert.StartsWith("WEBVTT", result.Vtt);
        Assert.Contains("Later cue.", result.Vtt);
        Assert.DoesNotContain("Early cue.", result.Vtt);
        Assert.True(engine.OpenCount > 0);
        var opened = engine.OpenCount;
        var cached = await _extraction.ExtractAsync(engine, "fixture", "fixture.mkv", 0, 480, "viewer", false, default);
        Assert.Equal(result.Vtt, cached.Vtt);
        Assert.Equal(opened, engine.OpenCount);
        var empty = await _extraction.ExtractAsync(engine, "fixture", "fixture.mkv", 0, 960, "viewer", false, default);
        Assert.True(empty.Ok, empty.Message);
        Assert.StartsWith("WEBVTT", empty.Vtt);
        Assert.DoesNotContain("-->", empty.Vtt);
    }

    [SubtitlesFfmpegFact]
    public async Task SharedExtractionSurvivesOneConsumerCancellation()
    {
        var engine = await FixtureEngineAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        engine.OpenOverride = async (hash, path, ct) =>
        {
            entered.TrySetResult();
            await release.Task.WaitAsync(ct);
            return new MemoryStream(engine.Content[(hash, path)], false);
        };
        var first = _extraction.ExtractAsync(engine, "fixture", "fixture.mkv", 0, 0, "one", false, default);
        var second = _extraction.ExtractAsync(engine, "fixture", "fixture.mkv", 0, 0, "two", false, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(_extraction.Cancel("fixture", "fixture.mkv", 0, 0, "one"));
        Assert.Equal("aborted", (await first.WaitAsync(TimeSpan.FromSeconds(5))).Error);
        release.TrySetResult();
        var result = await second.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.True(result.Ok, result.Message);
        Assert.Contains("Early cue.", result.Vtt);
        Assert.Contains("Later cue.", result.Vtt);
    }

    private async Task<SubtitleFakeEngine> FixtureEngineAsync()
    {
        Directory.CreateDirectory(_root);
        var input = Path.Combine(_root, "fixture.srt");
        var output = Path.Combine(_root, "fixture.mkv");
        await File.WriteAllTextAsync(input, "1\n00:00:01,000 --> 00:00:03,000\nEarly cue.\n\n2\n00:08:01,000 --> 00:08:03,000\nLater cue.\n");
        using var process = new Process { StartInfo = new(SubtitlesFfmpegFactAttribute.FindBinary("ffmpeg")!)
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true } };
        foreach (var arg in new[] { "-y", "-hide_banner", "-loglevel", "error", "-f", "srt", "-i", input, "-map", "0:s:0", "-c:s", "srt", output })
            process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(true); await process.WaitForExitAsync(); throw; }
        Assert.Equal(0, process.ExitCode);
        Assert.True(string.IsNullOrWhiteSpace(await stderr));
        var engine = new SubtitleFakeEngine();
        engine.Content[("fixture", "fixture.mkv")] = await File.ReadAllBytesAsync(output);
        return engine;
    }

    public void Dispose()
    {
        _extraction.Dispose();
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
    }
}
