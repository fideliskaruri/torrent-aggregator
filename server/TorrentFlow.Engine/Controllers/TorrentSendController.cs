using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/torrent/send")]
public sealed class TorrentSendController(
    ITorrentEngine engine,
    ClientSettingsStore settings,
    StorageBudget storage,
    TorrentFlowDbContext db) : ControllerBase
{
    private static readonly (string Field, int Max)[] StringLimits =
        [("magnet", 8192), ("torrentUrl", 2048), ("name", 500), ("source", 100), ("infoHash", 64), ("searchCategory", 100),
         ("category", 100), ("savePath", 4096), ("watchListItemId", 128), ("queueKey", 64), ("workId", 128)];

    [HttpPost]
    public async Task<IActionResult> Send(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();

        foreach (var (field, max) in StringLimits)
        {
            if (!body.IsKind(field, JsonValueKind.String, JsonValueKind.Null)) return BadRequest(new { error = $"{field} must be a string" });
            if (body.Str(field) is { } v && v.Length > max) return BadRequest(new { error = $"{field} must be at most {max} characters" });
        }

        var magnet = body.Str("magnet")?.Trim();
        var torrentUrl = body.Str("torrentUrl")?.Trim();
        var infoHashRaw = body.Str("infoHash")?.Trim();
        var retention = body.Str("retention");
        var scope = body.Str("scope");
        var target = body.Str("target") ?? "primary";
        var savePathOverride = body.Str("savePath");

        if (!string.IsNullOrEmpty(magnet) && TorrentSource.HashFromMagnet(magnet) is null)
            return BadRequest(new { error = "magnet must contain a valid BitTorrent info hash" });
        string? infoHash = null;
        if (!string.IsNullOrEmpty(infoHashRaw))
        {
            infoHash = TorrentSource.NormalizeInfoHash(infoHashRaw);
            if (infoHash is null) return BadRequest(new { error = "infoHash must be a 40-character hex or 32-character base32 hash" });
        }
        if (!string.IsNullOrEmpty(torrentUrl))
        {
            if (!Uri.TryCreate(torrentUrl, UriKind.Absolute, out var uri)) return BadRequest(new { error = "torrentUrl must be a valid URL" });
            if (uri.Scheme is not ("http" or "https")) return BadRequest(new { error = "torrentUrl must use http or https" });
        }
        if (savePathOverride is not null && (savePathOverride.Contains('\0')
            || savePathOverride.Replace('\\', '/').Split('/').Any(seg => seg == "..")))
            return BadRequest(new { error = "savePath may not contain null bytes or traversal segments" });
        if (target is not ("primary" or "external")) return BadRequest(new { error = "target must be primary or external" });

        var config = await settings.GetConfigAsync(ct);
        if (target == "external" || config.ClientType != "builtin")
        {
            if (config.ExternalClientType is null && target == "external")
                return BadRequest(new { ok = false, offline = false, error = "No external client", message = "Configure an external torrent client in Settings first." });
            return StatusCode(503, new { ok = false, offline = true, error = "Client offline", message = "Cannot reach external torrent client. Check Host URL in Settings, or use built-in Send." });
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
