using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Prewarm;
using TorrentFlow.Media.Subtitles;

namespace TorrentFlow.Media.Streaming;

/// <summary>
/// Port of /api/stream/[infoHash] and /api/stream/[infoHash]/[...filePath]. Live bytes come from
/// <see cref="ITorrentEngine.OpenFileStreamAsync"/>; completed, verified files are served straight from disk.
/// </summary>
public sealed class StreamService(
    ITorrentEngine engine,
    MediaSettings settings,
    CompletedMedia completed,
    ForegroundTracker foreground,
    TimeProvider clock,
    ILogger<StreamService> logger)
{
    public const int MaxDownloadedRangesPerFile = 64;
    public const int MaxSubtitleBytes = 4 * 1024 * 1024;
    public const long ForegroundKeepaliveMs = 5_000;
    private const string NoCache = "no-cache, no-store, must-revalidate, max-age=0";

    /// <summary>Default zero-byte stall window; overridable for tests.</summary>
    public long StallWindowMs { get; set; } = 15_000;

    public async Task<IActionResult> IndexAsync(string rawHash, bool quiet, string? downloadedRangesFor, (int Season, int Episode)? target, CancellationToken ct)
    {
        var infoHash = InfoHashes.Normalize(rawHash);
        if (infoHash is null)
        {
            if (!quiet) Log(rawHash, null, null, null, "not_found");
            return MediaJson.Error(404, new { error = "Torrent not found" });
        }
        var config = await settings.GetAsync(ct);
        var manifest = await completed.GetManifestAsync(infoHash, ct);
        if (manifest is not null)
        {
            var targetIdx = target is { } t ? IndexOfEpisode(manifest.Select(f => f.RelativePath).ToList(), t) : -1;
            int? targetVideoIndex = targetIdx >= 0 ? targetIdx : null;
            var primary = targetVideoIndex ?? MediaFiles.SelectMainFeatureFile(manifest.Select(f => (f.RelativePath, f.Length)).ToList());
            var rangesFor = downloadedRangesFor is null ? null : ManifestPath(downloadedRangesFor);
            return new OkObjectResult(new Dictionary<string, object?>
            {
                ["files"] = manifest.Select((f, i) => FileEntry(f.RelativePath, f.Length, i,
                    rangesFor is null || rangesFor == f.RelativePath ? [new ByteRangeDto(0, f.Length)] : null)).ToList(),
                ["primaryVideoIndex"] = primary,
                ["targetVideoIndex"] = targetVideoIndex,
                ["clientType"] = "builtin",
                ["swarm"] = new Dictionary<string, object?> { ["peers"] = 0, ["downloadSpeedBps"] = 0, ["progress"] = 1, ["observedAt"] = Now },
            });
        }
        if (!config.IsBuiltin)
        {
            if (!quiet) Log(infoHash, null, null, null, "non_builtin");
            return MediaJson.Error(409, new
            {
                error = "Streaming requires the built-in client",
                message = "This title is not available as completed local media. Switch Settings \u2192 Built-in to stream an active torrent.",
                clientType = config.ClientType,
            });
        }
        var info = await LookupLiveAsync(infoHash, ct);
        if (info is null)
        {
            if (!quiet) Log(infoHash, null, null, null, "not_found");
            return MediaJson.Error(404, new { error = "Torrent not found" });
        }
        if (MetadataPending(info))
        {
            if (!quiet) Log(infoHash, null, null, info, "metadata_pending");
            return MediaJson.Error(425, new Dictionary<string, object?>
            {
                ["error"] = "Torrent metadata is not ready yet",
                ["message"] = "The torrent is still fetching metadata; try again in a moment.",
                ["swarm"] = Swarm(info),
            });
        }
        if (!quiet) Log(infoHash, null, null, info, "ok");
        var wanted = string.IsNullOrEmpty(downloadedRangesFor) ? null : ManifestPath(downloadedRangesFor);
        var files = info.Files!.Where(f => MediaFiles.IsMediaAsset(f.Path)).ToList();
        var paths = files.Select(f => ManifestPath(f.Path)).ToList();
        var ti = target is { } tt ? IndexOfEpisode(paths, tt) : -1;
        int? targetVideo = ti >= 0 ? ti : null;
        var primaryVideo = targetVideo ?? MediaFiles.SelectMainFeatureFile(files.Select(f => (f.Path, f.Length)).ToList());
        var entries = new List<Dictionary<string, object?>>();
        for (var i = 0; i < files.Count; i++)
        {
            IReadOnlyList<ByteRangeDto>? ranges = null;
            if (wanted is null || wanted == paths[i])
                ranges = CapRanges((await engine.GetDownloadedRangesAsync(infoHash, files[i].Index, ct)).Select(r => new ByteRangeDto(r.Start, r.End)).ToList());
            entries.Add(FileEntry(paths[i], files[i].Length, i, ranges));
        }
        return new OkObjectResult(new Dictionary<string, object?>
        {
            ["files"] = entries,
            ["primaryVideoIndex"] = primaryVideo,
            ["targetVideoIndex"] = targetVideo,
            ["clientType"] = "builtin",
            ["swarm"] = Swarm(info),
        });
    }

    private static Dictionary<string, object?> FileEntry(string path, long length, int index, IReadOnlyList<ByteRangeDto>? ranges)
    {
        var d = new Dictionary<string, object?> { ["path"] = path, ["length"] = length, ["index"] = index };
        if (ranges is not null) d["downloadedRanges"] = ranges;
        return d;
    }

    private static int IndexOfEpisode(IReadOnlyList<string> paths, (int Season, int Episode) t)
    {
        for (var i = 0; i < paths.Count; i++)
        {
            if (!MediaFiles.IsVideo(paths[i])) continue;
            var p = Episodes.Parse(paths[i]);
            if (p.Season == t.Season && p.Episode == t.Episode) return i;
        }
        return -1;
    }

    internal static bool MetadataPending(EngineTorrentInfo info) => info.State == "metaDL" || info.Files is not { Count: > 0 };

    /// <summary>Like the TS findBuiltinTorrentFile: a known torrent that is not live in the engine (e.g. after a restart) is started so it can be served.</summary>
    private async Task<EngineTorrentInfo?> LookupLiveAsync(string infoHash, CancellationToken ct)
    {
        var info = await engine.GetAsync(infoHash, ct);
        if (info is null || !MetadataPending(info) || info.State == "metaDL" || info.Progress >= 1) return info;
        try { await engine.ResumeAsync(infoHash, ct); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException) { return info; }
        return await engine.GetAsync(infoHash, ct) ?? info;
    }

    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();

    private Dictionary<string, object?> Swarm(EngineTorrentInfo info) => new()
    {
        ["peers"] = info.Peers,
        ["downloadSpeedBps"] = info.Dlspeed >= 0 ? info.Dlspeed : null,
        ["progress"] = double.IsFinite(info.Progress) ? Math.Clamp(info.Progress, 0, 1) : null,
        ["observedAt"] = Now,
    };

    public static string ManifestPath(string p) => p.Replace('\\', '/');

    internal static List<ByteRangeDto> CapRanges(List<ByteRangeDto> ranges)
    {
        if (ranges.Count <= MaxDownloadedRangesPerFile) return ranges;
        var capped = ranges.ToList();
        while (capped.Count > MaxDownloadedRangesPerFile)
        {
            var mergeAt = 1;
            var smallest = long.MaxValue;
            for (var i = 1; i < capped.Count; i++)
            {
                var gap = capped[i].Start - capped[i - 1].End;
                if (gap < smallest) { smallest = gap; mergeAt = i; }
            }
            capped[mergeAt - 1] = new ByteRangeDto(capped[mergeAt - 1].Start, capped[mergeAt].End);
            capped.RemoveAt(mergeAt);
        }
        return capped;
    }

    internal static string? NormalizeFilePath(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var clean = new List<string>();
        foreach (var segment in raw.Split('/'))
        {
            if (segment is "" or "." or "..") return null;
            if (segment.Contains('\\') || segment.Contains("%2F", StringComparison.OrdinalIgnoreCase)) return null;
            clean.Add(segment);
        }
        return string.Join('/', clean);
    }

    private static bool IsSubtitlePath(string p) => p.EndsWith(".srt", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".vtt", StringComparison.OrdinalIgnoreCase);

    /// <summary>Writes the whole response for a file request (GET/HEAD).</summary>
    public async Task ServeFileAsync(HttpContext http, string rawHash, string? rawFilePath)
    {
        var request = http.Request;
        var response = http.Response;
        var ct = http.RequestAborted;
        var rangeHeader = request.Headers.Range.Count > 0 ? request.Headers.Range.ToString() : null;
        var isHead = HttpMethods.IsHead(request.Method);
        var infoHash = InfoHashes.Normalize(rawHash);
        var filePath = NormalizeFilePath(rawFilePath);
        if (infoHash is null || filePath is null || !MediaFiles.IsMediaAsset(filePath))
        {
            Log(rawHash, filePath, rangeHeader, null, "not_found");
            await WriteJson(response, 404, new { error = "Torrent file not found" }, ct);
            return;
        }
        var config = await settings.GetAsync(ct);

        var persisted = await completed.ResolveAsync(infoHash, filePath, ct);
        if (persisted is not null && CompletedMedia.DiskLength(persisted.AbsolutePath, persisted.Length, persisted.MtimeMs) is { } diskLength)
        {
            if (IsSubtitlePath(filePath) && diskLength <= MaxSubtitleBytes)
            {
                try
                {
                    var raw = await File.ReadAllTextAsync(persisted.AbsolutePath, Encoding.UTF8, ct);
                    var bytes = Encoding.UTF8.GetBytes(SubtitleText.IsWebVtt(raw) ? raw : SubtitleText.SrtToVtt(raw));
                    response.StatusCode = 200;
                    response.ContentType = "text/vtt; charset=utf-8";
                    response.ContentLength = bytes.Length;
                    response.Headers.CacheControl = NoCache;
                    response.Headers.AcceptRanges = "none";
                    response.Headers["X-TorrentFlow-Stream-Source"] = "disk-fastpath";
                    Log(infoHash, filePath, rangeHeader, null, "subtitle_disk_fastpath");
                    if (!isHead) await response.Body.WriteAsync(bytes, ct);
                    return;
                }
                catch (IOException) { }
            }
            if (!IsSubtitlePath(filePath))
            {
                var range = HttpRanges.ParseStreamRange(rangeHeader, diskLength);
                if (range is null)
                {
                    Log(infoHash, filePath, rangeHeader, null, "bad_range");
                    Write416(response, diskLength);
                    return;
                }
                SetHeaders(response, filePath, range);
                response.Headers["X-TorrentFlow-Stream-Source"] = "disk-fastpath";
                if (isHead)
                {
                    Log(infoHash, filePath, rangeHeader, null, range.Status == 206 ? "partial_head_disk_fastpath" : "head_disk_fastpath");
                    return;
                }
                FileStream? disk = null;
                try { disk = new FileStream(persisted.AbsolutePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, true); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                if (disk is not null)
                {
                    await using (disk)
                    {
                        foreground.MarkActive(infoHash);
                        Log(infoHash, filePath, rangeHeader, null, range.Status == 206 ? "partial_disk_fastpath" : "ok_disk_fastpath");
                        disk.Seek(range.Start, SeekOrigin.Begin);
                        await CopyWithKeepaliveAsync(http, disk, range.Length, infoHash, null);
                    }
                    return;
                }
                ResetHeaders(response);
            }
        }

        if (!config.IsBuiltin)
        {
            Log(infoHash, filePath, rangeHeader, null, "non_builtin");
            await WriteJson(response, 409, new
            {
                error = "Streaming requires the built-in client",
                message = "This file is not available as completed local media. Switch Settings \u2192 Built-in to stream an active torrent.",
                clientType = config.ClientType,
            }, ct);
            return;
        }

        var info = await LookupLiveAsync(infoHash, ct);
        if (info is null)
        {
            Log(infoHash, filePath, rangeHeader, null, "not_found");
            await WriteJson(response, 404, new { error = "Torrent file not found" }, ct);
            return;
        }
        if (MetadataPending(info))
        {
            Log(infoHash, filePath, rangeHeader, info, "metadata_pending");
            await WriteJson(response, 425, new
            {
                error = "Torrent metadata is not ready yet",
                message = "The torrent is still fetching metadata; try again in a moment.",
            }, ct);
            return;
        }
        var file = info.Files!.FirstOrDefault(f => ManifestPath(f.Path) == filePath)
            ?? info.Files!.FirstOrDefault(f => string.Equals(ManifestPath(f.Path), filePath, StringComparison.OrdinalIgnoreCase));
        if (file is null)
        {
            Log(infoHash, filePath, rangeHeader, info, "not_found");
            await WriteJson(response, 404, new { error = "Torrent file not found" }, ct);
            return;
        }

        if (IsSubtitlePath(filePath) && file.Length <= MaxSubtitleBytes)
        {
            var vtt = await ReadSubtitleAsync(infoHash, file, ct);
            if (vtt is not null)
            {
                if (!isHead) foreground.MarkActive(infoHash);
                Log(infoHash, filePath, rangeHeader, info, "subtitle");
                response.StatusCode = 200;
                response.ContentType = "text/vtt; charset=utf-8";
                response.ContentLength = vtt.Length;
                response.Headers.CacheControl = NoCache;
                response.Headers.AcceptRanges = "none";
                if (!isHead) await response.Body.WriteAsync(vtt, ct);
                return;
            }
        }

        var liveRange = HttpRanges.ParseStreamRange(rangeHeader, file.Length);
        if (liveRange is null)
        {
            Log(infoHash, filePath, rangeHeader, info, "bad_range");
            Write416(response, file.Length);
            return;
        }
        if (isHead)
        {
            SetHeaders(response, filePath, liveRange);
            Log(infoHash, filePath, rangeHeader, info, liveRange.Status == 206 ? "partial_head" : "head");
            return;
        }

        Stream source;
        try { source = await engine.OpenFileStreamAsync(infoHash, file.Index.ToString(System.Globalization.CultureInfo.InvariantCulture), ct); }
        catch (FileNotFoundException)
        {
            Log(infoHash, filePath, rangeHeader, info, "not_found");
            await WriteJson(response, 404, new { error = "Torrent file not found" }, ct);
            return;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
        catch (IOException ex)
        {
            var failure = PlaybackFailures.Classify(new PlaybackFailureSignals { StallReason = "stalled", PeerCount = info.Peers ?? 0, Error = ex });
            Log(infoHash, filePath, rangeHeader, info, "stalled");
            await WriteStall(response, failure, ct);
            return;
        }

        await using (source)
        {
            try { if (liveRange.Start > 0) source.Seek(liveRange.Start, SeekOrigin.Begin); }
            catch (Exception ex) when (ex is IOException or NotSupportedException)
            {
                await WriteJson(response, 503, new { error = "Stream stalled waiting for data", code = "ENGINE_ERROR", failureClass = "engine", retryable = false, message = ex.Message }, ct);
                return;
            }
            var buffer = new byte[(int)Math.Min(256 * 1024, Math.Max(1, liveRange.Length))];
            var first = await GuardedReadAsync(source, buffer.AsMemory(0, (int)Math.Min(buffer.Length, liveRange.Length)), infoHash, ct);
            if (first.Failure is not null)
            {
                Log(infoHash, filePath, rangeHeader, info, first.Failure == "aborted" ? "aborted" : "stalled");
                if (first.Failure == "aborted")
                {
                    if (!ct.IsCancellationRequested)
                        await WriteJson(response, 503, new { error = "Stream request aborted", code = "ABORTED", message = "The stream request was aborted before any bytes were available." }, ct);
                    return;
                }
                var failure = PlaybackFailures.Classify(new PlaybackFailureSignals { StallReason = "stalled", PeerCount = info.Peers ?? 0, Error = first.Error });
                await WriteStall(response, failure, ct);
                return;
            }
            foreground.MarkActive(infoHash);
            Log(infoHash, filePath, rangeHeader, info, liveRange.Status == 206 ? "partial" : "ok");
            SetHeaders(response, filePath, liveRange);
            var remaining = liveRange.Length;
            var lastMark = Now;
            try
            {
                var chunk = first.Count;
                while (remaining > 0 && chunk > 0)
                {
                    var n = (int)Math.Min(chunk, remaining);
                    await response.Body.WriteAsync(buffer.AsMemory(0, n), ct);
                    remaining -= n;
                    if (Now - lastMark >= ForegroundKeepaliveMs) { lastMark = Now; foreground.MarkActive(infoHash); }
                    if (remaining <= 0) break;
                    var next = await GuardedReadAsync(source, buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), infoHash, ct);
                    if (next.Failure is not null)
                    {
                        if (next.Failure == "stalled") Log(infoHash, filePath, rangeHeader, info, "stalled");
                        http.Abort();
                        return;
                    }
                    chunk = next.Count;
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            if (remaining > 0 && !ct.IsCancellationRequested) http.Abort();
        }
    }

    private async Task CopyWithKeepaliveAsync(HttpContext http, Stream source, long count, string infoHash, Action? onChunk)
    {
        var lastMark = Now;
        try
        {
            var copied = await StreamCopy.CopyExactlyAsync(source, http.Response.Body, count, _ =>
            {
                if (Now - lastMark >= ForegroundKeepaliveMs) { lastMark = Now; foreground.MarkActive(infoHash); }
                onChunk?.Invoke();
            }, http.RequestAborted);
            if (copied < count && !http.RequestAborted.IsCancellationRequested) http.Abort();
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }

    internal readonly record struct GuardedRead(int Count, string? Failure, Exception? Error);

    /// <summary>
    /// Port of readWithStallGuard: races one read against byte progress. A slow-but-moving swarm keeps the read
    /// alive; only a truly byte-stalled transfer (per <see cref="Stall.Evaluate"/>) fails it.
    /// </summary>
    internal async Task<GuardedRead> GuardedReadAsync(Stream source, Memory<byte> buffer, string infoHash, CancellationToken abort)
    {
        using var readCts = CancellationTokenSource.CreateLinkedTokenSource(abort);
        var readTask = source.ReadAsync(buffer, readCts.Token).AsTask();
        if (readTask.IsCompleted) return await Settle(readTask, abort);
        var samples = new List<TransferSample> { await SampleAsync(infoHash) };
        var interval = TimeSpan.FromMilliseconds(Math.Max(10, Math.Min(StallWindowMs / 3, 1000)));
        var options = Stall.StreamOptions(StallWindowMs);
        while (true)
        {
            var delay = Task.Delay(interval, clock, CancellationToken.None);
            var done = await Task.WhenAny(readTask, delay);
            if (done == readTask) return await Settle(readTask, abort);
            if (abort.IsCancellationRequested) { readCts.Cancel(); Observe(readTask); return new GuardedRead(0, "aborted", null); }
            samples.Add(await SampleAsync(infoHash));
            if (Stall.Evaluate(samples, options).Stalled)
            {
                readCts.Cancel();
                Observe(readTask);
                return new GuardedRead(0, "stalled", null);
            }
        }
    }

    private static void Observe(Task t) => t.ContinueWith(static x => _ = x.Exception, TaskScheduler.Default);

    private static async Task<GuardedRead> Settle(Task<int> read, CancellationToken abort)
    {
        try { return new GuardedRead(await read, null, null); }
        catch (OperationCanceledException) when (abort.IsCancellationRequested) { return new GuardedRead(0, "aborted", null); }
        catch (Exception ex) { return new GuardedRead(0, "stalled", ex); }
    }

    private async Task<TransferSample> SampleAsync(string infoHash)
    {
        var at = Now;
        try
        {
            var info = await engine.GetAsync(infoHash);
            if (info is null) return new TransferSample(at, 0, 0, "downloading");
            var progress = double.IsFinite(info.Progress) ? info.Progress : 0;
            var downloaded = info.BytesReceived ?? (info.SizeBytes > 0 ? (long)Math.Round(progress * info.SizeBytes) : 0);
            return new TransferSample(at, Math.Max(0, downloaded), progress, "downloading", info.Peers);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return new TransferSample(at, 0, 0, "downloading");
        }
    }

    private async Task<byte[]?> ReadSubtitleAsync(string infoHash, EngineFileInfo file, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(StallWindowMs));
            await using var s = await engine.OpenFileStreamAsync(infoHash, file.Index.ToString(System.Globalization.CultureInfo.InvariantCulture), timeout.Token);
            var ms = new MemoryStream();
            var copied = await StreamCopy.CopyExactlyAsync(s, ms, Math.Min(file.Length, MaxSubtitleBytes), null, timeout.Token);
            if (copied < file.Length) return null;
            var raw = Encoding.UTF8.GetString(ms.ToArray());
            return Encoding.UTF8.GetBytes(SubtitleText.IsWebVtt(raw) ? raw : SubtitleText.SrtToVtt(raw));
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or FileNotFoundException)
        {
            return null;
        }
    }

    private static void SetHeaders(HttpResponse response, string filePath, StreamRange range)
    {
        var name = filePath.Split('/')[^1];
        response.StatusCode = range.Status;
        response.Headers.AcceptRanges = "bytes";
        response.Headers.CacheControl = NoCache;
        response.ContentType = HttpRanges.ContentTypeForPath(filePath);
        response.ContentLength = range.Length;
        response.Headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(name.Length > 0 ? name : filePath)}";
        if (range.ContentRange is not null) response.Headers.ContentRange = range.ContentRange;
    }

    private static void ResetHeaders(HttpResponse response)
    {
        foreach (var h in new[] { "Accept-Ranges", "Cache-Control", "Content-Type", "Content-Length", "Content-Disposition", "Content-Range", "X-TorrentFlow-Stream-Source" })
            response.Headers.Remove(h);
        response.StatusCode = 200;
    }

    private static void Write416(HttpResponse response, long length)
    {
        response.StatusCode = 416;
        response.Headers.AcceptRanges = "bytes";
        response.Headers.ContentRange = $"bytes */{length}";
    }

    private static Task WriteStall(HttpResponse response, PlaybackFailure failure, CancellationToken ct) =>
        WriteJson(response, 503, new
        {
            error = "Stream stalled waiting for data",
            code = failure.Kind,
            failureClass = failure.FailureClass,
            retryable = failure.Retryable,
            message = failure.DefaultMessage,
        }, ct);

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static async Task WriteJson(HttpResponse response, int status, object body, CancellationToken ct)
    {
        if (response.HasStarted) return;
        response.StatusCode = status;
        response.ContentType = "application/json";
        try { await response.WriteAsync(JsonSerializer.Serialize(body, Json), ct); }
        catch (OperationCanceledException) { }
    }

    private void Log(string infoHash, string? file, string? range, EngineTorrentInfo? info, string outcome)
    {
        int? peers = info?.Peers;
        double? pct = info is null || !double.IsFinite(info.Progress) ? null : Math.Round(info.Progress * 10_000) / 100;
        var payload = new Dictionary<string, object?>
        {
            ["infoHash"] = infoHash,
            ["file"] = file,
            ["range"] = range,
            ["peers"] = peers,
            ["downloadedPct"] = pct,
            ["outcome"] = outcome,
        };
        if (outcome == "stalled") payload["message"] = $"stalled on piece, peers={peers ?? 0}, downloaded={pct ?? 0}%";
        var line = JsonSerializer.Serialize(payload);
        if (outcome == "stalled") logger.LogWarning("[stream] {Payload}", line);
        else logger.LogInformation("[stream] {Payload}", line);
    }
}

public sealed record ByteRangeDto(long Start, long End);
