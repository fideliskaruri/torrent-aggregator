using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Prewarm;
using TorrentFlow.Media.Swarm;

namespace TorrentFlow.Media.Controllers;

[ApiController]
public sealed class PrewarmController(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    ForegroundTracker foreground,
    PrewarmCoordinator coordinator,
    PreRanker ranker,
    PreProbeLease lease,
    MediaSettings settings,
    CompletedMedia completed,
    ITorrentEngine engine,
    SwarmMeasurements measurements,
    ILogger<PrewarmController> logger) : ControllerBase
{
    public const double TriggerFraction = 0.15;

    [HttpGet("/api/prewarm")]
    public async Task<IActionResult> Status()
    {
        var ct = HttpContext.RequestAborted;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Origin == PrewarmCoordinator.PrewarmOrigin)
                .OrderBy(t => t.LastUsedAt).Take(50).ToListAsync(ct);
            var (candidates, skipped) = await coordinator.ListEvictableAsync(null, ct);
            var upcoming = await ranker.UpcomingAsync(ct: ct);
            return Ok(new
            {
                prewarms = rows.Select(r => new { hash = r.Hash, name = r.Name, status = r.Status, progress = r.Progress, sizeBytes = r.SizeBytes, lastUsedAt = Iso(r.LastUsedAt) }),
                evictableCount = candidates.Count,
                protectedFromEviction = skipped.Select(s => new { hash = s.Hash, reason = s.Reason }),
                upcoming = upcoming.Select(UpcomingJson),
                foreground = foreground.Snapshot(),
            });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "PREWARM_FAILED");
            return MediaJson.Error(500, new { error = "Failed to load pre-warm status", message = ex.Message, prewarms = Array.Empty<object>(), evictableCount = 0, upcoming = Array.Empty<object>() });
        }
    }

    [HttpPost("/api/prewarm")]
    public async Task<IActionResult> Action()
    {
        var ct = HttpContext.RequestAborted;
        if (MediaJson.GuardBrowserMutation(Request) is { } guard) return guard;
        var parsed = await MediaJson.ReadAnyAsync(Request, ct);
        if (parsed is null) return MediaJson.Error(400, new { error = "Invalid JSON" });
        var body = parsed.Value;
        try
        {
            return body.Str("action") switch
            {
                "prerank" => await PreRankAsync(body, ct),
                "evict" => await EvictAsync(body, ct),
                "foreground" => await ForegroundAsync(body, ct),
                "next" => await NextAsync(body, ct),
                "trigger" => await TriggerAsync(body, ct),
                "progress" => await ProgressAsync(body, ct),
                _ => MediaJson.Error(400, new { error = "Unknown action" }),
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = "Pre-warm action failed", code = "INTERNAL_ERROR", message = ex.Message });
        }
    }

    [HttpGet("/api/prewarm/swarm-probe")]
    public async Task<IActionResult> SwarmProbe()
    {
        var ct = HttpContext.RequestAborted;
        try
        {
            var scope = await ranker.ResolveScopeAsync(ct);
            var rows = await measurements.ListRecentAsync(50, ct);
            return Ok(new
            {
                scope,
                defaultScope = PreRanker.DefaultScope,
                choices = PreRanker.ScopeChoices,
                measurements = rows.Select(m => new Dictionary<string, object?>
                {
                    ["infoHash"] = m.InfoHash,
                    ["name"] = m.Name,
                    ["verdict"] = m.Verdict,
                    ["peersConnected"] = m.PeersConnected,
                    ["peersUnchoked"] = m.PeersUnchoked,
                    ["effectiveBps"] = m.EffectiveBps,
                    ["requiredBps"] = m.RequiredBps,
                    ["measuredAt"] = Iso(m.MeasuredAt),
                    ["expiresAt"] = Iso(m.ExpiresAt),
                    ["expired"] = m.Expired,
                }),
            });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return MediaJson.Error(500, new { error = ex.Message, scope = PreRanker.DefaultScope, measurements = Array.Empty<object>() });
        }
    }

    [HttpPut("/api/prewarm/swarm-probe")]
    public async Task<IActionResult> SetSwarmProbeScope()
    {
        var ct = HttpContext.RequestAborted;
        var parsed = await MediaJson.ReadAnyAsync(Request, ct);
        if (parsed is null) return MediaJson.Error(400, new { error = "Invalid JSON" });
        var scope = PreRanker.NormalizeScope(parsed.Value.Str("scope"));
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.ClientSettings.FirstOrDefaultAsync(s => s.UserId == LocalUser.Id, ct);
            if (row is null) db.ClientSettings.Add(new ClientSetting { Id = Ids.New(), UserId = LocalUser.Id, PreProbeScope = scope });
            else row.PreProbeScope = scope;
            await db.SaveChangesAsync(ct);
            return Ok(new { ok = true, scope });
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
        {
            return MediaJson.Error(500, new { error = ex.Message });
        }
    }

    private async Task<IActionResult> PreRankAsync(JsonElement body, CancellationToken ct)
    {
        var held = lease.TryAcquire(LocalUser.Id);
        if (held is null)
            return Ok(new { ok = true, preProbe = "busy", preRanked = Array.Empty<object>(), message = "A bounded pre-rank/probe pass is already running." });
        var handedOff = false;
        try
        {
            var limit = body.Num("limit") is { } l && double.IsFinite(l) ? (int?)Math.Truncate(l) : null;
            var ranked = await ranker.PreRankUpcomingAsync(limit, ct);
            string preProbe;
            if (!foreground.Active())
            {
                handedOff = true;
                _ = Task.Run(async () =>
                {
                    try { await ranker.PreProbeUpcomingAsync(CancellationToken.None); }
                    catch (Exception ex) { logger.LogWarning("[preprobe] pass failed: {Message}", ex.Message); }
                    finally { held.Dispose(); }
                }, CancellationToken.None);
                preProbe = "scheduled";
            }
            else preProbe = "unavailable";
            return Ok(new { ok = true, preProbe, preRanked = ranked });
        }
        finally
        {
            if (!handedOff) held.Dispose();
        }
    }

    private async Task<IActionResult> EvictAsync(JsonElement body, CancellationToken ct)
    {
        await settings.GetAsync(ct);
        var bytes = body.Num("bytes");
        if (bytes is not { } b || !double.IsFinite(b) || b <= 0) return MediaJson.Error(400, new { error = "bytes must be positive" });
        var result = await coordinator.EvictForBytesAsync((long)Math.Truncate(b), null, ct);
        return Ok(new
        {
            ok = true,
            satisfied = result.Satisfied,
            freedBytes = result.FreedBytes,
            evicted = result.Evicted.Select(e => new { hash = e.Hash, name = e.Name }),
            skipped = result.Skipped.Select(s => new { hash = s.Hash, reason = s.Reason }),
        });
    }

    private async Task<IActionResult> ForegroundAsync(JsonElement body, CancellationToken ct)
    {
        var infoHash = body.Str("infoHash");
        if (body.Truthy("released")) foreground.Release(body.Str("released") ?? infoHash);
        else if (body.Bool("beacon") != false) foreground.MarkActive(infoHash);
        var sync = await coordinator.SyncSuspensionAsync(ct);
        return Ok(new { ok = true, foreground = sync.Foreground, suspended = sync.Suspended, resumed = sync.Resumed, parked = sync.Parked, snapshot = foreground.Snapshot() });
    }

    private async Task<IActionResult> NextAsync(JsonElement body, CancellationToken ct)
    {
        var infoHash = InfoHashes.Normalize(body.Str("infoHash"));
        if (infoHash is null || !IsString(body, "title")) return MediaJson.Error(400, new { error = "infoHash and title are required" });
        var next = ResolveNextEpisode(body.Str("title")!, body.Num("season"), body.Num("episode"));
        if (next is null) return Ok(new Dictionary<string, object?> { ["ok"] = true, ["next"] = null });

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var current = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Hash == infoHash && t.Status != "removed")
            .OrderByDescending(t => t.UpdatedAt).FirstOrDefaultAsync(ct);
        if (current is not null && await EpisodeFileInTorrentAsync(current.Hash, next.Season, next.Episode, ct) is { } fastPath)
            return Ok(NextBody(next, "ready", current.Hash, fastPath, Clamp01(current.Progress)));

        var held = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == LocalUser.Id && t.Status != "removed")
            .OrderByDescending(t => t.UpdatedAt).Take(100).ToListAsync(ct);
        EngineTorrent? acquired = null;
        string? intendedPath = null;
        var workKey = await db.AcquisitionTargets.AsNoTracking().Where(a => a.UserId == LocalUser.Id && a.InfoHash == infoHash).Select(a => a.WorkKey).FirstOrDefaultAsync(ct);
        if (workKey is not null)
        {
            var intent = await db.AcquisitionTargets.AsNoTracking()
                .Where(a => a.UserId == LocalUser.Id && a.WorkKey == workKey && a.Scope == "episode" && a.Season == next.Season && a.Episode == next.Episode && a.InfoHash != null && a.Status != "failed")
                .OrderByDescending(a => a.UpdatedAt).Select(a => new { a.InfoHash, a.FilePath }).FirstOrDefaultAsync(ct);
            if (intent is not null)
            {
                acquired = held.FirstOrDefault(r => string.Equals(r.Hash, intent.InfoHash, StringComparison.OrdinalIgnoreCase));
                intendedPath = intent.FilePath;
            }
        }
        var pre = ranker.GetPreRanked(new(next.Title, null, null, next.Season, next.Episode));
        var exact = pre?.CandidateHash is { } ph ? held.FirstOrDefault(r => string.Equals(r.Hash, ph, StringComparison.OrdinalIgnoreCase)) : null;
        var wanted = MediaFiles.NormalizeTitle(next.Title);
        var byName = held.FirstOrDefault(r =>
        {
            var parsed = Episodes.Parse(r.Name);
            return parsed.Season == next.Season && parsed.Episode == next.Episode && MediaFiles.NormalizeTitle(WorkName(r.Name)) == wanted;
        });
        var row = acquired ?? exact ?? byName;
        double? progress = row is null ? null : Clamp01(row.Progress);
        var availability = row is null ? "not-fetched" : progress >= 1 ? "ready" : "downloading";
        var filePath = row is null ? null : acquired is not null && intendedPath is not null ? intendedPath : await EpisodeFileInTorrentAsync(row.Hash, next.Season, next.Episode, ct);
        return Ok(NextBody(next, availability, row?.Hash, filePath, progress));
    }

    private async Task<IActionResult> TriggerAsync(JsonElement body, CancellationToken ct)
    {
        if (body.Obj("next") is not { } n || n.Str("title")?.Trim() is not { Length: > 0 } title || n.Num("season") is not { } season || n.Num("episode") is not { } episode)
            return MediaJson.Error(400, new { error = "next requires title, season and episode" });
        var next = new NextEpisode(title, (int)season, (int)episode, n.Str("source") == "hunt-cursor" ? "hunt-cursor" : "playing-episode");
        return Ok(new { ok = true, outcome = await PrewarmNextAsync(next, ct) });
    }

    private async Task<IActionResult> ProgressAsync(JsonElement body, CancellationToken ct)
    {
        if (!IsString(body, "infoHash") || !IsString(body, "title")) return MediaJson.Error(400, new { error = "infoHash and title are required" });
        var infoHash = body.Str("infoHash")!;
        await coordinator.MarkUsedAsync(infoHash, ct);
        try { await coordinator.SyncSuspensionAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("[prewarm] suspension sync failed: {Message}", ex.Message); }
        var position = JsNumber(body, "positionSec");
        var duration = JsNumber(body, "durationSec");
        if (!ShouldTrigger(position, duration)) return Ok(new { ok = true, outcome = Outcome("not-applicable", "below-trigger", "Below 15% watched", null) });
        var next = ResolveNextEpisode(body.Str("title")!, body.Num("season"), body.Num("episode"));
        if (next is null) return Ok(new { ok = true, outcome = Outcome("not-applicable", "no-next-episode", "No next episode to pre-warm", null) });
        return Ok(new { ok = true, outcome = await PrewarmNextAsync(next, ct) });
    }

    /// <summary>The prewarmNextEpisode gates; the grab itself is left to the explicit download path (see docs gaps).</summary>
    private async Task<Dictionary<string, object?>> PrewarmNextAsync(NextEpisode next, CancellationToken ct)
    {
        var config = await settings.GetAsync(ct);
        if (!config.IsBuiltin) return Outcome("skipped", "unlabelable-client", $"Pre-warm needs the built-in engine (client is {config.ClientType})", next);
        var sync = await coordinator.SyncSuspensionAsync(ct);
        if (sync.Foreground)
        {
            var parked = sync.Parked.Count > 0 ? $"; parked {sync.Parked.Count} pre-warm(s)" : "";
            return Outcome("skipped", "foreground-busy", $"Playback is active{parked}", next);
        }
        var choice = await ranker.PreRankAsync(new(next.Title, null, null, next.Season, next.Episode), ct);
        if (choice is null) return Outcome("not-applicable", "not-determined", $"Could not pre-rank {next.Label}", next);
        if (choice.Candidate is null)
            return Outcome("not-applicable", "no-release", $"No usable release for {next.Label} in {choice.ResultCount} results", next, preRanked: true);
        return Outcome("skipped", "not-determined", $"Pre-ranked {next.Label}; automatic pre-warm downloads are not enabled in this host", next, preRanked: true, infoHash: choice.CandidateHash);
    }

    private sealed record NextEpisode(string Title, int Season, int Episode, string Source)
    {
        public string Label => $"S{Season:00}E{Episode:00}";
    }

    private static NextEpisode? ResolveNextEpisode(string title, double? season, double? episode)
    {
        var s = season is { } sv && double.IsFinite(sv) && sv >= 1 ? (int)Math.Truncate(sv) : (int?)null;
        var e = episode is { } ev && double.IsFinite(ev) && ev >= 1 ? (int)Math.Truncate(ev) : (int?)null;
        if (s is null || e is null) return null;
        var name = WorkName(title).Trim();
        return name.Length == 0 ? null : new NextEpisode(name, s.Value, e.Value + 1, "playing-episode");
    }

    private async Task<string?> EpisodeFileInTorrentAsync(string hash, int season, int episode, CancellationToken ct)
    {
        IEnumerable<string> paths;
        var manifest = await completed.GetManifestAsync(hash, ct);
        if (manifest is not null) paths = manifest.Select(f => f.RelativePath);
        else
        {
            try { paths = (await engine.GetAsync(hash, ct))?.Files?.Select(f => f.Path.Replace('\\', '/')) ?? []; }
            catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
        }
        return paths.FirstOrDefault(p =>
        {
            if (!MediaFiles.IsVideo(p)) return false;
            var parsed = Episodes.Parse(p.Split('/')[^1]);
            return parsed.Season == season && parsed.Episode == episode;
        });
    }

    private static Dictionary<string, object?> NextBody(NextEpisode next, string availability, string? infoHash, string? filePath, double? progress) => new()
    {
        ["ok"] = true,
        ["next"] = new Dictionary<string, object?>
        {
            ["title"] = next.Title,
            ["label"] = next.Label,
            ["season"] = next.Season,
            ["episode"] = next.Episode,
            ["availability"] = availability,
            ["infoHash"] = infoHash,
            ["filePath"] = filePath,
            ["progress"] = progress,
            ["source"] = next.Source,
        },
    };

    private static Dictionary<string, object?> Outcome(string status, string reason, string message, NextEpisode? next, bool preRanked = false, string? infoHash = null) => new()
    {
        ["status"] = status,
        ["reason"] = reason,
        ["message"] = message,
        ["next"] = next is null ? null : new { title = next.Title, season = next.Season, episode = next.Episode, source = next.Source },
        ["title"] = next?.Title,
        ["infoHash"] = infoHash,
        ["preRanked"] = preRanked,
        ["fastPath"] = false,
        ["labelled"] = false,
        ["evictedCount"] = 0,
        ["freedBytes"] = 0,
    };

    internal static bool ShouldTrigger(double position, double duration) =>
        double.IsFinite(duration) && duration > 0 && double.IsFinite(position) && position >= 0 && position / duration >= TriggerFraction;

    /// <summary>Strips the SxxEyy tail and everything after it to recover the work name from a title or release name.</summary>
    private static string WorkName(string title)
    {
        var m = System.Text.RegularExpressions.Regex.Match(title, @"[\s._-]*(?:S\d{1,2}\s*E\d{1,3}|\d{1,2}x\d{2,3}|Season\s*\d+).*$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var name = m.Success ? title[..m.Index] : title;
        return name.Replace('.', ' ').Replace('_', ' ').Trim();
    }

    private static bool IsString(JsonElement body, string name) => body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String;

    private static double JsNumber(JsonElement body, string name)
    {
        if (!body.TryGetProperty(name, out var v)) return double.NaN;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.String => SubtitlesController.JsNumber(v.GetString()!),
            JsonValueKind.Null => 0,
            JsonValueKind.True => 1,
            JsonValueKind.False => 0,
            _ => double.NaN,
        };
    }

    private static double Clamp01(double v) => double.IsFinite(v) ? Math.Clamp(v, 0, 1) : 0;

    private static object UpcomingJson(Core.Contracts.Media.UpcomingPlaybackTarget t) => new Dictionary<string, object?>
    {
        ["title"] = t.Title,
        ["mediaType"] = t.MediaType,
        ["year"] = t.Year,
        ["season"] = t.Season,
        ["episode"] = t.Episode,
        ["preferredResolution"] = t.PreferredResolution,
    };

    internal static string Iso(DateTime value) =>
        DateTime.SpecifyKind(value, value.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : value.Kind).ToUniversalTime()
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
