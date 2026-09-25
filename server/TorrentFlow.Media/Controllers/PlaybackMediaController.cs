using Microsoft.AspNetCore.Http;
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Prewarm;
using TorrentFlow.Media.Streaming;
using TorrentFlow.Media.Vod;

namespace TorrentFlow.Media.Controllers;

[ApiController]
public sealed class PlaybackMediaController(HlsSessionManager sessions, VodRuntime vod, ForegroundTracker foreground) : ControllerBase
{
    public const int SegmentWaitMs = 20_000;
    private const string PlaylistCache = "no-cache, no-store, must-revalidate";
    private const string ImmutableCache = "private, max-age=31536000, immutable";

    /// <summary>GET|HEAD /api/playback/hls/{sessionId}/{**segment} — files of a live ffmpeg HLS session.</summary>
    [HttpGet("/api/playback/hls/{sessionId}/{**segment}")]
    [HttpHead("/api/playback/hls/{sessionId}/{**segment}")]
    public async Task<IActionResult> Hls(string sessionId, string? segment)
    {
        var session = sessions.Get(sessionId);
        if (session is null) return MediaJson.Error(404, new { error = "Session not found" });
        var filename = string.IsNullOrEmpty(segment) ? "playlist.m3u8" : segment;
        var resolved = HttpRanges.ResolveWithin(session.OutputDir, filename);
        if (resolved is null) return MediaJson.Error(400, new { error = "Invalid path" });
        if (!await sessions.WaitForFileAsync(session, resolved, SegmentWaitMs, HttpContext.RequestAborted))
        {
            if (session.State is "error" or "stalled")
                return MediaJson.Error(503, new { error = "Session failed", state = session.State, message = session.Error });
            if (filename.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase))
                return MediaJson.Error(202, new { error = "Session is still starting, try again shortly", state = session.State });
            return MediaJson.Error(404, new { error = "Segment not found" });
        }
        if (!HttpMethods.IsHead(Request.Method)) foreground.MarkActive(session.InfoHash);
        return new FileRangeResult(resolved, filename, filename.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase) ? PlaylistCache : ImmutableCache);
    }

    /// <summary>GET|HEAD /api/playback/vod/{vodId}/{**file} — a complete-file VOD conversion or on-demand segment set.</summary>
    [HttpGet("/api/playback/vod/{vodId}/{**file}")]
    [HttpHead("/api/playback/vod/{vodId}/{**file}")]
    public async Task<IActionResult> Vod(string vodId, string? file)
    {
        var ct = HttpContext.RequestAborted;
        var filename = string.IsNullOrEmpty(file) ? VodPlanning.WholeFilePlaylist : file;
        var entry = vod.Get(vodId);
        if (entry is null) return MediaJson.Error(404, new { error = "Not found" });
        IActionResult Fail(int status, string message) => MediaJson.Error(status, new { error = message, state = entry.Status });
        var resolved = HttpRanges.ResolveWithin(entry.Dir, filename);
        if (resolved is null) return Fail(400, "Invalid path");

        if (entry.Strategy == "whole-file")
        {
            if (entry.Status != "ready") return Fail(entry.Status == "error" ? 503 : 202, entry.Error ?? "Conversion is still running");
            if (filename is not (VodPlanning.WholeFilePlaylist or VodPlanning.WholeFileData)) return Fail(404, "Not part of this conversion");
            if (!System.IO.File.Exists(resolved)) return Fail(404, "Not found");
        }
        else if (filename == VodPlanning.WholeFilePlaylist)
        {
            if (entry.Status != "ready") return Fail(entry.Status == "error" ? 503 : 202, entry.Error ?? "Preparing the timeline");
            if (!System.IO.File.Exists(resolved)) return Fail(404, "Playlist missing");
        }
        else if (filename == VodPlanning.InitName)
        {
            var init = await vod.EnsureInitAsync(entry, ct);
            if (!init.Ok) return Fail(init.Status, init.Message!);
            resolved = init.Path!;
        }
        else
        {
            if (VodPlanning.ParseSegmentIndex(filename) is not { } index) return Fail(404, "Not found");
            var seg = await vod.EnsureSegmentAsync(entry, index, ct);
            if (!seg.Ok) return Fail(seg.Status, seg.Message!);
            resolved = seg.Path!;
        }

        if (filename == VodPlanning.WholeFilePlaylist && Request.Query["from"].FirstOrDefault() is { } fromRaw
            && double.TryParse(fromRaw, NumberStyles.Float, CultureInfo.InvariantCulture, out var from) && double.IsFinite(from) && from > 0)
        {
            string raw;
            try { raw = await System.IO.File.ReadAllTextAsync(resolved, ct); }
            catch (IOException) { return MediaJson.Error(404, new { error = "Playlist missing" }); }
            var bytes = Encoding.UTF8.GetBytes(VodPlanning.TrimVodPlaylist(raw, from).Text);
            Response.Headers.CacheControl = ImmutableCache;
            if (HttpMethods.IsHead(Request.Method))
            {
                Response.ContentType = "application/vnd.apple.mpegurl";
                return new EmptyResult();
            }
            return File(bytes, "application/vnd.apple.mpegurl");
        }
        return new FileRangeResult(resolved, filename, ImmutableCache);
    }
}
