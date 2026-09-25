using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Subtitles;

public sealed record SubtitleOutcome(bool Ok, string? Vtt, string? Error, string? Message)
{
    public static SubtitleOutcome Success(string vtt) => new(true, vtt, null, null);
    public static SubtitleOutcome Fail(string error, string message) => new(false, null, error, message);
}

/// <summary>
/// Port of src/lib/media/extract-subtitles.ts: embedded-track extraction via ffmpeg with a 2-active/16-queued
/// scheduler (foreground jumps ahead of prefetch), shared in-flight jobs with per-consumer cancellation, a
/// SHA-1 keyed WebVTT disk cache with a 512 MiB LRU budget, and ASS/SSA sidecar conversion.
/// </summary>
public sealed class SubtitleExtractor(MediaPaths paths, FfmpegLocator binaries, IProcessRunner runner, ILogger<SubtitleExtractor> logger)
{
    public const int MaxSubtitleBytes = 8 * 1024 * 1024;
    public const int ExtractTimeoutMs = 45_000;
    public const int PrefetchExtractTimeoutMs = 15_000;
    public const int SidecarTimeoutMs = 30_000;
    public const long CacheBudgetBytes = 512L * 1024 * 1024;
    public const int MaxConcurrentJobs = 2;
    public const int MaxQueuedJobs = 16;

    private readonly object _gate = new();
    private readonly Dictionary<string, InFlight> _inFlight = new(StringComparer.Ordinal);
    private readonly LinkedList<QueuedJob> _queue = new();
    private int _active;

    internal long Budget { get; set; } = CacheBudgetBytes;

    public string CacheDir => paths.SubtitlesDir;

    public static IReadOnlyList<string> InputArgs() =>
        ["-rw_timeout", "15000000", "-analyzeduration", "5000000", "-probesize", "10000000",
         "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5"];

    public static List<string> BuildExtractArgs(string sourceUrl, int streamIndex, double windowStartSec = 0)
    {
        var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin" };
        args.AddRange(InputArgs());
        if (windowStartSec > 0) args.AddRange(["-ss", windowStartSec.ToString(System.Globalization.CultureInfo.InvariantCulture)]);
        args.AddRange(["-i", sourceUrl, "-t", SubtitleText.WindowDurationSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "-map", $"0:{streamIndex}", "-c:s", "webvtt", "-f", "webvtt", "-"]);
        return args;
    }

    public string CachePath(string infoHash, string filePath, string trackId, double windowStartSec)
    {
        var key = $"{infoHash}\0{filePath}\0{trackId}\0{windowStartSec.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
        return Path.Combine(CacheDir, Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(key))) + ".vtt");
    }

    public string? ReadCached(string infoHash, string filePath, string trackId, double windowStartSec)
    {
        var path = CachePath(infoHash, filePath, trackId, windowStartSec);
        try
        {
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path, Encoding.UTF8);
            if (text.Trim().Length == 0) return null;
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            return text;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    public void CacheSidecar(string infoHash, string filePath, string trackId, string vtt) => WriteCache(CachePath(infoHash, filePath, trackId, 0), vtt);

    private void WriteCache(string path, string vtt)
    {
        try
        {
            Directory.CreateDirectory(CacheDir);
            File.WriteAllText(path, vtt, new UTF8Encoding(false));
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            EvictOverBudget();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    public int EvictOverBudget()
    {
        if (!Directory.Exists(CacheDir)) return 0;
        var files = new DirectoryInfo(CacheDir).EnumerateFiles("*.vtt").Select(f => (f.FullName, f.Name, f.Length, Used: f.LastWriteTimeUtc)).ToList();
        var total = files.Sum(f => f.Length);
        if (total <= Budget) return 0;
        HashSet<string> busy;
        lock (_gate) busy = [.. _inFlight.Keys];
        var removed = 0;
        foreach (var f in files.OrderBy(f => f.Used))
        {
            if (total <= Budget) break;
            if (busy.Contains(f.FullName)) continue;
            try
            {
                File.Delete(f.FullName);
                total -= f.Length;
                removed++;
                logger.LogInformation("[subtitles] evicted {Name} ({Size})", f.Name, FormatBytesShort(f.Length));
            }
            catch (IOException) { }
        }
        return removed;
    }

    internal static string FormatBytesShort(long bytes) =>
        bytes >= 1024 * 1024 ? $"{bytes / 1024d / 1024:0.0} MB" : bytes >= 1024 ? $"{bytes / 1024d:0} KB" : $"{bytes} B";

    public async Task<SubtitleOutcome> ExtractEmbeddedAsync(
        string infoHash, string filePath, int streamIndex, string sourceUrl, double windowStartSec,
        string? consumerId, bool prefetch, int? timeoutMs, CancellationToken requestAborted)
    {
        if (requestAborted.IsCancellationRequested) return SubtitleOutcome.Fail("aborted", "subtitle extraction was canceled");
        var trackId = $"embedded:{streamIndex}";
        var cached = ReadCached(infoHash, filePath, trackId, windowStartSec);
        if (cached is not null) return SubtitleOutcome.Success(cached);
        var key = CachePath(infoHash, filePath, trackId, windowStartSec);
        var consumer = string.IsNullOrWhiteSpace(consumerId) ? "anonymous" : consumerId.Trim();
        InFlight job;
        var ticket = new object();
        lock (_gate)
        {
            if (!_inFlight.TryGetValue(key, out job!))
            {
                job = new InFlight(infoHash, filePath, streamIndex, windowStartSec);
                _inFlight[key] = job;
                var effectiveTimeout = timeoutMs ?? ExtractTimeoutMs;
                job.Task = RunJobAsync(job, key, sourceUrl, prefetch, effectiveTimeout);
            }
            job.Attach(consumer, ticket);
        }
        using var reg = requestAborted.Register(() => Detach(key, job, consumer, ticket));
        var outcome = await job.Task;
        Detach(key, job, consumer, ticket);
        return requestAborted.IsCancellationRequested && !outcome.Ok ? SubtitleOutcome.Fail("aborted", "subtitle extraction was canceled") : outcome;
    }

    /// <summary>Detaches every request of one consumer from the shared job; false when nothing matched.</summary>
    public bool CancelEmbedded(string infoHash, string filePath, int streamIndex, double windowStartSec, string consumerId)
    {
        var key = CachePath(infoHash, filePath, $"embedded:{streamIndex}", windowStartSec);
        lock (_gate)
        {
            if (!_inFlight.TryGetValue(key, out var job) || !job.Consumers.Remove(consumerId)) return false;
            if (job.Consumers.Count == 0 && !job.Settled) job.Cancel.Cancel();
            return true;
        }
    }

    private void Detach(string key, InFlight job, string consumer, object ticket)
    {
        lock (_gate)
        {
            if (!job.Consumers.TryGetValue(consumer, out var tickets)) return;
            tickets.Remove(ticket);
            if (tickets.Count == 0) job.Consumers.Remove(consumer);
            if (job.Consumers.Count == 0 && !job.Settled) job.Cancel.Cancel();
            _ = key;
        }
    }

    private async Task<SubtitleOutcome> RunJobAsync(InFlight job, string key, string sourceUrl, bool prefetch, int timeoutMs)
    {
        await Task.Yield();
        try
        {
            var slot = Acquire(prefetch, job.Cancel.Token);
            if (slot is null) return SubtitleOutcome.Fail("failed", "subtitle extraction queue is full");
            try { await slot; }
            catch (OperationCanceledException) { return SubtitleOutcome.Fail("aborted", "subtitle extraction was canceled"); }
            try
            {
                string ffmpeg;
                try { ffmpeg = binaries.ResolveFfmpeg(); }
                catch (FfmpegBinaryMissingException ex) { return SubtitleOutcome.Fail("failed", ex.Message); }
                var outcome = await RunFfmpegAsync(ffmpeg, BuildExtractArgs(sourceUrl, job.StreamIndex, job.WindowStartSec), timeoutMs, allowEmpty: true, job.Cancel.Token);
                if (outcome.Ok) WriteCache(key, outcome.Vtt!);
                return outcome;
            }
            finally { Release(); }
        }
        finally
        {
            lock (_gate)
            {
                job.Settled = true;
                if (_inFlight.TryGetValue(key, out var current) && current == job) _inFlight.Remove(key);
            }
        }
    }

    private Task? Acquire(bool prefetch, CancellationToken ct)
    {
        lock (_gate)
        {
            if (_active < MaxConcurrentJobs) { _active++; return Task.CompletedTask; }
            if (_queue.Count >= MaxQueuedJobs) return null;
            var queued = new QueuedJob(prefetch, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously), ct);
            if (!prefetch)
            {
                var firstPrefetch = _queue.First;
                while (firstPrefetch is not null && !firstPrefetch.Value.Prefetch) firstPrefetch = firstPrefetch.Next;
                if (firstPrefetch is not null) _queue.AddBefore(firstPrefetch, queued); else _queue.AddLast(queued);
            }
            else _queue.AddLast(queued);
            ct.Register(() => { lock (_gate) { if (_queue.Remove(queued)) queued.Signal.TrySetCanceled(ct); } });
            return queued.Signal.Task;
        }
    }

    private void Release()
    {
        lock (_gate)
        {
            while (_queue.First is { } next)
            {
                _queue.RemoveFirst();
                if (next.Value.Token.IsCancellationRequested) continue;
                next.Value.Signal.TrySetResult();
                return;
            }
            _active--;
        }
    }

    internal int ActiveJobs { get { lock (_gate) return _active; } }
    internal int QueuedJobs { get { lock (_gate) return _queue.Count; } }

    /// <summary>Converts sidecar bytes: VTT passes through, SRT is rewritten, ASS/SSA go through ffmpeg.</summary>
    public async Task<SubtitleOutcome> ConvertSidecarAsync(byte[] bytes, string extension, CancellationToken ct, int timeoutMs = SidecarTimeoutMs)
    {
        var ext = extension.TrimStart('.').ToLowerInvariant();
        var text = Encoding.UTF8.GetString(bytes);
        if (ext == "vtt" || SubtitleText.IsWebVtt(text)) return SubtitleOutcome.Success(text);
        if (ext == "srt") return SubtitleOutcome.Success(SubtitleText.SrtToVtt(text));
        if (ext is not ("ass" or "ssa")) return SubtitleOutcome.Fail("failed", $"unsupported sidecar type .{ext}");
        string ffmpeg;
        try { ffmpeg = binaries.ResolveFfmpeg(); }
        catch (FfmpegBinaryMissingException ex) { return SubtitleOutcome.Fail("failed", ex.Message); }
        Directory.CreateDirectory(CacheDir);
        var scratch = Path.Combine(CacheDir, $"in-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6))}.{ext}");
        try
        {
            await File.WriteAllBytesAsync(scratch, bytes, ct);
            return await RunFfmpegAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", ext, "-i", scratch, "-c:s", "webvtt", "-f", "webvtt", "-"], timeoutMs, allowEmpty: false, ct);
        }
        finally
        {
            try { File.Delete(scratch); } catch (IOException) { }
        }
    }

    private async Task<SubtitleOutcome> RunFfmpegAsync(string ffmpeg, IReadOnlyList<string> args, int timeoutMs, bool allowEmpty, CancellationToken ct)
    {
        var result = await ProcessRuns.RunAsync(runner, ffmpeg, args, TimeSpan.FromMilliseconds(timeoutMs), MaxSubtitleBytes, ct);
        switch (result.Failure)
        {
            case "aborted": return SubtitleOutcome.Fail("aborted", "subtitle extraction was canceled");
            case "timeout": return SubtitleOutcome.Fail("timeout", $"subtitle extraction exceeded {Math.Round(timeoutMs / 1000d)}s");
            case "oversize": return SubtitleOutcome.Fail("failed", "subtitle stream exceeded the size cap");
            case "spawn": return SubtitleOutcome.Fail("failed", result.Stderr.Length > 0 ? result.Stderr : "ffmpeg could not be started");
        }
        var vtt = Encoding.UTF8.GetString(result.Stdout);
        if (result.ExitCode == 0 && vtt.Contains("-->", StringComparison.Ordinal)) return SubtitleOutcome.Success(vtt);
        if (result.ExitCode == 0 && allowEmpty) return SubtitleOutcome.Success(vtt.Trim().Length > 0 ? vtt : "WEBVTT\n\n");
        if (result.ExitCode == 0) return SubtitleOutcome.Fail("empty", "the track produced no cues");
        var lines = result.Stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return SubtitleOutcome.Fail("failed", lines.Length > 0 ? string.Join(" | ", lines.TakeLast(2)) : $"ffmpeg exited with {result.ExitCode}");
    }

    private sealed class InFlight(string infoHash, string filePath, int streamIndex, double windowStartSec)
    {
        public string InfoHash { get; } = infoHash;
        public string FilePath { get; } = filePath;
        public int StreamIndex { get; } = streamIndex;
        public double WindowStartSec { get; } = windowStartSec;
        public CancellationTokenSource Cancel { get; } = new();
        public Dictionary<string, HashSet<object>> Consumers { get; } = new(StringComparer.Ordinal);
        public Task<SubtitleOutcome> Task { get; set; } = null!;
        public bool Settled { get; set; }

        public void Attach(string consumer, object ticket)
        {
            if (!Consumers.TryGetValue(consumer, out var set)) Consumers[consumer] = set = [];
            set.Add(ticket);
        }
    }

    private sealed record QueuedJob(bool Prefetch, TaskCompletionSource Signal, CancellationToken Token);
}
