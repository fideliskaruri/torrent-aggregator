using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Subtitles;

public sealed class SubtitlesService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ITorrentEngine _engine;
    private readonly TorrentFlowDbContext _db;
    private readonly SubtitleExtraction _extraction;

    internal SubtitlesService(ITorrentEngine engine, TorrentFlowDbContext db, SubtitleExtraction extraction)
    {
        _engine = engine;
        _db = db;
        _extraction = extraction;
    }

    public async Task<IActionResult> HandleAsync(string rawHash, HttpContext context, CancellationToken ct)
    {
        var query = context.Request.Query;
        string? Param(string name) => query[name].FirstOrDefault();
        var hash = SubtitleRules.NormalizeHash(rawHash);
        var path = (Param("filePath") ?? "").Replace('\\', '/').Trim();
        var trackId = Param("track");
        if (hash is null || path.Length == 0) return Json(400, new { error = "infoHash and filePath are required" });
        if (SubtitleRules.HasTraversal(path)) return Json(400, new { error = "Invalid file path" });

        var parsed = SubtitleRules.ParseTrackId(trackId);
        var rawStart = SubtitleRules.JsNumber(Param("start"));
        var start = SubtitleRules.WindowStart(rawStart);
        if (HttpMethods.IsDelete(context.Request.Method))
        {
            var consumer = Param("consumer")?.Trim();
            if (parsed?.Kind != "embedded" || string.IsNullOrEmpty(consumer) ||
                !double.IsFinite(rawStart) || rawStart < 0 || Math.Abs(rawStart - start) > .001)
                return Json(400, new { error = "Invalid subtitle cancellation request" });
            _extraction.Cancel(hash, path, parsed.Value.Index, start, consumer);
            return new StatusCodeResult(204);
        }

        // The .NET host is intentionally local/single-user. Parked completed
        // files and live torrent bytes are both supplied by the engine contract.
        var torrent = await _engine.GetAsync(hash, ct);
        var settings = await _db.ClientSettings.AsNoTracking().FirstOrDefaultAsync(s => s.UserId == LocalUser.Id, ct);
        var clientType = string.IsNullOrEmpty(settings?.ClientType) ? "builtin" : settings.ClientType;
        if (clientType != "builtin" && torrent?.State != "downloaded")
            return Json(409, new
            {
                error = "Subtitles require the built-in client",
                message = "This title is not available as completed local media. Switch Settings → Built-in to inspect an active torrent.",
                clientType
            });
        if (torrent is null) return Json(404, new { error = "Torrent not found" });
        if (torrent.State == "metaDL" || torrent.Files is null || torrent.Files.Count == 0)
            return Json(425, new
            {
                error = "Torrent metadata is not ready yet",
                message = "The torrent is still fetching metadata; try again in a moment."
            });
        var files = torrent.Files.Select(f => f.Path.Replace('\\', '/')).ToArray();
        var soleVideo = files.Count(SubtitleRules.IsVideo) == 1;

        if (!string.IsNullOrEmpty(trackId))
        {
            var rawOffset = SubtitleRules.JsNumber(Param("offset"));
            var offset = double.IsFinite(rawOffset) && rawOffset > 0 ? Math.Min(rawOffset, 86400) : 0;
            if (!double.IsFinite(rawStart) || rawStart < 0 || rawStart > 86400)
                return Json(400, new { error = "Invalid subtitle window" });
            if (Math.Abs(rawStart - start) > .001)
                return Json(400, new { error = "Subtitle window must use the canonical stride" });
            if (parsed is null) return Json(400, new { error = "Unknown subtitle track" });
            var window = parsed.Value.Kind == "embedded" ? start : 0;
            var cached = _extraction.ReadCache(hash, path, trackId, window);
            if (cached is not null) return Vtt(context, SubtitleRules.ShiftVttCues(cached, window - offset));
            if (parsed.Value.Kind == "sidecar")
            {
                if (!SubtitleRules.BuildTracks(null, files, path, soleVideo).Any(t => t.Id == trackId))
                    return Json(404, new { error = "Subtitle file not found for this video" });
                var file = torrent.Files.FirstOrDefault(f => f.Path.Replace('\\', '/') == parsed.Value.Path);
                var bytes = file is not null ? await ReadFileAsync(hash, file, ct) : null;
                if (bytes is null) return Json(503, new
                {
                    error = "Could not read the subtitle file",
                    message = "The torrent did not deliver the subtitle file. Try again in a moment."
                });
                var converted = await _extraction.ConvertAsync(bytes, Path.GetExtension(parsed.Value.Path), ct);
                if (!converted.Ok) return Json(converted.Error == "timeout" ? 504 : 422, new
                {
                    error = "Could not convert the subtitle file", message = converted.Message
                });
                _extraction.WriteCache(hash, path, trackId, converted.Vtt!);
                return Vtt(context, SubtitleRules.ShiftVttCues(converted.Vtt!, -offset));
            }
            var knownStreams = await CachedStreamsAsync(hash, path, ct);
            if (knownStreams is not null)
            {
                var known = SubtitleRules.BuildTracks(knownStreams, null, path).FirstOrDefault(t => t.Id == trackId);
                if (known is null) return Json(404, new { error = "Subtitle track not found" });
                if (!known.Supported) return Json(422, new
                {
                    error = "Unsupported subtitle track",
                    message = known.UnsupportedReason ?? "this track cannot be converted to WebVTT"
                });
            }
            var outcome = await _extraction.ExtractAsync(_engine, hash, path, parsed.Value.Index, window,
                Param("consumer"), Param("prefetch") == "1", ct);
            if (!outcome.Ok) return Json(outcome.Error switch { "aborted" => 499, "timeout" => 504, "empty" => 422, _ => 503 }, new
            {
                error = outcome.Error switch
                {
                    "aborted" => "Subtitle extraction canceled",
                    "timeout" => "Subtitle extraction timed out",
                    "empty" => "That track contains no cues",
                    _ => "Could not extract that subtitle track"
                },
                message = outcome.Message
            });
            return Vtt(context, SubtitleRules.ShiftVttCues(outcome.Vtt!, window - offset));
        }

        var streams = await CachedStreamsAsync(hash, path, ct);
        string? probeError = null;
        if (streams is null) (streams, probeError) = await _extraction.ProbeAsync(_engine, hash, path, ct);
        var tracks = SubtitleRules.BuildTracks(streams, files, path, soleVideo)
            .Select(t => t with { Src = t.Supported ? SubtitleRules.TrackSrc(hash, path, t.Id) : null }).ToArray();
        var decision = SubtitleRules.Decide(streams ?? [], tracks);
        return Json(200, new
        {
            tracks, defaultTrackId = decision.DefaultTrackId, subtitleDefault = decision,
            embeddedInspected = streams is not null, probeError
        });
    }

    private async Task<byte[]?> ReadFileAsync(string hash, EngineFileInfo file, CancellationToken ct)
    {
        if (file.Length > SubtitleRules.MaxBytes || file.Length < 0) return null;
        try
        {
            await using var stream = await _engine.OpenFileStreamAsync(hash, file.Path, ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            while (true)
            {
                var count = await stream.ReadAsync(chunk, ct);
                if (count == 0) break;
                if (buffer.Length + count > SubtitleRules.MaxBytes) return null;
                buffer.Write(chunk, 0, count);
            }
            return buffer.ToArray()[..(int)Math.Min(file.Length, buffer.Length)];
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or OperationCanceledException or UnauthorizedAccessException)
        { return null; }
    }

    private async Task<List<SubtitleStream>?> CachedStreamsAsync(string hash, string path, CancellationToken ct)
    {
        try
        {
            var json = await _db.MediaProbes.AsNoTracking().Where(p => p.InfoHash == hash && p.FilePath == path)
                .Select(p => p.StreamsJson).FirstOrDefaultAsync(ct);
            return json is null ? null : JsonSerializer.Deserialize<List<SubtitleStream>>(json, JsonOptions);
        }
        catch (JsonException) { return null; }
    }

    private static JsonResult Json(int status, object body) => new(body, JsonOptions) { StatusCode = status };

    private static IActionResult Vtt(HttpContext context, string vtt)
    {
        var bytes = Encoding.UTF8.GetBytes(vtt);
        context.Response.ContentType = "text/vtt; charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.CacheControl = "private, max-age=3600";
        return HttpMethods.IsHead(context.Request.Method) ? new EmptyResult()
            : new FileContentResult(bytes, "text/vtt; charset=utf-8");
    }
}
