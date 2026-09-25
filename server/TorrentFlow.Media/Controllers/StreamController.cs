using Microsoft.AspNetCore.Http;
using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Streaming;

namespace TorrentFlow.Media.Controllers;

[ApiController]
public sealed class StreamController(StreamService streams, MediaSettings settings, SwarmWatch watch) : ControllerBase
{
    /// <summary>GET|HEAD /api/stream/{infoHash} — the playable file manifest (completed, live, or 425 while metadata loads).</summary>
    [HttpGet("/api/stream/{infoHash}")]
    [HttpHead("/api/stream/{infoHash}")]
    public Task<IActionResult> Index(string infoHash)
    {
        var q = Request.Query;
        var quiet = q["poll"] == "1";
        var file = q["file"].FirstOrDefault();
        (int, int)? target = PositiveInt(q["season"]) is { } s && PositiveInt(q["episode"]) is { } e ? (s, e) : null;
        return streams.IndexAsync(infoHash, quiet, file, target, HttpContext.RequestAborted);
    }

    /// <summary>GET|HEAD /api/stream/{infoHash}/{**filePath} — byte-range serving of one file.</summary>
    [HttpGet("/api/stream/{infoHash}/{**filePath}")]
    [HttpHead("/api/stream/{infoHash}/{**filePath}")]
    public async Task<IActionResult> ServeFile(string infoHash, string? filePath)
    {
        await streams.ServeFileAsync(HttpContext, infoHash, filePath);
        return new EmptyResult();
    }

    /// <summary>POST /api/stream/{infoHash}/select — re-target the current stream at a preferred resolution.</summary>
    [HttpPost("/api/stream/{infoHash}/select")]
    public async Task<IActionResult> Select(string infoHash)
    {
        var ct = HttpContext.RequestAborted;
        var hash = InfoHashes.Normalize(infoHash);
        if (hash is null) return MediaJson.Error(404, new { error = "Current stream was not found" });
        var (body, failure) = await MediaJson.ReadMutationObjectAsync(Request, ct);
        if (failure is not null) return failure;
        var b = body!.Value;
        if (b.Has("infoHash") || b.Has("currentInfoHash") || b.Has("chosenInfoHash"))
            return MediaJson.Error(400, new { error = "Resolution selection cannot pin a release hash" });
        var preferred = b.Num("preferredResolution") is { } pr && Releases.SupportedResolutions.Contains((int)pr) && pr == Math.Floor(pr) ? (int?)pr : null;
        var title = b.Str("title")?.Trim() ?? "";
        if (title.Length == 0 || preferred is null)
            return MediaJson.Error(400, new { error = "title and a supported preferredResolution are required" });
        var config = await settings.GetAsync(ct);
        if (!config.IsBuiltin) return MediaJson.Error(409, new { error = "Automatic selection requires the built-in client" });
        var target = new PlaybackTarget(title, b.Str("mediaType") ?? "tv", b.PositiveInt("year"), b.PositiveInt("season"), b.PositiveInt("episode"), preferred);
        var contentKey = Releases.PreRankKey(target);
        var preferredResults = Releases.PrioritizeResolution(await watch.RankedResultsAsync(target, ct), preferred.Value);
        async Task<List<TorrentFlow.Core.Contracts.Search.TorrentResult>> Ranked(PlaybackTarget next) =>
            Releases.PreRankKey(next) == contentKey ? preferredResults : Releases.PrioritizeResolution(await watch.RankedResultsAsync(next, ct), preferred.Value);
        if (!watch.UpdateTarget(contentKey, target)) watch.EnsureTarget(contentKey, hash, target);
        if (Releases.CurrentSourceIsBestResolution(preferredResults, hash))
            return Ok(new { ok = true, infoHash = hash, preferredResolution = preferred, noOp = true });
        var result = await watch.TickAsync(contentKey, hash, target, "playability", force: true, Ranked, ct);
        if (!result.Switched)
            return MediaJson.Error(409, new { ok = false, exhausted = result.Exhausted, message = "No playable version is available at that quality." });
        return Ok(new { ok = true, infoHash = result.CurrentHash, preferredResolution = preferred });
    }

    private static int? PositiveInt(string? raw) =>
        int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) && v > 0 ? v : null;
}
