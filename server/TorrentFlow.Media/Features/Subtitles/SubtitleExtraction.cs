using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Media.Features.Subtitles;

internal sealed record SubtitleOutcome(string? Vtt, string? Error = null, string? Message = null)
{
    public bool Ok => Error is null;
    public static SubtitleOutcome Aborted() => new(null, "aborted", "subtitle extraction was canceled");
}

internal sealed class SubtitleExtraction(IConfiguration configuration, IHostEnvironment environment) : IDisposable
{
    public const int ExtractTimeoutMs = 45_000;
    public const int PrefetchTimeoutMs = 15_000;
    private const long CacheBudget = 512L * 1024 * 1024;
    private readonly object _gate = new();
    private readonly object _cacheGate = new();
    private readonly Dictionary<string, Job> _jobs = [];
    private readonly List<Waiter> _queue = [];
    private int _active;
    private bool _disposed;

    private sealed class Job
    {
        public CancellationTokenSource Cancellation { get; } = new();
        public Dictionary<Guid, (string Name, CancellationTokenSource Cancellation)> Consumers { get; } = [];
        public Task<SubtitleOutcome> Work { get; set; } = null!;
    }

    private sealed record Waiter(bool Prefetch, TaskCompletionSource<bool> Ready);

    internal string CacheDirectory => Path.Combine(configuration["TorrentFlow:DataDirectory"] ??
        Path.Combine(environment.ContentRootPath, "data"), ".sessions", "subtitles");

    private string CacheFile(string hash, string path, string track, double start) =>
        Path.Combine(CacheDirectory, Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(
            $"{(track.StartsWith("embedded:", StringComparison.Ordinal) ? "source-timestamps-v2\0" : "")}{hash}\0{path}\0{track}\0{start.ToString(CultureInfo.InvariantCulture)}"))) + ".vtt");

    public string? ReadCache(string hash, string path, string track, double start = 0)
    {
        lock (_cacheGate)
        {
            try
            {
                var file = CacheFile(hash, path, track, start);
                if (new FileInfo(file).Length > SubtitleRules.MaxBytes) return null;
                var text = File.ReadAllText(file, Encoding.UTF8);
                if (string.IsNullOrWhiteSpace(text)) return null;
                File.SetLastWriteTimeUtc(file, DateTime.UtcNow);
                return text;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
        }
    }

    public void WriteCache(string hash, string path, string track, string vtt, double start = 0)
    {
        lock (_cacheGate)
        {
            try
            {
                Directory.CreateDirectory(CacheDirectory);
                File.WriteAllText(CacheFile(hash, path, track, start), vtt, new UTF8Encoding(false));
                EvictCache();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* Derived cache is best effort. */ }
        }
    }

    internal int EvictCache(long budget = CacheBudget)
    {
        lock (_cacheGate)
        {
            try
            {
                var files = new DirectoryInfo(CacheDirectory).GetFiles("*.vtt").OrderBy(f => f.LastWriteTimeUtc).ToArray();
                var total = files.Sum(f => f.Length);
                var removed = 0;
                foreach (var file in files)
                {
                    if (total <= budget) break;
                    lock (_gate) { if (_jobs.ContainsKey(file.FullName)) continue; }
                    try { var length = file.Length; file.Delete(); total -= length; removed++; }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                }
                return removed;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return 0; }
        }
    }

    public bool Cancel(string hash, string path, int index, double start, string consumer)
    {
        lock (_gate)
        {
            if (!_jobs.TryGetValue(CacheFile(hash, path, $"embedded:{index}", start), out var job)) return false;
            var matches = job.Consumers.Values.Where(c => c.Name == consumer).ToArray();
            foreach (var match in matches) match.Cancellation.Cancel();
            return matches.Length > 0;
        }
    }

    public async Task<SubtitleOutcome> ExtractAsync(ITorrentEngine engine, string hash, string path, int index,
        double start, string? consumer, bool prefetch, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return SubtitleOutcome.Aborted();
        var track = $"embedded:{index}";
        var cached = ReadCache(hash, path, track, start);
        if (cached is not null) return new(cached);
        var key = CacheFile(hash, path, track, start);
        var id = Guid.NewGuid();
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Job job;
        lock (_gate)
        {
            if (_disposed) return SubtitleOutcome.Aborted();
            if (!_jobs.TryGetValue(key, out job!))
            {
                job = new();
                _jobs[key] = job;
                var captured = job;
                job.Work = Task.Run(async () =>
                {
                    try
                    {
                        var outcome = await WithSlotAsync(prefetch, captured.Cancellation.Token, async token =>
                        {
                            var timeout = prefetch ? PrefetchTimeoutMs : ExtractTimeoutMs;
                            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
                            deadline.CancelAfter(timeout);
                            try
                            {
                                // Resolve before opening any engine stream when the tool is absent.
                                var binary = ResolveBinary("ffmpeg");
                                await using var source = await SubtitleStreamSource.OpenAsync(engine, hash, path, deadline.Token);
                                var result = await RunAsync(binary, BuildExtractArgs(source.Url, index, start), timeout, true, deadline.Token);
                                return deadline.IsCancellationRequested && !token.IsCancellationRequested
                                    ? new(null, "timeout", $"subtitle extraction exceeded {timeout / 1000}s") : result;
                            }
                            catch (OperationCanceledException) when (!token.IsCancellationRequested)
                            {
                                return new(null, "timeout", $"subtitle extraction exceeded {timeout / 1000}s");
                            }
                        });
                        if (outcome.Ok)
                        {
                            // Subtitle demuxer seeks may return preroll without rebasing it.
                            // ffmpeg preserves source timestamps; we drop expired cues and
                            // convert to window time exactly once, before caching.
                            var vtt = SubtitleRules.ShiftVttCues(outcome.Vtt!, -start);
                            outcome = outcome with { Vtt = vtt.Contains("-->", StringComparison.Ordinal) ? vtt : "WEBVTT\n\n" };
                            WriteCache(hash, path, track, outcome.Vtt!, start);
                        }
                        return outcome;
                    }
                    finally
                    {
                        lock (_gate) { if (_jobs.GetValueOrDefault(key) == captured) _jobs.Remove(key); }
                        captured.Cancellation.Dispose();
                    }
                }, CancellationToken.None);
            }
            job.Consumers[id] = (consumer ?? "anonymous", cancellation);
        }
        try { return await job.Work.WaitAsync(cancellation.Token); }
        catch (OperationCanceledException) { return SubtitleOutcome.Aborted(); }
        finally
        {
            lock (_gate)
            {
                job.Consumers.Remove(id);
                if (job.Consumers.Count == 0 && !job.Work.IsCompleted && _jobs.GetValueOrDefault(key) == job)
                    job.Cancellation.Cancel();
            }
        }
    }

    internal async Task<SubtitleOutcome> WithSlotAsync(bool prefetch, CancellationToken ct, Func<CancellationToken, Task<SubtitleOutcome>> work)
    {
        Waiter? waiter = null;
        lock (_gate)
        {
            if (_disposed || ct.IsCancellationRequested) return SubtitleOutcome.Aborted();
            if (_active < 2) _active++;
            else
            {
                if (_queue.Count >= 16) return new(null, "failed", "subtitle extraction queue is full");
                waiter = new(prefetch, new(TaskCreationOptions.RunContinuationsAsynchronously));
                var at = prefetch ? -1 : _queue.FindIndex(w => w.Prefetch);
                if (at < 0) _queue.Add(waiter); else _queue.Insert(at, waiter);
            }
        }
        if (waiter is not null)
        {
            try { await waiter.Ready.Task.WaitAsync(ct); }
            catch (OperationCanceledException)
            {
                lock (_gate)
                {
                    if (!_queue.Remove(waiter)) ReleaseSlot();
                }
                return SubtitleOutcome.Aborted();
            }
        }
        try { return await work(ct); }
        catch (OperationCanceledException) { return SubtitleOutcome.Aborted(); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or System.ComponentModel.Win32Exception or UnauthorizedAccessException)
        { return new(null, "failed", ex.Message); }
        finally { lock (_gate) ReleaseSlot(); }
    }

    private void ReleaseSlot()
    {
        if (_queue.Count == 0) _active--;
        else { var next = _queue[0]; _queue.RemoveAt(0); next.Ready.TrySetResult(true); }
    }

    public async Task<SubtitleOutcome> ConvertAsync(byte[] bytes, string extension, CancellationToken ct)
    {
        var ext = extension.TrimStart('.').ToLowerInvariant();
        var text = SubtitleRules.Decode(bytes);
        if (ext == "vtt" || SubtitleRules.IsWebVtt(text)) return new(text);
        if (ext == "srt") return new(SubtitleRules.SrtToVtt(text));
        if (ext is not ("ass" or "ssa")) return new(null, "failed", $"unsupported sidecar type .{ext}");
        return await WithSlotAsync(false, ct, async token =>
        {
            var binary = ResolveBinary("ffmpeg");
            Directory.CreateDirectory(CacheDirectory);
            var scratch = Path.Combine(CacheDirectory, $"in-{Guid.NewGuid():N}.{ext}");
            try
            {
                await File.WriteAllBytesAsync(scratch, bytes, token);
                return await RunAsync(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", ext, "-i", scratch,
                    "-c:s", "webvtt", "-f", "webvtt", "-"], 30_000, false, token);
            }
            finally { File.Delete(scratch); }
        });
    }

    internal static string[] BuildExtractArgs(string source, int index, double start = 0) =>
    [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-copyts",
        "-rw_timeout", "15000000", "-analyzeduration", "5000000", "-probesize", "10000000",
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5",
        .. start > 0 ? new[] { "-ss", start.ToString(CultureInfo.InvariantCulture) } : [],
        "-i", source, "-to", (start + SubtitleRules.WindowDuration).ToString(CultureInfo.InvariantCulture),
        "-map", $"0:{index}", "-c:s", "webvtt", "-f", "webvtt", "-"
    ];

    public async Task<(List<SubtitleStream>? Streams, string? Error)> ProbeAsync(
        ITorrentEngine engine, string hash, string path, CancellationToken ct)
    {
        var result = await WithSlotAsync(false, ct, async token =>
        {
            var binary = ResolveBinary("ffprobe");
            await using var source = await SubtitleStreamSource.OpenAsync(engine, hash, path, token);
            return await RunAsync(binary, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams",
                "-analyzeduration", "5000000", "-probesize", "10000000", "-rw_timeout", "30000000", source.Url],
                30_000, true, token, rawOutput: true);
        });
        if (!result.Ok) return (null, result.Error == "timeout" ? "timeout" : "probe_failed");
        return ParseProbeStreams(result.Vtt!);
    }

    internal static (List<SubtitleStream>? Streams, string? Error) ParseProbeStreams(string output)
    {
        try
        {
            using var doc = JsonDocument.Parse(output);
            var streams = new List<SubtitleStream>();
            if (!doc.RootElement.TryGetProperty("streams", out var array) || array.ValueKind == JsonValueKind.Null ||
                (array.ValueKind == JsonValueKind.Array && array.GetArrayLength() == 0)) return (null, "no_streams");
            foreach (var s in array.EnumerateArray())
            {
                string? Text(JsonElement e, string key) => e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                var tags = s.TryGetProperty("tags", out var t) ? t : default;
                var disposition = s.TryGetProperty("disposition", out var d) ? d : default;
                string? Tag(string key) => tags.ValueKind == JsonValueKind.Object ? Text(tags, key) ?? Text(tags, key.ToUpperInvariant()) : null;
                streams.Add(new(s.TryGetProperty("index", out var index) && index.ValueKind == JsonValueKind.Number ? index.GetInt32() : streams.Count,
                    (Text(s, "codec_type") ?? "data").ToLowerInvariant(), (Text(s, "codec_name") ?? "unknown").ToLowerInvariant(),
                    Tag("language"), Tag("title"),
                    s.TryGetProperty("channels", out var channels) && channels.ValueKind == JsonValueKind.Number ? channels.GetInt32() : null,
                    disposition.ValueKind == JsonValueKind.Object && disposition.TryGetProperty("default", out var flag) &&
                    (flag.ValueKind == JsonValueKind.True || flag.ToString() == "1")));
            }
            return (streams, null);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException) { return (null, "probe_failed"); }
    }

    private static async Task<SubtitleOutcome> RunAsync(string binary, IEnumerable<string> args, int timeoutMs,
        bool allowEmpty, CancellationToken ct, bool rawOutput = false)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(timeoutMs);
        using var process = new Process { StartInfo = new(binary)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        } };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        using var kill = timeout.Token.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
        });
        var stderr = ReadTailAsync(process.StandardError, timeout.Token);
        using var output = new MemoryStream();
        var exceeded = false;
        try
        {
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var count = await process.StandardOutput.BaseStream.ReadAsync(buffer, timeout.Token);
                if (count == 0) break;
                if (output.Length + count > (rawOutput ? 4 * 1024 * 1024 : SubtitleRules.MaxBytes))
                {
                    exceeded = true;
                    timeout.Cancel();
                    break;
                }
                output.Write(buffer, 0, count);
            }
            await process.WaitForExitAsync(timeout.Token);
            var error = await stderr;
            timeout.Token.ThrowIfCancellationRequested();
            var text = Encoding.UTF8.GetString(output.ToArray());
            if (process.ExitCode == 0)
            {
                if (rawOutput || text.Contains("-->", StringComparison.Ordinal)) return new(text);
                if (allowEmpty) return new(string.IsNullOrWhiteSpace(text) ? "WEBVTT\n\n" : text);
                return new(null, "empty", "the track produced no cues");
            }
            return new(null, "failed", string.IsNullOrWhiteSpace(error) ? $"ffmpeg exited with {process.ExitCode}"
                : string.Join(" | ", error.Trim().Split('\n').TakeLast(2)));
        }
        catch (OperationCanceledException)
        {
            if (exceeded) return new(null, "failed", "subtitle stream exceeded the size cap");
            return ct.IsCancellationRequested ? SubtitleOutcome.Aborted()
                : new(null, "timeout", $"subtitle extraction exceeded {timeoutMs / 1000}s");
        }
        finally
        {
            timeout.Cancel();
            await process.WaitForExitAsync(CancellationToken.None);
            try { await stderr; } catch (OperationCanceledException) { }
        }
    }

    private static async Task<string> ReadTailAsync(StreamReader reader, CancellationToken ct)
    {
        var tail = "";
        var buffer = new char[2048];
        while (true)
        {
            var count = await reader.ReadAsync(buffer, ct);
            if (count == 0) return tail;
            tail += new string(buffer, 0, count);
            if (tail.Length > 4096) tail = tail[^4096..];
        }
    }

    // Feature-local until the shared Media/Tools/FfmpegLocator is merged.
    internal string ResolveBinary(string binary)
    {
        var setting = binary == "ffmpeg" ? "FfmpegPath" : "FfprobePath";
        var configured = configuration[$"TorrentFlow:Media:{setting}"] ?? Environment.GetEnvironmentVariable(binary.ToUpperInvariant() + "_PATH");
        if (!string.IsNullOrWhiteSpace(configured))
            return File.Exists(configured) ? configured : throw new IOException($"{binary.ToUpperInvariant()}_PATH=\"{configured}\" does not exist on disk");
        var name = binary + (OperatingSystem.IsWindows() ? ".exe" : "");
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var candidate = Path.Combine(directory.Trim('"'), name);
            if (File.Exists(candidate)) return candidate;
        }
        for (var root = new DirectoryInfo(environment.ContentRootPath); root is not null; root = root.Parent)
        {
            var candidate = binary == "ffmpeg" ? Path.Combine(root.FullName, "node_modules", "ffmpeg-static", name)
                : Path.Combine(root.FullName, "node_modules", "ffprobe-static", "bin",
                    OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux",
                    System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new IOException($"{binary} is unavailable — configure TorrentFlow:Media:{setting}, {binary.ToUpperInvariant()}_PATH, or install {binary}-static.");
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
            foreach (var job in _jobs.Values) job.Cancellation.Cancel();
            foreach (var waiter in _queue) waiter.Ready.TrySetCanceled();
            _queue.Clear();
        }
    }
}
