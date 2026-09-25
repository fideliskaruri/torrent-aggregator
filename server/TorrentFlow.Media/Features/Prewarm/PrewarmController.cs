using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Pre-warm control + diagnostics (src/app/api/prewarm/route.ts). A pre-warm that could not run is a 200 skip with
/// a reason — nothing the user asked for went wrong.
/// </summary>
[ApiController]
[Route("api/prewarm")]
public sealed class PrewarmController(
    IDbContextFactory<TorrentFlowDbContext> factory,
    PrewarmEviction eviction,
    PreRanker ranker,
    PreProber prober,
    PreProbeLock gate,
    ForegroundTracker foreground,
    PrewarmService prewarm,
    ILogger<PrewarmController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var userId = LocalUser.Id;
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && t.Origin == PrewarmOrigins.Prewarm)
                .OrderBy(t => t.LastUsedAt).Take(50).ToListAsync(ct);
            var evictable = await eviction.ListEvictableAsync(userId, ct: ct);
            var upcoming = await ranker.UpcomingTargetsAsync(userId, ct: ct);
            return PrewarmHttp.Json(new
            {
                prewarms = rows.Select(t => new
                {
                    hash = t.Hash,
                    name = t.Name,
                    status = t.Status,
                    progress = t.Progress,
                    sizeBytes = t.SizeBytes,
                    lastUsedAt = PrewarmHttp.Iso(t.LastUsedAt),
                }),
                evictableCount = evictable.Candidates.Count,
                protectedFromEviction = evictable.Skipped,
                upcoming,
                foreground = foreground.GetSnapshot(),
            });
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "PREWARM_FAILED prewarm-status");
            var safe = PrewarmHttp.Normalize(e);
            return PrewarmHttp.Json(new
            {
                error = "Failed to load pre-warm status",
                message = safe.Message,
                prewarms = Array.Empty<object>(),
                evictableCount = 0,
                upcoming = Array.Empty<object>(),
            }, 500);
        }
    }

    [HttpPost]
    public async Task<IActionResult> Post(CancellationToken ct)
    {
        var userId = LocalUser.Id;
        if (PrewarmHttp.BrowserMutationRefusal(Request) is { } refusal) return PrewarmHttp.Json(new { error = refusal }, 403);
        if (await PrewarmHttp.ReadJsonAsync(Request, ct) is not { } body) return PrewarmHttp.Json(new { error = "Invalid JSON" }, 400);

        try
        {
            if (body.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Request body must be an object");
            return PrewarmHttp.Str(body, "action") switch
            {
                "prerank" => await PreRankAsync(userId, body, ct),
                "evict" => await EvictAsync(userId, body, ct),
                "foreground" => await ForegroundAsync(userId, body, ct),
                "next" => await NextAsync(userId, body, ct),
                "trigger" => await TriggerAsync(userId, body, ct),
                "progress" => await ProgressAsync(userId, body, ct),
                _ => PrewarmHttp.Json(new { error = "Unknown action" }, 400),
            };
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "PREWARM_FAILED prewarm-action");
            var safe = PrewarmHttp.Normalize(e);
            return PrewarmHttp.Json(new { error = "Pre-warm action failed", code = safe.Code, message = safe.Message }, 500);
        }
    }

    private async Task<IActionResult> PreRankAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var release = gate.TryAcquire(userId);
        if (release is null)
            return PrewarmHttp.Json(new { ok = true, preProbe = "busy", preRanked = Array.Empty<object>(), message = "A bounded pre-rank/probe pass is already running." });

        var handedToProbe = false;
        try
        {
            var limit = PrewarmHttp.Num(body, "limit") is { } l && double.IsFinite(l) ? (int)Math.Clamp(Math.Truncate(l), int.MinValue, int.MaxValue) : (int?)null;
            var choices = await ranker.PreRankUpcomingAsync(userId, limit, ct);

            // Fire-and-forget: measuring swarms must not add latency to the pre-rank response.
            var preProbe = "unavailable";
            if (!foreground.IsActive())
            {
                preProbe = "scheduled";
                handedToProbe = true;
                _ = Task.Run(async () =>
                {
                    try { await prober.PreProbeUpcomingAsync(userId); }
                    catch (Exception e) { logger.LogError(e, "PREWARM_FAILED background pre-probe"); }
                    finally { release(); }
                }, CancellationToken.None);
            }

            return PrewarmHttp.Json(new
            {
                ok = true,
                preProbe,
                preRanked = choices.Select(c => new
                {
                    query = c.Query,
                    season = c.Season,
                    episode = c.Episode,
                    resultCount = c.ResultCount,
                    source = c.Source,
                    candidate = c.Candidate is { } r ? new { title = r.Title, seeders = r.Seeders, sizeBytes = r.SizeBytes, source = r.Source } : null,
                }),
            });
        }
        finally
        {
            if (!handedToProbe) release();
        }
    }

    private async Task<IActionResult> EvictAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var bytes = PrewarmHttp.JsNumber(body, "bytes");
        if (!double.IsFinite(bytes) || bytes <= 0) return PrewarmHttp.Json(new { error = "bytes must be positive" }, 400);
        var needed = bytes >= long.MaxValue ? long.MaxValue : (long)Math.Ceiling(bytes);
        var result = await eviction.EvictForBytesAsync(userId, needed, ct: ct);
        return PrewarmHttp.Json(new
        {
            ok = true,
            satisfied = result.Satisfied,
            freedBytes = result.FreedBytes,
            evicted = result.Evicted.Select(c => new { hash = c.Hash, name = c.Name }),
            skipped = result.Skipped,
        });
    }

    private async Task<IActionResult> ForegroundAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var infoHash = PrewarmHttp.Str(body, "infoHash");
        if (PrewarmHttp.Truthy(body, "released"))
            foreground.Release(PrewarmHttp.Str(body, "released") ?? infoHash);
        else if (PrewarmHttp.Prop(body, "beacon") is not { ValueKind: JsonValueKind.False })
            foreground.MarkActive(infoHash);
        var result = await foreground.SyncAsync(userId, ct: ct);
        return PrewarmHttp.Json(new
        {
            ok = true,
            foreground = result.Foreground,
            suspended = result.Suspended,
            resumed = result.Resumed,
            parked = result.Parked,
            snapshot = foreground.GetSnapshot(),
        });
    }

    private async Task<IActionResult> NextAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var infoHash = ReleaseText.NormalizeInfoHash(PrewarmHttp.Str(body, "infoHash"));
        var title = PrewarmHttp.Str(body, "title");
        if (infoHash is null || title is null) return PrewarmHttp.Json(new { error = "infoHash and title are required" }, 400);

        var next = await prewarm.ResolveNextEpisodeAsync(new PrewarmService.PlaybackContext
        {
            UserId = userId,
            InfoHash = infoHash,
            Title = title,
            Season = PrewarmHttp.Num(body, "season"),
            Episode = PrewarmHttp.Num(body, "episode"),
            WatchListItemId = PrewarmHttp.Str(body, "watchListItemId"),
        }, ct);
        if (next is null) return PrewarmHttp.Json(new { ok = true, next = (object?)null });

        var label = ReleaseText.FormatEpisodeLabel(next.Season, next.Episode);
        await using var db = await factory.CreateDbContextAsync(ct);

        // Fastest answer first: the next episode is often another file in the torrent already playing (a season pack).
        var current = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && t.Hash == infoHash && t.Status != "removed")
            .OrderByDescending(t => t.UpdatedAt).Select(t => new { t.Hash, t.Progress, t.SavePath, t.VerifiedFilesJson }).FirstOrDefaultAsync(ct);
        var inPackPath = current is null ? null : NextEpisodeFile.EpisodeFileInTorrent(current.SavePath, current.VerifiedFilesJson, next.Season, next.Episode);
        if (current is not null && inPackPath is not null)
        {
            return PrewarmHttp.Json(new
            {
                ok = true,
                next = new
                {
                    title = next.Title,
                    label,
                    season = next.Season,
                    episode = next.Episode,
                    availability = "ready",
                    infoHash = current.Hash,
                    filePath = inPackPath,
                    progress = Math.Clamp(current.Progress, 0, 1),
                    source = next.Source,
                },
            });
        }

        var targetName = ReleaseText.NormalizeTitle(next.Title);
        var heldRows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && t.Status != "removed")
            .OrderByDescending(t => t.UpdatedAt).Take(100).ToListAsync(ct);
        // A durable acquisition target is the user's exact intent; prefer it over a speculative pre-rank torrent.
        var sourceWorkKey = await db.AcquisitionTargets.AsNoTracking().Where(a => a.UserId == userId && a.InfoHash == infoHash)
            .OrderByDescending(a => a.UpdatedAt).Select(a => a.WorkKey).FirstOrDefaultAsync(ct);
        var intended = sourceWorkKey is null ? null : await db.AcquisitionTargets.AsNoTracking()
            .Where(a => a.UserId == userId && a.WorkKey == sourceWorkKey && a.Scope == "episode" && a.Season == next.Season && a.Episode == next.Episode
                && a.InfoHash != null && a.Status != "failed")
            .OrderByDescending(a => a.UpdatedAt).Select(a => new { a.InfoHash, a.FilePath }).FirstOrDefaultAsync(ct);
        var acquired = intended?.InfoHash is { } intendedHash ? heldRows.FirstOrDefault(r => r.Hash == intendedHash) : null;
        var ranked = await ranker.GetPreRankedAsync(new PreRankTarget { Title = next.Title, MediaType = next.MediaType, Season = next.Season, Episode = next.Episode }, ct);
        var rankedHash = ranked?.Candidate is { } candidate ? ReleaseText.ReleaseInfoHash(candidate) : null;
        var exact = rankedHash is null ? null : heldRows.FirstOrDefault(r => r.Hash == rankedHash);
        var byEpisode = acquired ?? exact ?? heldRows.FirstOrDefault(r =>
        {
            var ep = ReleaseText.ParseEpisode(r.Name);
            if (ep.Season != next.Season || ep.Episode != next.Episode) return false;
            return ReleaseText.NormalizeTitle(ReleaseText.WorkName(r.Name)) == targetName;
        });

        double? progress = byEpisode is null ? null : Math.Clamp(byEpisode.Progress, 0, 1);
        var availability = byEpisode is null ? "not-fetched" : progress >= 1 ? "ready" : "downloading";
        var matchedPath = byEpisode is null ? null
            : acquired is not null && !string.IsNullOrEmpty(intended?.FilePath) ? intended.FilePath
            : NextEpisodeFile.EpisodeFileInTorrent(byEpisode.SavePath, byEpisode.VerifiedFilesJson, next.Season, next.Episode);

        return PrewarmHttp.Json(new
        {
            ok = true,
            next = new
            {
                title = next.Title,
                label,
                season = next.Season,
                episode = next.Episode,
                availability,
                infoHash = byEpisode?.Hash,
                filePath = matchedPath,
                progress,
                source = next.Source,
            },
        });
    }

    private async Task<IActionResult> TriggerAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var next = PrewarmHttp.Prop(body, "next");
        var title = next is { } n ? PrewarmHttp.Str(n, "title") : null;
        var season = next is { } n2 ? PrewarmHttp.Num(n2, "season") : null;
        var episode = next is { } n3 ? PrewarmHttp.Num(n3, "episode") : null;
        if (next is not { ValueKind: JsonValueKind.Object } nextObj || title is null || title.Trim().Length == 0 || season is null || episode is null)
            return PrewarmHttp.Json(new { error = "next requires title, season and episode" }, 400);

        List<string>? protect = null;
        if (PrewarmHttp.Prop(body, "protectHashes") is { ValueKind: JsonValueKind.Array } list)
            protect = list.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList();

        var outcome = await prewarm.PrewarmNextEpisodeAsync(new PrewarmService.RunOptions
        {
            UserId = userId,
            Next = new NextEpisode
            {
                Title = title,
                MediaType = PrewarmHttp.Str(nextObj, "mediaType"),
                Season = (int)season.Value,
                Episode = (int)episode.Value,
                WatchListItemId = PrewarmHttp.Str(nextObj, "watchListItemId"),
                Source = PrewarmHttp.Str(nextObj, "source") == "hunt-cursor" ? "hunt-cursor" : "playing-episode",
            },
            ProtectHashes = protect,
            Force = PrewarmHttp.Truthy(body, "force"),
        }, ct);
        return PrewarmHttp.Json(new { ok = true, outcome });
    }

    private async Task<IActionResult> ProgressAsync(string userId, JsonElement body, CancellationToken ct)
    {
        var infoHash = PrewarmHttp.Str(body, "infoHash");
        var title = PrewarmHttp.Str(body, "title");
        if (infoHash is null || title is null) return PrewarmHttp.Json(new { error = "infoHash and title are required" }, 400);
        var outcome = await prewarm.OnPlaybackProgressAsync(new PrewarmService.PlaybackContext
        {
            UserId = userId,
            InfoHash = infoHash,
            Title = title,
            Season = PrewarmHttp.Num(body, "season"),
            Episode = PrewarmHttp.Num(body, "episode"),
            WatchListItemId = PrewarmHttp.Str(body, "watchListItemId"),
            PositionSec = PrewarmHttp.JsNumber(body, "positionSec"),
            DurationSec = PrewarmHttp.JsNumber(body, "durationSec"),
        }, ct: ct);
        return PrewarmHttp.Json(new { ok = true, outcome });
    }
}
