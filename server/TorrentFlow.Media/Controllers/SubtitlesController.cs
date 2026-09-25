using Microsoft.AspNetCore.Http;
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Prewarm;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Streaming;
using TorrentFlow.Media.Subtitles;

namespace TorrentFlow.Media.Controllers;

[ApiController]
public sealed class SubtitlesController(
    SubtitleExtractor extractor,
    MediaSettings settings,
    CompletedMedia completed,
    ITorrentEngine engine,
    MediaProber prober,
    ForegroundTracker foreground) : ControllerBase
{
    private static readonly HashSet<string> RouteVideoExtensions = [".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".mpg", ".mpeg"];

    [HttpGet("/api/subtitles/{infoHash}")]
    [HttpHead("/api/subtitles/{infoHash}")]
    [HttpDelete("/api/subtitles/{infoHash}")]
    public async Task<IActionResult> Handle(string infoHash)
    {
        var ct = HttpContext.RequestAborted;
        var q = Request.Query;
        var hash = InfoHashes.Normalize(infoHash);
        var filePath = (q["filePath"].FirstOrDefault() ?? "").Replace('\\', '/').Trim();
        if (hash is null || filePath.Length == 0) return MediaJson.Error(400, new { error = "infoHash and filePath are required" });
        if (filePath.Split('/').Any(s => s is "." or "..")) return MediaJson.Error(400, new { error = "Invalid file path" });
        var track = q["track"].FirstOrDefault();

        if (HttpMethods.IsDelete(Request.Method))
        {
            var parsed = track is not null ? SubtitleText.ParseTrackId(track) : null;
            var consumerId = q["consumer"].FirstOrDefault()?.Trim();
            var rawStart = JsNumber(q["start"].FirstOrDefault() ?? "0");
            var windowStart = SubtitleText.WindowStart(rawStart);
            if (parsed?.Kind != "embedded" || string.IsNullOrEmpty(consumerId) || !double.IsFinite(rawStart) || rawStart < 0 || Math.Abs(rawStart - windowStart) > 0.001)
                return MediaJson.Error(400, new { error = "Invalid subtitle cancellation request" });
            extractor.CancelEmbedded(hash, filePath, parsed.StreamIndex, windowStart, consumerId);
            return NoContent();
        }

        var config = await settings.GetAsync(ct);
        List<string> files;
        var manifest = await completed.GetManifestAsync(hash, ct);
        if (manifest is not null) files = [.. manifest.Select(f => f.RelativePath)];
        else if (!config.IsBuiltin)
            return MediaJson.Error(409, new
            {
                error = "Subtitles require the built-in client",
                message = "This title is not available as completed local media. Switch Settings \u2192 Built-in to inspect an active torrent.",
                clientType = config.ClientType,
            });
        else
        {
            var info = await engine.GetAsync(hash, ct);
            if (info is null) return MediaJson.Error(404, new { error = "Torrent not found" });
            if (StreamService.MetadataPending(info))
                return MediaJson.Error(425, new { error = "Torrent metadata is not ready yet", message = "The torrent is still fetching metadata; try again in a moment." });
            files = [.. info.Files!.Select(f => f.Path.Replace('\\', '/'))];
        }
        var soleVideo = files.Count(IsRouteVideo) == 1;

        if (track is not null)
        {
            var rawOffset = JsNumber(q["offset"].FirstOrDefault() ?? "0");
            var offsetSec = double.IsFinite(rawOffset) && rawOffset > 0 ? Math.Min(rawOffset, 86400) : 0;
            var rawStart = JsNumber(q["start"].FirstOrDefault() ?? "0");
            if (!double.IsFinite(rawStart) || rawStart < 0 || rawStart > 86400) return MediaJson.Error(400, new { error = "Invalid subtitle window" });
            var windowStart = SubtitleText.WindowStart(rawStart);
            if (Math.Abs(rawStart - windowStart) > 0.001) return MediaJson.Error(400, new { error = "Subtitle window must use the canonical stride" });
            return await ServeTrackAsync(hash, filePath, track, files, soleVideo, offsetSec, windowStart, q["consumer"].FirstOrDefault(), q["prefetch"] == "1", ct);
        }

        var streams = await prober.CachedStreamsAsync(hash, filePath, ct);
        string? probeError = null;
        if (streams is null)
        {
            var outcome = await prober.ProbeUrlAsync(ProbeShape.StreamUrl(hash, filePath, ProbeShape.RequestOrigin(Request)), ct);
            if (outcome.Ok) streams = [.. outcome.Result!.Streams];
            else probeError = outcome.Error!.Error;
        }
        var tracks = SubtitleText.BuildTracks(streams, files, filePath, soleVideo);
        var selectedAudio = Decide.SelectPreferredAudio(streams?.Where(s => s.CodecType == "audio").ToList() ?? []);
        var subtitleDefault = Decide.SelectDefaultSubtitle(selectedAudio?.Language, [.. tracks.Select(t => new SubtitleCandidate(t.Id, t.Language, t.Forced, t.Supported))]);
        var listed = tracks.Select(t =>
        {
            var node = System.Text.Json.JsonSerializer.SerializeToNode(t, StreamService.Json)!.AsObject();
            node["src"] = t.Supported ? SubtitleText.TrackSrc(hash, filePath, t.Id) : null;
            return node;
        }).ToList();
        return Ok(new Dictionary<string, object?>
        {
            ["tracks"] = listed,
            ["defaultTrackId"] = subtitleDefault.DefaultTrackId,
            ["subtitleDefault"] = subtitleDefault,
            ["embeddedInspected"] = streams is not null,
            ["probeError"] = probeError,
        });
    }

    private async Task<IActionResult> ServeTrackAsync(string hash, string filePath, string trackId, List<string> files, bool soleVideo,
        double offsetSec, double windowStartSec, string? consumer, bool prefetch, CancellationToken ct)
    {
        var parsed = SubtitleText.ParseTrackId(trackId);
        if (parsed is null) return MediaJson.Error(400, new { error = "Unknown subtitle track" });
        var embeddedWindowStart = parsed.Kind == "embedded" ? windowStartSec : 0;
        string Rebase(string vtt) => SubtitleText.ShiftVttCues(vtt, embeddedWindowStart - offsetSec);
        var head = HttpMethods.IsHead(Request.Method);

        var cached = extractor.ReadCached(hash, filePath, trackId, embeddedWindowStart);
        if (cached is not null)
        {
            if (!head) foreground.MarkActive(hash);
            return Vtt(Rebase(cached), head);
        }

        if (parsed.Kind == "sidecar")
        {
            if (!SubtitleText.BuildTracks(null, files, filePath, soleVideo).Any(t => t.Id == trackId))
                return MediaJson.Error(404, new { error = "Subtitle file not found for this video" });
            var bytes = await ReadSidecarAsync(hash, parsed.FilePath!, ct);
            if (bytes is null)
                return MediaJson.Error(503, new { error = "Could not read the subtitle file", message = "The torrent did not deliver the subtitle file. Try again in a moment." });
            var ext = SubtitleText.ExtensionOf(parsed.FilePath!).TrimStart('.').ToLowerInvariant();
            var converted = await extractor.ConvertSidecarAsync(bytes, ext, ct);
            if (!converted.Ok)
                return MediaJson.Error(converted.Error == "timeout" ? 504 : 422, new { error = "Could not convert the subtitle file", message = converted.Message });
            extractor.CacheSidecar(hash, filePath, trackId, converted.Vtt!);
            if (!head) foreground.MarkActive(hash);
            return Vtt(Rebase(converted.Vtt!), head);
        }

        var streams = await prober.CachedStreamsAsync(hash, filePath, ct);
        if (streams is not null)
        {
            var known = SubtitleText.BuildTracks(streams, null, filePath).FirstOrDefault(t => t.Id == trackId);
            if (known is null) return MediaJson.Error(404, new { error = "Subtitle track not found" });
            if (!known.Supported)
                return MediaJson.Error(422, new { error = "Unsupported subtitle track", message = known.UnsupportedReason ?? "this track cannot be converted to WebVTT" });
        }
        var outcome = await extractor.ExtractEmbeddedAsync(hash, filePath, parsed.StreamIndex, ProbeShape.StreamUrl(hash, filePath, ProbeShape.RequestOrigin(Request)),
            embeddedWindowStart, consumer, prefetch, prefetch ? SubtitleExtractor.PrefetchExtractTimeoutMs : null, ct);
        if (!outcome.Ok)
        {
            var (status, error) = outcome.Error switch
            {
                "aborted" => (499, "Subtitle extraction canceled"),
                "timeout" => (504, "Subtitle extraction timed out"),
                "empty" => (422, "That track contains no cues"),
                _ => (503, "Could not extract that subtitle track"),
            };
            return MediaJson.Error(status, new { error, message = outcome.Message });
        }
        if (!head) foreground.MarkActive(hash);
        return Vtt(Rebase(outcome.Vtt!), head);
    }

    private async Task<byte[]?> ReadSidecarAsync(string hash, string relativePath, CancellationToken ct)
    {
        var local = await completed.ResolveAsync(hash, relativePath, ct);
        if (local is not null)
        {
            try
            {
                if (local.Length > SubtitleExtractor.MaxSubtitleBytes) return null;
                return await System.IO.File.ReadAllBytesAsync(local.AbsolutePath, ct);
            }
            catch (IOException) { return null; }
        }
        var info = await engine.GetAsync(hash, ct);
        var file = info?.Files?.FirstOrDefault(f => f.Path.Replace('\\', '/') == relativePath);
        if (file is null || file.Length > SubtitleExtractor.MaxSubtitleBytes) return null;
        try
        {
            await using var stream = await engine.OpenFileStreamAsync(hash, file.Index.ToString(CultureInfo.InvariantCulture), ct);
            using var ms = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer, ct)) > 0)
            {
                ms.Write(buffer, 0, read);
                if (ms.Length > SubtitleExtractor.MaxSubtitleBytes) return null;
                if (ms.Length >= file.Length) break;
            }
            var all = ms.ToArray();
            return all.Length > file.Length ? all[..(int)file.Length] : all;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or ArgumentException or OperationCanceledException) { return null; }
    }

    private IActionResult Vtt(string vtt, bool head)
    {
        var bytes = Encoding.UTF8.GetBytes(vtt);
        Response.Headers.CacheControl = "private, max-age=3600";
        Response.ContentLength = bytes.Length;
        if (head)
        {
            Response.ContentType = "text/vtt; charset=utf-8";
            return new EmptyResult();
        }
        return File(bytes, "text/vtt; charset=utf-8");
    }

    internal static bool IsRouteVideo(string path)
    {
        var name = path.Replace('\\', '/').Split('/')[^1];
        var dot = name.LastIndexOf('.');
        return dot >= 0 && RouteVideoExtensions.Contains(name[dot..].ToLowerInvariant());
    }

    /// <summary>JavaScript Number(string) semantics for query values: blank → 0, junk → NaN.</summary>
    internal static double JsNumber(string raw)
    {
        var t = raw.Trim();
        if (t.Length == 0) return 0;
        return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : double.NaN;
    }
}
