using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/settings/client")]
public sealed class SettingsClientController(
    TorrentFlowDbContext db,
    ClientSettingsStore store,
    SecretProtector secrets,
    StorageBudget storage,
    ITorrentEngine engine,
    ExternalClientRegistry clients) : ControllerBase
{
    internal static readonly int[] SelectableResolutions = [480, 720, 1080, 2160];
    internal const int DefaultResolution = 1080;
    internal static readonly int[] AutomationIntervals = [0, 30, 120, 360];

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var row = await store.EnsureAsync(db, ct);
        return Ok(new { settings = await PublicSettingsAsync(row, ct), defaults = Defaults() });
    }

    internal static object Defaults() => new
    {
        categories = ClientSettingsStore.DefaultCategories,
        baseDownloadPath = ClientSettingsStore.DefaultDownloadDir(),
        clientType = "builtin",
    };

    internal async Task<Dictionary<string, object?>> PublicSettingsAsync(ClientSetting s, CancellationToken ct)
    {
        var config = ClientSettingsStore.ToConfig(s);
        var cap = config.MaxStorageBytes;
        var hasFolder = config.DownloadRoot is not null;
        return new Dictionary<string, object?>
        {
            ["clientType"] = s.ClientType,
            ["externalClientType"] = config.ExternalClientType,
            ["host"] = s.Host,
            ["username"] = s.Username,
            ["hasPassword"] = config.HasPassword,
            ["category"] = s.Category,
            ["savePath"] = s.SavePath,
            ["baseDownloadPath"] = s.BaseDownloadPath,
            ["maxStorageBytes"] = cap,
            ["maxStorageGb"] = cap is { } c ? Math.Round(c / 1e9 * 10) / 10 : 0,
            ["storageCapConfigured"] = cap is not null,
            ["setupComplete"] = hasFolder && cap is > 0,
            ["verboseDiagnostics"] = s.VerboseDiagnostics == true,
            ["preferredResolution"] = s.PreferredResolution is { } r && SelectableResolutions.Contains(r) ? r : DefaultResolution,
            ["automationIntervalMinutes"] = s.AutomationIntervalMinutes is { } m && AutomationIntervals.Contains(m) ? m : 0,
            ["categories"] = config.Categories,
            ["pathRules"] = config.PathRules,
            ["pathWarnings"] = PathWarnings(config),
            ["hasExternal"] = config.ExternalClientType is not null,
            ["defaultRetentionPolicy"] = string.IsNullOrEmpty(s.DefaultRetentionPolicy) ? "EPHEMERAL" : s.DefaultRetentionPolicy,
            ["defaultRetentionPolicyPersisted"] = !string.IsNullOrEmpty(s.DefaultRetentionPolicy),
            ["storageUsage"] = await StorageUsageAsync(config, ct),
        };
    }

    private static List<object> PathWarnings(ClientConfig config)
    {
        var list = new List<object>();
        void Check(string field, string? path, string? category = null)
        {
            if (string.IsNullOrWhiteSpace(path) || Path.IsPathFullyQualified(path)) return;
            list.Add(new { field, category, path, reasons = new[] { "relative" }, message = $"\"{path}\" is not an absolute path." });
        }
        Check("baseDownloadPath", config.BaseDownloadPath);
        Check("savePath", config.SavePath);
        foreach (var (cat, p) in config.PathRules) Check("pathRule", p, cat);
        return list;
    }

    /// <summary>Reduced RetentionStorageUsage: totals by retention plus the measured folder size.</summary>
    private async Task<object?> StorageUsageAsync(ClientConfig config, CancellationToken ct)
    {
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
        long Bytes(IEnumerable<EngineTorrent> rs) => rs.Sum(r => (long)(Math.Max(0, r.SizeBytes) * Math.Clamp(r.Progress, 0, 1)));
        var kept = Bytes(rows.Where(r => r.Origin == TorrentOrigin.User));
        var ephemeral = Bytes(rows.Where(r => r.Origin is TorrentOrigin.Stream or TorrentOrigin.Prewarm));
        long? disk = null;
        if (config.DownloadRoot is { } root) disk = storage.DirectorySize(root).Bytes;
        return new
        {
            totalBytes = kept + ephemeral,
            ephemeralBytes = ephemeral,
            keptBytes = kept,
            indeterminateBytes = 0,
            budgetBytes = config.MaxStorageBytes is { } cap ? cap / 4 : (long?)null,
            graceMs = (long)RetentionSweeper.Grace.TotalMilliseconds,
            items = Array.Empty<object>(),
            diskBytes = disk,
            orphanBytes = disk is { } d ? Math.Max(0, d - kept - ephemeral) : 0,
            orphans = Array.Empty<object>(),
            disk = config.DownloadRoot is { } r2 ? new { root = r2, status = "complete", authoritative = true } : null,
            queuedBytes = await engine.QueuedReservedBytesAsync(ct),
        };
    }

    [HttpPut]
    public async Task<IActionResult> Put(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        IActionResult Bad(string reason) => BadRequest(new { ok = false, error = reason, message = reason });

        var row = await store.EnsureAsync(db, ct);

        if (body.Bool("switchToBuiltin") == true)
        {
            if (row.ClientType is "qbittorrent" or "transmission") row.ExternalClientType = row.ClientType;
            row.ClientType = "builtin";
            row.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Ok(new
            {
                settings = await PublicSettingsAsync(row, ct),
                message = "Switched to built-in engine. External client kept for optional Send to my client.",
            });
        }

        if (body.Str("clientType") is { } clientType)
        {
            if (clientType is not ("builtin" or "qbittorrent" or "transmission")) return Bad("clientType must be builtin, qbittorrent or transmission");
            row.ClientType = clientType;
        }
        if (body.Has("externalClientType"))
        {
            var ext = body.Str("externalClientType");
            if (ext is not (null or "" or "qbittorrent" or "transmission")) return Bad("externalClientType must be qbittorrent or transmission");
            row.ExternalClientType = string.IsNullOrEmpty(ext) ? null : ext;
        }
        if (row.ClientType is "qbittorrent" or "transmission")
            row.ExternalClientType = row.ClientType;
        if (body.Str("host") is { } host)
        {
            if (!Uri.TryCreate(host.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
                return Bad("host must be an http(s) URL");
            row.Host = host.Trim();
        }
        if (body.Has("username")) row.Username = NullIfBlank(body.Str("username"));
        if (body.Str("password") is { Length: > 0 } password)
        {
            if (password.Length > 4096) return Bad("password is too long");
            row.Password = secrets.Encrypt(password);
        }

        foreach (var field in new[] { "category", "savePath", "baseDownloadPath" })
        {
            if (!body.Has(field)) continue;
            var value = body.Str(field);
            if (value?.Contains('\0') == true) return Bad($"{field} contains an invalid null character");
            value = NullIfBlank(value);
            if (field == "category") row.Category = value;
            else if (field == "savePath") row.SavePath = value;
            else row.BaseDownloadPath = value;
        }

        var hasGb = body.Has("maxStorageGb");
        var hasBytes = body.Has("maxStorageBytes");
        if (hasGb && hasBytes) return BadRequest(new { error = "Provide maxStorageGb or maxStorageBytes, not both" });
        if (hasGb || hasBytes)
        {
            var field = hasGb ? "maxStorageGb" : "maxStorageBytes";
            if (body.IsNull(field) || body.Str(field) == "")
            {
                row.MaxStorageBytes = null;
                row.StorageCapConfigured = false;
            }
            else
            {
                var n = body.Num(field) ?? (double.TryParse(body.Str(field), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var p) ? p : double.NaN);
                if (!double.IsFinite(n) || n < 0) return Bad($"{field} must be a non-negative number");
                var bytes = hasGb ? Math.Round(n * 1e9) : n;
                if (!hasGb && bytes != Math.Floor(bytes)) return Bad("maxStorageBytes must be an integer");
                if (bytes > long.MaxValue) return Bad($"{field} is too large");
                row.MaxStorageBytes = bytes > 0 ? (long)bytes : null;
                row.StorageCapConfigured = bytes > 0;
            }
            storage.ResetDirectorySizeCache();
        }

        if (body.Bool("verboseDiagnostics") is { } verbose) row.VerboseDiagnostics = verbose;
        if (body.Has("preferredResolution"))
        {
            var r = body.Num("preferredResolution");
            if (r is null || !SelectableResolutions.Contains((int)r)) return Bad("preferredResolution must be one of 480, 720, 1080, 2160");
            row.PreferredResolution = (int)r;
        }
        if (body.Has("automationIntervalMinutes"))
        {
            var m = body.Num("automationIntervalMinutes");
            if (m is null || !AutomationIntervals.Contains((int)m)) return Bad("automationIntervalMinutes must be 0, 30, 120 or 360");
            row.AutomationIntervalMinutes = (int)m;
        }
        if (body.TryGetProperty("categories", out var cats))
        {
            if (cats.ValueKind != JsonValueKind.Array) return Bad("categories must be an array");
            var list = cats.EnumerateArray().Where(c => c.ValueKind == JsonValueKind.String).Select(c => c.GetString()!.Trim()).Where(c => c.Length > 0).Distinct().ToList();
            if (list.Count > 64) return Bad("At most 64 categories");
            row.Categories = JsonSerializer.Serialize(list);
        }
        if (body.TryGetProperty("pathRules", out var rules))
        {
            if (rules.ValueKind == JsonValueKind.Null) row.PathRules = null;
            else if (rules.ValueKind != JsonValueKind.Object) return Bad("pathRules must be an object");
            else
            {
                var map = new Dictionary<string, string>();
                foreach (var p in rules.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.String) continue;
                    var path = p.Value.GetString()!.Trim();
                    if (path.Contains('\0')) return Bad("pathRules contains an invalid null character");
                    if (path.Length > 0) map[p.Name] = path;
                }
                if (map.Count > 64) return Bad("At most 64 path rules");
                row.PathRules = map.Count > 0 ? JsonSerializer.Serialize(map) : null;
            }
        }
        if (body.Str("defaultRetentionPolicy") is { Length: > 0 } policy) row.DefaultRetentionPolicy = policy;

        row.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        object? testResult = null;
        if (body.Bool("test") == true)
        {
            var config = await clients.GetConfigAsync(ct);
            var type = body.Str("testTarget") == "external" && config.ExternalClientType is { } external && !string.IsNullOrWhiteSpace(config.Host)
                ? external : config.ClientType;
            testResult = type == "builtin"
                ? new EngineActionResult(true, "Built-in engine is running.")
                : await clients.Get(type).TestAsync(config with { ClientType = type }, ct);
        }

        return Ok(new Dictionary<string, object?>
        {
            ["settings"] = await PublicSettingsAsync(row, ct),
            ["testResult"] = testResult,
            ["retentionWarning"] = null,
        });
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
