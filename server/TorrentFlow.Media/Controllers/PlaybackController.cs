using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Swarm;
using TorrentFlow.Media.Vod;

namespace TorrentFlow.Media.Controllers;

[ApiController]
public sealed class PlaybackController(
    MediaSettings settings,
    CompletedMedia completed,
    ITorrentEngine engine,
    MediaProber prober,
    HlsSessionManager sessions,
    VodRuntime vod,
    SwarmWatch watch,
    SwarmMeasurements measurements,
    ILogger<PlaybackController> logger) : ControllerBase
{
    private sealed record LocalFile(bool Ok, string? AbsolutePath, string? Reason);

    [HttpPost("/api/playback/plan")]
    public async Task<IActionResult> Plan()
    {
        var ct = HttpContext.RequestAborted;
        var (parsed, failure) = await MediaJson.ReadMutationObjectAsync(Request, ct);
        if (failure is not null) return failure;
        var body = parsed!.Value;

        if (RequestFields.String(body, "infoHash", out var rawHash, required: true, maxLength: 64) is { } e1) return e1;
        var infoHash = InfoHashes.Normalize(rawHash);
        if (infoHash is null) return RequestFields.Fail("infoHash must be a 40-character hex or 32-character base32 hash", "infoHash");
        if (RequestFields.String(body, "filePath", out var filePathRaw, required: true, maxLength: 4096) is { } e2) return e2;
        var filePath = filePathRaw ?? "";
        if (!IsSafeTorrentPath(filePath)) return RequestFields.Fail("filePath must be a safe path inside the torrent", "filePath");
        if (RequestFields.Number(body, "audioStreamIndex", out var audioRaw, nullable: true, integer: true, min: 0, max: 10000) is { } e3) return e3;
        if (RequestFields.Boolean(body, "warm", out var warmRaw) is { } e4) return e4;
        var warm = warmRaw == true;
        if (RequestFields.Number(body, "startSec", out var startRaw, min: 0, max: 1_000_000_000) is { } e5) return e5;
        if (RequestFields.Object(body, "capabilities", out var capsObj) is { } e6) return e6;
        if (capsObj is { } caps && ValidateCapabilities(caps) is { } e7) return e7;

        MediaClientConfig config;
        try { config = await settings.GetAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = "Playback planning failed", code = "INTERNAL_ERROR", message = ex.Message });
        }
        if (!config.IsBuiltin) return MediaJson.Error(409, new { error = "Playback planning requires the built-in client", clientType = config.ClientType });

        var capabilities = Capabilities.Parse(capsObj);
        var audioStreamIndex = audioRaw is { } a ? (int?)a : null;
        var requestedStartSec = (int)Math.Floor(startRaw ?? 0);

        if (warm) return Ok(await WarmAsync(infoHash, filePath, ct));

        LocalFile local;
        try { local = await ResolveCompleteLocalFileAsync(infoHash, filePath, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = "Playback planning failed", code = "INTERNAL_ERROR", message = ex.Message });
        }
        var origin = ProbeShape.RequestOrigin(Request);
        var probeCache = "hit";
        ProbeResult? probe = null;
        try { probe = await prober.CachedAsync(infoHash, filePath, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "PLAYBACK_CACHE_FAILED read"); }
        if (probe is null)
        {
            ProbeOutcome outcome;
            try
            {
                outcome = local.Ok
                    ? await prober.ProbeFileAsync(local.AbsolutePath!, ct)
                    : await prober.ProbeUrlAsync(ProbeShape.StreamUrl(infoHash, filePath, origin), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return MediaJson.Error(503, new { error = "Could not probe file", code = "UPSTREAM_UNAVAILABLE", message = ex.Message, probeError = "probe_failed" });
            }
            if (!outcome.Ok)
            {
                var code = outcome.Error!.Error == "timeout" ? "OPERATION_TIMEOUT" : "UPSTREAM_UNAVAILABLE";
                return MediaJson.Error(503, new { error = "Could not probe file", code, message = outcome.Error.Message, probeError = outcome.Error.Error });
            }
            probe = outcome.Result!;
            probeCache = await prober.StoreAsync(infoHash, filePath, probe, ct) ? "written" : "failed";
        }

        var plan = Decide.DecidePlayback(probe, capabilities, audioStreamIndex);
        var duration = probe.Duration;
        var startSec = duration is > 0
            ? Math.Min(requestedStartSec, Math.Max(0, (int)Math.Floor(duration.Value - HlsArgs.SegmentSeconds)))
            : requestedStartSec;
        var decision = VodPlanning.ChooseStrategy(local.Ok, plan, duration);
        var strategy = decision.Strategy;
        var strategyReason = local.Ok ? decision.Reason : $"{decision.Reason}: {local.Reason}";
        var source = local.Ok ? "disk" : "swarm";

        if (strategy != "session" && local.Ok && duration is { } dur)
        {
            var entry = vod.Prepare(strategy, infoHash, filePath, plan.SelectedAudioIndex, local.AbsolutePath!, dur, plan);
            if (entry.Status == "ready")
            {
                double offset = 0;
                if (startSec > 0)
                {
                    try { offset = VodPlanning.TrimVodPlaylist(await System.IO.File.ReadAllTextAsync(VodRuntime.PlaylistPath(entry), ct), startSec).OffsetSeconds; }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { offset = 0; }
                }
                var query = startSec > 0 ? $"?from={startSec}" : "";
                return Ok(PlanBody(plan, $"/api/playback/vod/{entry.Id}/{VodPlanning.WholeFilePlaylist}{query}", null, offset, strategy, strategyReason, source, probe, probeCache));
            }
            strategyReason = $"{strategy} still {entry.Status}: {entry.Error ?? "converting"}";
            strategy = "session";
        }

        string playUrl;
        string? sessionId;
        if (plan.Rung == "direct" && startSec == 0)
        {
            playUrl = "/api/stream/" + Uri.EscapeDataString(infoHash) + "/" + string.Join('/',
                filePath.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.EscapeDataString));
            sessionId = null;
        }
        else
        {
            var sourceUrl = local.Ok ? local.AbsolutePath! : ProbeShape.StreamUrl(infoHash, filePath, origin);
            if (local.Ok) strategyReason += "; ffmpeg reads the file directly from disk";
            var result = sessions.GetOrCreate(infoHash, filePath, plan, sourceUrl, startSec);
            if (result.Session is null)
            {
                logger.LogWarning("PLAYBACK_PLAN_FAILED session: {Error}", result.Error);
                return MediaJson.Error(503, new { error = "Playback session could not be started", code = "UPSTREAM_UNAVAILABLE" });
            }
            sessionId = result.Session.Id;
            playUrl = $"/api/playback/hls/{sessionId}/playlist.m3u8";
        }
        return Ok(PlanBody(plan, playUrl, sessionId, startSec, strategy, strategyReason, source, probe, probeCache));
    }

    [HttpPost("/api/playback/candidates")]
    public async Task<IActionResult> Candidates()
    {
        var ct = HttpContext.RequestAborted;
        var body = await MediaJson.ReadAnyAsync(Request, ct);
        if (body is null) return MediaJson.Error(400, new { error = "Invalid JSON body" });
        var b = body.Value;
        var title = b.Str("title")?.Trim() ?? "";
        if (title.Length == 0) return MediaJson.Error(400, new { error = "title is required" });
        var target = new PlaybackTarget(title, b.Str("mediaType") ?? "tv", b.PositiveInt("year"), b.PositiveInt("season"), b.PositiveInt("episode"), b.PositiveInt("preferredResolution"));
        var current = InfoHashes.Normalize(b.Str("currentInfoHash"));
        try
        {
            var pool = await watch.RankedResultsAsync(target, ct);
            var verdicts = await measurements.LoadVerdictsAsync(pool.Select(Releases.ReleaseInfoHash), ct);
            return Ok(new { candidates = Releases.ListCandidates(pool, target, current, verdicts) });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = "Could not list candidates", message = ex.Message });
        }
    }

    [HttpPost("/api/playback/failover")]
    public async Task<IActionResult> Failover()
    {
        var ct = HttpContext.RequestAborted;
        MediaClientConfig config;
        try { config = await settings.GetAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { code = "INTERNAL_ERROR", error = "Failover could not start", message = ex.Message });
        }
        if (!config.IsBuiltin) return MediaJson.Error(409, new { error = "Play-time failover requires the built-in client", clientType = config.ClientType });
        var body = await MediaJson.ReadAnyAsync(Request, ct);
        if (body is null) return MediaJson.Error(400, new { error = "Invalid JSON body" });
        var b = body.Value;
        var infoHash = InfoHashes.Normalize(b.Str("infoHash"));
        var title = b.Str("title")?.Trim() ?? "";
        if (infoHash is null || title.Length == 0) return MediaJson.Error(400, new { error = "infoHash and title are required" });
        var reason = b.Str("reason") == "playability" ? "playability" : "delivery";
        var target = new PlaybackTarget(title, b.Str("mediaType") ?? "tv", null, b.PositiveInt("season"), b.PositiveInt("episode"), b.PositiveInt("preferredResolution"));
        var contentKey = Releases.PreRankKey(target);

        if (b.Str("action") == "retry")
        {
            if (reason == "playability")
                return MediaJson.Error(409, new { ok = false, code = "NOT_RETRYABLE", failureClass = "playability", retryable = false, infoHash });
            bool retried;
            try { retried = await watch.RetryTorrentAsync(infoHash, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return MediaJson.Error(500, new { ok = false, code = "INTERNAL_ERROR", failureClass = "delivery", retryable = false, message = ex.Message });
            }
            return retried
                ? Ok(new { ok = true, code = "RETRYING", failureClass = "delivery", retryable = true, infoHash, retried = true })
                : Ok(new { ok = false, code = "RETRY_FAILED", failureClass = "delivery", retryable = false, infoHash, message = "This source could not be retried." });
        }

        try
        {
            var result = await watch.TickAsync(contentKey, infoHash, target, reason, reason == "playability", null, ct);
            var code = result.Exhausted ? "EXHAUSTED" : result.Switched ? "SWITCHED" : result.Verdict.Stalled ? "STALLED" : "PLAYING";
            return Ok(new Dictionary<string, object?>
            {
                ["code"] = code,
                ["narration"] = result.Narration,
                ["copy"] = Releases.DescribePlayback(result.Narration),
                ["currentHash"] = result.CurrentHash,
                ["switched"] = result.Switched,
                ["exhausted"] = result.Exhausted,
                ["stall"] = new Dictionary<string, object?>
                {
                    ["stalled"] = result.Verdict.Stalled,
                    ["reason"] = result.Verdict.Reason,
                    ["deliveredBytes"] = result.Verdict.DeliveredBytes,
                    ["windowMs"] = result.Verdict.WindowMs,
                },
            });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { code = "INTERNAL_ERROR", error = "Failover tick failed", message = ex.Message });
        }
    }

    [HttpGet("/api/playback/status")]
    public async Task<IActionResult> Status()
    {
        var state = watch.CurrentForegroundState();
        if (state is null) return Ok(new { active = false });
        double? position = null;
        try { position = await watch.LatestPositionAsync(state.CurrentHash, HttpContext.RequestAborted); }
        catch (Exception ex) when (ex is not OperationCanceledException) { position = null; }
        return Ok(new Dictionary<string, object?>
        {
            ["active"] = true,
            ["infoHash"] = state.CurrentHash,
            ["pinned"] = state.PinnedHash is not null && state.PinnedHash == state.CurrentHash,
            ["positionSec"] = position,
            ["exhausted"] = state.Exhausted,
            ["narration"] = state.Narration,
            ["copy"] = Releases.DescribePlayback(state.Narration),
        });
    }

    [HttpPost("/api/playback/switch")]
    public async Task<IActionResult> Switch()
    {
        var ct = HttpContext.RequestAborted;
        var config = await settings.GetAsync(ct);
        if (!config.IsBuiltin) return MediaJson.Error(409, new { error = "Manual switching requires the built-in client", clientType = config.ClientType });
        var body = await MediaJson.ReadAnyAsync(Request, ct);
        if (body is null) return MediaJson.Error(400, new { error = "Invalid JSON body" });
        var b = body.Value;
        var title = b.Str("title")?.Trim() ?? "";
        var current = InfoHashes.Normalize(b.Str("currentInfoHash"));
        var chosen = InfoHashes.Normalize(b.Str("chosenInfoHash"));
        if (title.Length == 0 || current is null || chosen is null)
            return MediaJson.Error(400, new { error = "title, currentInfoHash and chosenInfoHash are required" });
        var target = new PlaybackTarget(title, b.Str("mediaType") ?? "tv", null, b.PositiveInt("season"), b.PositiveInt("episode"), b.PositiveInt("preferredResolution"));
        try
        {
            var result = await watch.ManualSwitchAsync(Releases.PreRankKey(target), current, chosen, target, ct);
            if (!result.Ok) return MediaJson.Error(result.Reason == "not-a-candidate" ? 409 : 502, new { ok = false, reason = result.Reason });
            var narration = result.Narration ?? [];
            return Ok(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["infoHash"] = result.InfoHash,
                ["positionSec"] = result.PositionSec,
                ["narration"] = narration,
                ["copy"] = Releases.DescribePlayback(narration),
            });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = "Manual switch failed", message = ex.Message });
        }
    }

    private async Task<object> WarmAsync(string infoHash, string filePath, CancellationToken ct)
    {
        CompletedFile? local;
        try { local = await completed.ResolveAsync(infoHash, filePath, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { local = null; }
        if (local is null) return new { warm = true, ready = false, reason = "not-local" };
        try
        {
            if (await prober.CachedAsync(infoHash, filePath, ct) is not null) return new { warm = true, ready = true, probeCache = "hit" };
            var outcome = await prober.RunSingleFlight($"{infoHash.ToLowerInvariant()}|{filePath}", () => prober.ProbeFileAsync(local.AbsolutePath, CancellationToken.None)).WaitAsync(ct);
            if (!outcome.Ok) return new { warm = true, ready = false, reason = "probe-failed" };
            var written = await prober.StoreAsync(infoHash, filePath, outcome.Result!, ct);
            return new { warm = true, ready = true, probeCache = written ? "written" : "failed" };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new { warm = true, ready = false, reason = "probe-failed" };
        }
    }

    /// <summary>Port of resolveCompleteLocalFile: persisted completed download first, then the live engine's per-file progress.</summary>
    private async Task<LocalFile> ResolveCompleteLocalFileAsync(string infoHash, string filePath, CancellationToken ct)
    {
        var persisted = await completed.ResolveAsync(infoHash, filePath, ct);
        if (persisted is not null) return new LocalFile(true, persisted.AbsolutePath, null);
        EngineTorrentInfo? info;
        try { info = await engine.GetAsync(infoHash, ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return new LocalFile(false, null, $"engine lookup failed: {ex.Message}"); }
        if (info is null) return new LocalFile(false, null, "torrent lookup: not-found");
        var wanted = filePath.Replace('\\', '/');
        var file = info.Files?.FirstOrDefault(f => f.Path.Replace('\\', '/') == wanted);
        if (file is null) return new LocalFile(false, null, info.Files is null or { Count: 0 } ? "torrent lookup: metadata-pending" : "torrent lookup: file-not-found");
        if (info.Progress < 1 && file.Progress < 1)
        {
            var pct = double.IsFinite(info.Progress) ? (info.Progress * 100).ToString("0.0", CultureInfo.InvariantCulture) : "unknown";
            return new LocalFile(false, null, $"torrent is {pct}% downloaded and this file is not fully verified yet");
        }
        if (string.IsNullOrEmpty(file.FullPath)) return new LocalFile(false, null, "no download directory recorded for this torrent");
        var fi = new FileInfo(file.FullPath);
        if (!fi.Exists) return new LocalFile(false, null, $"file not found under {Path.GetDirectoryName(file.FullPath)}");
        if (file.Length > 0 && fi.Length != file.Length)
            return new LocalFile(false, null, $"on-disk size {fi.Length} does not match the torrent's {file.Length}");
        return new LocalFile(true, fi.FullName, null);
    }

    private static Dictionary<string, object?> PlanBody(PlaybackPlan plan, string playUrl, string? sessionId, double startSec,
        string strategy, string strategyReason, string source, ProbeResult probe, string probeCache)
    {
        var video = probe.Video;
        var audio = probe.Audio.FirstOrDefault();
        return new Dictionary<string, object?>
        {
            ["plan"] = plan,
            ["playUrl"] = playUrl,
            ["sessionId"] = sessionId,
            ["startSec"] = startSec,
            ["strategy"] = strategy,
            ["strategyReason"] = strategyReason,
            ["source"] = source,
            ["probe"] = new Dictionary<string, object?>
            {
                ["container"] = ProbeShape.NormalizeContainer(probe.Container),
                ["duration"] = probe.Duration,
                ["videoCodec"] = video?.Codec,
                ["videoProfile"] = video?.Profile,
                ["audioCodec"] = audio?.Codec,
                ["audioChannels"] = audio?.Channels,
                ["width"] = video?.Width,
                ["height"] = video?.Height,
                ["bitrate"] = ProbeShape.BitrateBps(probe),
            },
            ["probeCache"] = probeCache,
        };
    }

    internal static bool IsSafeTorrentPath(string filePath) =>
        !(filePath.Contains('\0') || filePath.StartsWith('/') ||
          (filePath.Length >= 3 && char.IsAsciiLetter(filePath[0]) && filePath[1] == ':' && filePath[2] is '\\' or '/') ||
          filePath.Replace('\\', '/').Split('/').Any(s => s == ".."));

    private static IActionResult? ValidateCapabilities(JsonElement caps)
    {
        if (RequestFields.String(caps, "ua", out _, maxLength: 2000) is { } ua) return ua;
        if (caps.TryGetProperty("mseSupported", out var mse) && mse.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return RequestFields.Fail("capabilities.mseSupported must be a boolean", "capabilities");
        if (!caps.TryGetProperty("codecs", out var codecs)) return null;
        if (codecs.ValueKind != JsonValueKind.Array) return RequestFields.Fail("capabilities.codecs must be an array", "capabilities");
        if (codecs.GetArrayLength() > 128) return RequestFields.Fail("capabilities.codecs may contain at most 128 entries", "capabilities");
        var index = 0;
        foreach (var entry in codecs.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) return RequestFields.Fail($"capabilities.codecs[{index}] must be an object", "capabilities");
            if (ParseCodecEntry(entry) is { } bad) return RequestFields.Fail(bad.Error, bad.Field);
            if (!entry.TryGetProperty("mse", out var m) || m.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return RequestFields.Fail($"capabilities.codecs[{index}].mse must be a boolean", "capabilities");
            index++;
        }
        return null;
    }

    /// <summary>Port of parsePlaybackPlanCodecEntry; returns the failure or null when valid.</summary>
    internal static (string Error, string Field)? ParseCodecEntry(JsonElement entry)
    {
        if (!entry.TryGetProperty("mime", out var mime)) return ("mime is required", "mime");
        if (mime.ValueKind != JsonValueKind.String) return ("mime must be a string", "mime");
        var m = mime.GetString()!.Trim();
        if (m.Length == 0) return ("mime is required", "mime");
        if (m.Length > 500) return ("mime must be at most 500 characters", "mime");
        if (!entry.TryGetProperty("canPlay", out var canPlay)) return ("canPlay is required", "canPlay");
        if (canPlay.ValueKind != JsonValueKind.String) return ("canPlay must be a string", "canPlay");
        var c = canPlay.GetString()!;
        if (c.Length > 32) return ("canPlay must be at most 32 characters", "canPlay");
        if (c is not ("" or "maybe" or "probably")) return ("canPlay must be one of: \"\", \"maybe\", \"probably\"", "canPlay");
        return null;
    }
}
