using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Tests;

internal static class TestPaths
{
    public static string NewRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "tf-media-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    public static void TryDelete(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>In-memory ITorrentEngine: one live torrent per hash, files backed by byte arrays.</summary>
internal sealed class StreamFakeEngine : ITorrentEngine
{
    private readonly Dictionary<string, (EngineTorrentInfo Info, Dictionary<int, byte[]> Data)> _torrents = new(StringComparer.Ordinal);
    public int OpenCount;
    public int ResumeCount;

    public void Add(string hash, string name, params (string Path, byte[] Data)[] files)
    {
        var infos = files.Select((f, i) => new EngineFileInfo(i, f.Path, f.Data.Length, true, 0.5)).ToList();
        _torrents[hash] = (new EngineTorrentInfo
        {
            Hash = hash, Name = name, State = "downloading", Progress = 0.5, SizeBytes = files.Sum(f => (long)f.Data.Length),
            Files = infos, Peers = 3, RetentionState = "stream",
        }, files.Select((f, i) => (i, f.Data)).ToDictionary(x => x.i, x => x.Data));
    }

    public void AddPending(string hash, string state = "paused") =>
        _torrents[hash] = (new EngineTorrentInfo { Hash = hash, Name = hash, State = state }, []);

    public Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default) =>
        Task.FromResult(_torrents.TryGetValue(infoHash, out var t) ? t.Info : null);

    public Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<EngineTorrentInfo>>([.. _torrents.Values.Select(t => t.Info)]);

    public Task<Stream> OpenFileStreamAsync(string infoHash, string fileIndexOrPath, CancellationToken ct = default)
    {
        if (!_torrents.TryGetValue(infoHash, out var t) || !int.TryParse(fileIndexOrPath, out var i) || !t.Data.TryGetValue(i, out var data))
            throw new FileNotFoundException(fileIndexOrPath);
        Interlocked.Increment(ref OpenCount);
        return Task.FromResult<Stream>(new MemoryStream(data, writable: false));
    }

    public Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default)
    {
        Interlocked.Increment(ref ResumeCount);
        return Task.FromResult(new EngineActionResult(true, "ok"));
    }

    public Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default) => Task.FromResult(new EngineAddResult(false, "not supported"));
    public Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "ok"));
    public Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "ok"));
    public Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "ok"));
    public Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default) => Task.FromResult(new EngineActionResult(true, "ok"));
    public Task<long> QueuedReservedBytesAsync(CancellationToken ct = default) => Task.FromResult(0L);

#pragma warning disable CS0067
    public event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted;
#pragma warning restore CS0067
}

/// <summary>The API host with a fake engine and the TorrentFlow background services removed.</summary>
public sealed class MediaApiFactory : WebApplicationFactory<Program>
{
    public string Root { get; } = TestPaths.NewRoot();
    internal StreamFakeEngine Engine { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:Engine:RefreshTrackers", "false");
        builder.UseSetting("TorrentFlow:Engine:Streaming", "true");
        builder.UseSetting("TorrentFlow:Media:SwarmWatchEnabled", "false");
        builder.ConfigureTestServices(s =>
        {
            s.RemoveAll<ITorrentEngine>();
            s.AddSingleton<ITorrentEngine>(Engine);
            foreach (var d in s.Where(d => d.ServiceType == typeof(IHostedService)
                && d.ImplementationType?.Assembly.GetName().Name?.StartsWith("TorrentFlow", StringComparison.Ordinal) == true).ToList())
                s.Remove(d);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        TestPaths.TryDelete(Root);
    }
}

/// <summary>A process runner whose processes never run; tests drive exit and output by hand.</summary>
internal sealed class FakeProcessRunner : IProcessRunner
{
    public List<FakeProcess> Started { get; } = [];
    public Action<FakeProcess>? OnStart { get; set; }
    private int _nextId = 1000;

    public IRunningProcess Start(string fileName, IReadOnlyList<string> arguments, string? workingDirectory = null)
    {
        var p = new FakeProcess(Interlocked.Increment(ref _nextId), fileName, arguments, workingDirectory);
        lock (Started) Started.Add(p);
        OnStart?.Invoke(p);
        return p;
    }
}

internal sealed class FakeProcess(int id, string fileName, IReadOnlyList<string> arguments, string? workingDirectory) : IRunningProcess
{
    private readonly TaskCompletionSource<int> _exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Id { get; } = id;
    public string FileName { get; } = fileName;
    public IReadOnlyList<string> Arguments { get; } = arguments;
    public string? WorkingDirectory { get; } = workingDirectory;
    public Stream StandardOutput { get; } = new MemoryStream();
    public Task<int> Exited => _exit.Task;
    public bool HasExited => _exit.Task.IsCompleted;
    public string StderrTail { get; set; } = "";
    public int KillCount;
    public bool Disposed;
#pragma warning disable CS0067
    public event Action<string>? StderrLine;
#pragma warning restore CS0067

    public void Exit(int code, string stderr = "")
    {
        StderrTail = stderr;
        _exit.TrySetResult(code);
    }

    public void Kill()
    {
        Interlocked.Increment(ref KillCount);
        _exit.TrySetResult(-1);
    }

    public void Dispose() => Disposed = true;

    public void WriteSegment(int index) => File.WriteAllBytes(Path.Combine(WorkingDirectory!, VodSegmentName(index)), [1, 2, 3]);

    private static string VodSegmentName(int index) => "seg" + index.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + ".m4s";
}

internal sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now += by;
}

/// <summary>A [Fact] that skips itself when no ffmpeg/ffprobe can be resolved.</summary>
public sealed class FfmpegFactAttribute : FactAttribute
{
    public FfmpegFactAttribute()
    {
        if (Ff.Binaries.TryResolveFfmpeg() is null || Ff.Binaries.TryResolveFfprobe() is null)
            Skip = "ffmpeg/ffprobe are unavailable (set FFMPEG_PATH/FFPROBE_PATH or install ffmpeg-static/ffprobe-static)";
    }
}

internal static class Ff
{
    public static readonly FfmpegLocator Binaries = new(new MediaOptions(), [Directory.GetCurrentDirectory(), AppContext.BaseDirectory], Environment.GetEnvironmentVariable);
}

internal static class Fixtures
{
    public static byte[] Bytes(int length)
    {
        var data = new byte[length];
        for (var i = 0; i < length; i++) data[i] = (byte)(i % 251);
        return data;
    }

    public static ProbeStream Video(string codec, int index = 0, string? profile = null, string? transfer = null) =>
        new() { Index = index, CodecType = "video", Codec = codec, Profile = profile, ColorTransfer = transfer, Width = 1920, Height = 1080 };

    public static ProbeStream Audio(string codec, int channels = 2, int index = 1, string? language = null, string? title = null) =>
        new() { Index = index, CodecType = "audio", Codec = codec, Channels = channels, Language = language, Title = title };

    public static ProbeStream Sub(string codec, int index, string? language = null, string? title = null) =>
        new() { Index = index, CodecType = "subtitle", Codec = codec, Language = language, Title = title };

    public static ProbeResult Probe(string container, params ProbeStream[] streams) => new(container, 3600, streams);

    public static PlaybackPlan Plan(string rung, VideoPlan? video, params AudioPlan[] audio) => new()
    {
        Rung = rung, Reason = "test", Video = video, Audio = audio, SelectedAudioIndex = audio.FirstOrDefault()?.StreamIndex,
        Container = "mkv", Subtitle = new SubtitleDecision(null, true, false, false, false, "test"),
    };

    public static TorrentFlow.Core.Contracts.Search.TorrentResult Release(string title, string hash, int seeders = 10) => new()
    {
        Id = hash, Title = title, InfoHash = hash, Magnet = $"magnet:?xt=urn:btih:{hash}", Seeders = seeders, Source = "test", SourceUrl = "https://example.test",
    };

    public static string Hash(int n) => n.ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(40, '0');

    public static IOptions<MediaOptions> Options(Action<MediaOptions>? configure = null)
    {
        var o = new MediaOptions();
        configure?.Invoke(o);
        return Microsoft.Extensions.Options.Options.Create(o);
    }

    public static string Utf8(byte[] b) => Encoding.UTF8.GetString(b);
}

internal static class NullLog
{
    public static Microsoft.Extensions.Logging.ILogger<T> For<T>() => NullLogger<T>.Instance;
}
