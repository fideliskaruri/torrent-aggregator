using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/torrent/send")]
public sealed class TorrentSendController(
    ITorrentEngine engine,
    ClientSettingsStore settings,
    StorageBudget storage,
    TorrentFlowDbContext db,
    ExternalClientRegistry clients) : ControllerBase
{
    private static readonly (string Field, int Max)[] StringLimits =
        [("magnet", 8192), ("torrentUrl", 2048), ("name", 500), ("source", 100), ("infoHash", 64), ("searchCategory", 100),
         ("category", 100), ("savePath", 4096), ("watchListItemId", 128), ("queueKey", 64), ("workId", 128)];

    private static readonly (string Field, string[] Allowed)[] EnumFields =
        [("target", ["primary", "external"]), ("retention", ["stream", "keep"]), ("scope", ["title", "season", "episode"])];

    /// <summary>requestFailureResponse: a 400 naming the offending field, as the SPA highlights it.</summary>
    private BadRequestObjectResult Invalid(string error, string field) => BadRequest(new { error, field });

    [HttpPost]
    public async Task<IActionResult> Send(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();

        foreach (var (field, max) in StringLimits)
        {
            if (!body.IsKind(field, JsonValueKind.String, JsonValueKind.Null)) return Invalid($"{field} must be a string", field);
            if (body.Str(field) is { } v && v.Length > max) return Invalid($"{field} must be at most {max} characters", field);
        }
        foreach (var (field, allowed) in EnumFields)
        {
            if (!body.IsKind(field, JsonValueKind.String, JsonValueKind.Null)) return Invalid($"{field} must be a string", field);
            if (body.Str(field) is { } v && !allowed.Contains(v)) return Invalid($"{field} must be one of: {string.Join(", ", allowed)}", field);
        }

        var magnet = body.Str("magnet")?.Trim();
        var torrentUrl = body.Str("torrentUrl")?.Trim();
        var infoHashRaw = body.Str("infoHash")?.Trim();
        var retention = body.Str("retention");
        var scope = body.Str("scope");
        var target = body.Str("target") ?? "primary";
        var savePathOverride = body.Str("savePath");

        if (!string.IsNullOrEmpty(magnet) && TorrentSource.HashFromMagnet(magnet) is null)
            return Invalid("magnet must contain a valid BitTorrent info hash", "magnet");
        string? infoHash = null;
        if (!string.IsNullOrEmpty(infoHashRaw))
        {
            infoHash = TorrentSource.NormalizeInfoHash(infoHashRaw);
            if (infoHash is null) return Invalid("infoHash must be a 40-character hex or 32-character base32 hash", "infoHash");
        }
        if (!string.IsNullOrEmpty(torrentUrl))
        {
            if (!Uri.TryCreate(torrentUrl, UriKind.Absolute, out var uri)) return Invalid("torrentUrl must be a valid URL", "torrentUrl");
            if (uri.Scheme is not ("http" or "https")) return Invalid("torrentUrl must use http or https", "torrentUrl");
        }
        if (savePathOverride is not null && (savePathOverride.Contains('\0')
            || savePathOverride.Replace('\\', '/').Split('/').Any(seg => seg == "..")))
            return Invalid("savePath may not contain null bytes or traversal segments", "savePath");

        var config = await settings.GetConfigAsync(ct);
        if (target == "external" || config.ClientType != "builtin")
        {
            if ((config.ExternalClientType is null || string.IsNullOrWhiteSpace(config.Host)) && target == "external")
                return BadRequest(new { ok = false, offline = false, error = "No external client", message = "Configure an external torrent client in Settings first." });
            return await SendExternalAsync(body, target, magnet, torrentUrl, infoHash, retention, ct);
        }

        var hasSource = !string.IsNullOrEmpty(magnet) || !string.IsNullOrEmpty(torrentUrl);
        if (!hasSource && infoHash is not null && retention is "keep" or "stream")
        {
            if (scope is "episode" or "season")
                return BadRequest(new { ok = false, message = "Episode and season acquisitions must use their scoped title endpoint." });
            return await RetentionOnlyAsync(infoHash, retention!, ct);
        }
        if (!hasSource) return BadRequest(new { error = "magnet or torrentUrl is required (or infoHash with retention)" });

        var category = body.Str("category") ?? body.Str("searchCategory");
        var resolved = ClientSettingsStore.ResolveDownloadTarget(config, category, savePathOverride);
        var purpose = retention == "stream" ? TorrentPurpose.Stream : TorrentPurpose.Keep;
        var overrideCap = body.Bool("overrideStorageCap") ?? false;
        var expected = body.Num("expectedSizeBytes") is { } n && n > 0 ? (long)n : (long?)null;
        var targetJson = new { category = resolved.Category, savePath = resolved.SavePath };

        var check = storage.Check(config.DownloadRoot, config.MaxStorageBytes, expected, await engine.QueuedReservedBytesAsync(ct), overrideCap);
        if (!check.Ok && (purpose == TorrentPurpose.Keep || !check.Overridable))
            return StatusCode(507, new
            {
                ok = false, offline = false, error = "Storage limit", message = check.Message, clientType = "builtin", target = targetJson,
                storage = new
                {
                    limit = check.Limit, overridable = check.Overridable, usedBytes = check.UsedBytes, freeBytes = check.FreeBytes,
                    maxStorageBytes = check.MaxStorageBytes, incomingBytes = check.IncomingBytes, incomingEstimated = check.IncomingEstimated,
                    reservedQueuedBytes = check.ReservedQueuedBytes,
                },
            });

        var result = await engine.AddAsync(new EngineAddRequest
        {
            Magnet = magnet,
            TorrentUrl = torrentUrl,
            InfoHash = infoHash,
            Name = body.Str("name"),
            Purpose = purpose,
            Category = resolved.Category,
            SavePath = resolved.SavePath,
            QueueKey = body.Str("queueKey"),
            WorkId = body.Str("workId"),
            ExpectedSizeBytes = expected,
            Forced = body.Bool("forced") ?? false,
            OverrideStorageCap = overrideCap,
        }, ct);

        var smart = new
        {
            kind = (resolved.Category ?? "other").ToLowerInvariant(),
            category = resolved.Category ?? "Other",
            confidence = body.Bool("categoryManual") == true ? "high" : body.Str("searchCategory") is not null ? "medium" : "low",
        };
        if (!result.Ok)
            return StatusCode(502, new { ok = false, message = result.Message, offline = false, code = result.StorageLimit is null ? "SEND_FAILED" : "STORAGE_LIMIT",
                clientType = "builtin", sendTarget = target, target = targetJson, smart });

        return Ok(new
        {
            ok = true, message = result.Message, offline = false, clientType = "builtin", sendTarget = target, target = targetJson, smart,
            retentionState = purpose == TorrentPurpose.Stream ? "stream" : "kept", streamDegraded = false,
            hash = result.Hash, details = result.Details,
        });
    }

    private async Task<IActionResult> SendExternalAsync(JsonElement body, string target, string? magnet, string? torrentUrl,
        string? infoHash, string? retention, CancellationToken ct)
    {
        var config = await clients.GetConfigAsync(ct);
        if (target == "external") config = config with { ClientType = config.ExternalClientType! };
        if (string.IsNullOrEmpty(magnet) && string.IsNullOrEmpty(torrentUrl))
        {
            if (infoHash is not null && retention is "keep" or "stream")
            {
                if (body.Str("scope") is "episode" or "season")
                    return BadRequest(new { ok = false, message = "Episode and season acquisitions must use their scoped title endpoint." });
                var existing = await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.Hash == infoHash, ct);
                var state = existing?.Origin switch { TorrentOrigin.User => "kept", TorrentOrigin.Stream => "stream", TorrentOrigin.Prewarm => "prewarm", _ => "unknown" };
                return Ok(new { ok = true, message = retention == "keep" ? "Kept in your library." : "Marked stream-only.", clientType = config.ClientType, sendTarget = target, retentionState = state });
            }
            return BadRequest(new { error = "magnet or torrentUrl is required (or infoHash with retention)" });
        }
        var category = body.Str("category") ?? body.Str("searchCategory");
        var resolved = ClientSettingsStore.ResolveDownloadTarget(config, category, body.Str("savePath"));
        var hash = infoHash ?? (magnet is null ? null : TorrentSource.HashFromMagnet(magnet));
        var existingTransfer = hash is null ? null : await db.EngineTorrents.AsNoTracking()
            .FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.Hash.ToLower() == hash, ct);
        var watchId = body.Str("watchListItemId");
        var watch = string.IsNullOrEmpty(watchId) ? null : await db.WatchListItems.AsNoTracking()
            .FirstOrDefaultAsync(t => t.UserId == LocalUser.Id && t.Id == watchId, ct);
        if (retention is null)
        {
            var saved = await settings.EnsureAsync(db, ct);
            retention = existingTransfer?.Origin == TorrentOrigin.User || !string.IsNullOrEmpty(watchId) || saved.DefaultRetentionPolicy == "KEPT"
                ? "keep" : "stream";
        }
        var purpose = retention == "stream" && string.IsNullOrEmpty(watchId) ? TorrentPurpose.Stream : TorrentPurpose.Keep;
        var history = new DownloadHistory
        {
            Id = Ids.New(), UserId = LocalUser.Id, CreatedAt = DateTime.UtcNow, Title = body.Str("name") ?? "Unknown",
            Magnet = magnet, TorrentUrl = torrentUrl, InfoHash = infoHash, Source = body.Str("source"),
            WorkId = watch?.WorkId ?? existingTransfer?.WorkId, Retention = "keep", Status = "failed",
        };
        var check = storage.Check(config.DownloadRoot ?? resolved.SavePath, config.MaxStorageBytes, null,
            await engine.QueuedReservedBytesAsync(ct), body.Bool("overrideStorageCap") ?? false);
        if (!check.Ok)
        {
            history.Message = check.Message;
            db.DownloadHistories.Add(history);
            await db.SaveChangesAsync(ct);
            return StatusCode(507, new
            {
                ok = false, offline = false, error = "Storage limit", message = check.Message, clientType = config.ClientType,
                target = new Dictionary<string, object?> { ["category"] = resolved.Category, ["savePath"] = resolved.SavePath },
                storage = new
                {
                    limit = check.Limit, overridable = check.Overridable, usedBytes = check.UsedBytes, freeBytes = check.FreeBytes,
                    maxStorageBytes = check.MaxStorageBytes, incomingBytes = check.IncomingBytes, incomingEstimated = check.IncomingEstimated,
                    reservedQueuedBytes = check.ReservedQueuedBytes,
                },
            });
        }
        var result = await clients.Get(config.ClientType).AddAsync(config, new EngineAddRequest
        {
            Magnet = magnet, TorrentUrl = torrentUrl, Name = body.Str("name"), Purpose = purpose,
            Category = resolved.Category, SavePath = resolved.SavePath,
        }, ct);
        history.Status = result.Ok ? "sent" : "failed";
        history.Message = result.Message;
        history.Category = resolved.Category;
        history.SavePath = resolved.SavePath;
        history.ClientType = config.ClientType;
        history.SendKind = (resolved.Category ?? "other").ToLowerInvariant();
        db.DownloadHistories.Add(history);
        await db.SaveChangesAsync(ct);
        if (result.Ok) storage.ResetDirectorySizeCache();
        var offline = !result.Ok && ExternalClientErrors.IsOffline(result.Message);
        return StatusCode(result.Ok ? 200 : offline ? 503 : 502, new
        {
            ok = result.Ok, message = result.Message, offline, clientType = config.ClientType, sendTarget = target,
            target = new Dictionary<string, object?> { ["category"] = resolved.Category, ["savePath"] = resolved.SavePath },
            smart = new
            {
                kind = (resolved.Category ?? "other").ToLowerInvariant(), category = resolved.Category ?? "Other",
                confidence = body.Bool("categoryManual") == true ? "high" : body.Str("searchCategory") is not null ? "medium" : "low",
            },
            retentionState = existingTransfer?.Origin switch
            {
                TorrentOrigin.User => "kept", TorrentOrigin.Stream => "stream", TorrentOrigin.Prewarm => "prewarm",
                _ => purpose == TorrentPurpose.Stream ? "stream" : "kept",
            },
            streamDegraded = purpose == TorrentPurpose.Stream,
        });
    }

    /// <summary>Changes only the retention of an existing transfer (Keep / Stream-only), never adding anything.</summary>
    private async Task<IActionResult> RetentionOnlyAsync(string hash, string retention, CancellationToken ct)
    {
        var row = await db.EngineTorrents.FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct);
        if (row is not null)
        {
            row.Origin = retention == "keep" ? TorrentOrigin.User : row.Origin == TorrentOrigin.User ? TorrentOrigin.Stream : row.Origin;
            row.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        return Ok(new
        {
            ok = true,
            message = retention == "keep" ? "Kept in your library." : "Marked stream-only.",
            clientType = "builtin",
            sendTarget = "primary",
            retentionState = retention == "keep" ? "kept" : "stream",
        });
    }
}
